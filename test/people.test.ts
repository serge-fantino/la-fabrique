import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, grantRole, logActions, post, signIn } from "./helpers";

async function account(login: string) {
  return env.DB.prepare("SELECT role FROM accounts WHERE github_login = ?").bind(login).first<{ role: string }>();
}

describe("People page", () => {
  it("redirects anonymous visitors to the home page", async () => {
    const response = await get("/people");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("is reserved to super admins", async () => {
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");

    expect((await get("/people", cookie)).status).toBe(403);
    const write = await post("/people", { csrf, action: "add", login: "someone", role: "tester" }, cookie);
    expect(write.status).toBe(403);
    expect(await account("someone")).toBeNull();
  });

  it("lets a super admin grant, change and remove a role, each change logged", async () => {
    const { cookie, csrf } = await signIn("admin-one");

    const added = await post("/people", { csrf, action: "add", login: "@New-Tester", role: "tester" }, cookie);
    expect(added.headers.get("location")).toBe("/people?notice=added");
    expect(await account("new-tester")).toEqual({ role: "tester" });

    await post("/people", { csrf, action: "update", login: "new-tester", role: "tech_lead" }, cookie);
    expect(await account("new-tester")).toEqual({ role: "tech_lead" });

    await post("/people", { csrf, action: "remove", login: "new-tester" }, cookie);
    expect(await account("new-tester")).toBeNull();

    expect(await logActions()).toEqual([
      { actor: "admin-one", action: "account_added", details: JSON.stringify({ login: "new-tester", role: "tester" }) },
      {
        actor: "admin-one",
        action: "account_role_changed",
        details: JSON.stringify({ login: "new-tester", role: "tech_lead", previous_role: "tester" }),
      },
      {
        actor: "admin-one",
        action: "account_removed",
        details: JSON.stringify({ login: "new-tester", previous_role: "tech_lead" }),
      },
    ]);

    const page = await (await get("/people", cookie)).text();
    expect(page).toContain("@admin-one</span> added <span class=\"mono\">@new-tester</span> (Tester)");
  });

  it("refuses a write without a valid CSRF token", async () => {
    const { cookie } = await signIn("admin-one");

    const missing = await post("/people", { action: "add", login: "intruder", role: "super_admin" }, cookie);
    expect(missing.status).toBe(403);
    const wrong = await post("/people", { csrf: "nope", action: "add", login: "intruder", role: "super_admin" }, cookie);
    expect(wrong.status).toBe(403);

    expect(await account("intruder")).toBeNull();
    expect(await logActions()).toEqual([]);
  });

  it("refuses a cross-origin write even with a token", async () => {
    const { cookie, csrf } = await signIn("admin-one");
    const response = await SELF.fetch("https://la-fabrique.test/people", {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, action: "add", login: "intruder", role: "tester" }).toString(),
    });
    expect(response.status).toBe(403);
    expect(await account("intruder")).toBeNull();
  });

  it("rejects invalid logins and roles, and protects configured super admins", async () => {
    const { cookie, csrf } = await signIn("admin-one");

    const badLogin = await post("/people", { csrf, action: "add", login: "-bad--login", role: "tester" }, cookie);
    expect(badLogin.headers.get("location")).toBe("/people?notice=invalid_login");
    const badRole = await post("/people", { csrf, action: "add", login: "fine", role: "owner" }, cookie);
    expect(badRole.headers.get("location")).toBe("/people?notice=invalid_role");
    const configured = await post("/people", { csrf, action: "add", login: "admin-two", role: "tester" }, cookie);
    expect(configured.headers.get("location")).toBe("/people?notice=configured");
  });

  it("lists access requests so the super admin can grant them", async () => {
    await env.DB.prepare("INSERT INTO activity_log (actor, action) VALUES ('stranger', 'access_requested')").run();
    const { cookie } = await signIn("admin-one");
    const page = await (await get("/people", cookie)).text();
    expect(page).toContain("Access requests");
    expect(page).toContain("@stranger");
  });

  it("escapes values rendered in the page", async () => {
    await env.DB.prepare("INSERT INTO activity_log (actor, action) VALUES ('<b>x</b>', 'access_requested')").run();
    const { cookie } = await signIn("admin-one");
    const page = await (await get("/people", cookie)).text();
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("Sessions", () => {
  it("ends access as soon as the role is removed", async () => {
    await grantRole("leaving", "tester");
    const { cookie } = await signIn("leaving");
    expect((await (await get("/", cookie)).text())).toContain("@leaving");

    await env.DB.prepare("DELETE FROM accounts WHERE github_login = 'leaving'").run();
    const response = await get("/", cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/no-access");
  });

  it("signs out only with the CSRF token", async () => {
    await grantRole("someone", "tester");
    const { cookie, csrf } = await signIn("someone");

    expect((await post("/auth/logout", {}, cookie)).status).toBe(403);
    const out = await post("/auth/logout", { csrf }, cookie);
    expect(out.status).toBe(303);
    expect((await (await get("/", cookie)).text())).toContain("Sign in with GitHub");
  });
});
