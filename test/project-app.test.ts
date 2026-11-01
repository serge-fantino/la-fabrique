import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";
import { addProject, CONFIG, connect, LOCAL_RETURN, me, registerApp, REPO, RETURN, token } from "./oauth-helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

// The project says where its app comes back: La Fabrique fills in the
// return addresses.
const DECLARED = { ...CONFIG, application: { nom: "Widget app", retour: "/auth/fabrique/retour", local: "http://localhost:8787" } };

async function setup(login = "admin-one"): Promise<string> {
  await env.DB.prepare("INSERT OR REPLACE INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)")
    .bind(REPO, new Date().toISOString())
    .run();
  return (await get(`/projects/${REPO}/setup`, (await signIn(login)).cookie)).text();
}

describe("The project's app, in Setup", () => {
  it("offers the super admin to register it, with the return addresses of .fabrique.json", async () => {
    await addProject(DECLARED);
    const page = await setup();
    expect(page).toContain('id="connected-app"');
    expect(page).toContain("No app is registered for this project.");
    expect(page).toContain('value="Widget app"');
    expect(page).toContain(`${RETURN}\n${LOCAL_RETURN}</textarea>`);
    expect(page).toContain("Reports open on `int`, but no app is registered.".replace(/`([^`]+)`/g, "<code>$1</code>"));
    expect(page).toContain(`<code>FABRIQUE_URL</code> = <code>${BASE}</code>`);
    expect(page).toContain("npx wrangler secret put FABRIQUE_CLIENT_SECRET --env int");
  });

  it("is registered by the super admin only", async () => {
    await addProject(DECLARED);
    await grantRole("lead", "tech_lead");
    const page = await setup("lead");
    expect(page).toContain("A super admin registers it here.");
    const { cookie, csrf } = await signIn("lead");
    const refused = await post(`/projects/${REPO}/app`, { csrf, action: "register", name: "X", redirect_uris: RETURN }, cookie);
    expect(refused.status).toBe(403);
  });

  it("shows the secret once with what to put in the project, then the app without it", async () => {
    await addProject(DECLARED);
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/app`, { csrf, action: "register", name: "Widget app", redirect_uris: `${RETURN}\n${LOCAL_RETURN}` }, cookie);
    const created = await response.text();
    const clientId = /<dt>client_id<\/dt><dd><code>([^<]+)<\/code>/.exec(created)?.[1] ?? "";
    const secret = /<dt>client_secret<\/dt><dd><code>([^<]+)<\/code>/.exec(created)?.[1] ?? "";
    expect(secret).not.toBe("");
    expect(created).toContain(`npx wrangler secret put FABRIQUE_CLIENT_ID --env int   # ${clientId}`);
    expect(created).toContain("npx wrangler secret put FABRIQUE_CLIENT_SECRET --env int");

    const page = await setup();
    expect(page).toContain(`<code>${clientId}</code>`);
    expect(page).not.toContain(secret);
    expect(page).toContain("Nobody has connected it yet");
    expect(page).not.toContain("The return addresses differ");
    expect(JSON.stringify(await logActions())).not.toContain(secret);
    const row = await env.DB.prepare("SELECT repo, created_by FROM oauth_apps WHERE client_id = ?").bind(clientId).first();
    expect(row).toEqual({ repo: REPO, created_by: "admin-one" });

    const again = await post(`/projects/${REPO}/app`, { csrf, action: "register", name: "Other", redirect_uris: RETURN }, cookie);
    expect(again.status).toBe(422);
  });

  it("refuses a plain http return address outside this machine", async () => {
    await addProject();
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/app`, { csrf, action: "register", name: "X", redirect_uris: "http://example.com/cb" }, cookie);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("at least one return address");
  });

  it("says when the return addresses drift from .fabrique.json, and follows it on request", async () => {
    await addProject(DECLARED);
    const { cookie, csrf } = await signIn("admin-one");
    await post(`/projects/${REPO}/app`, { csrf, action: "register", name: "Widget app", redirect_uris: RETURN }, cookie);
    expect(await setup()).toContain("The return addresses differ from <code>.fabrique.json</code>: missing <code>http://localhost:8787/auth/fabrique/retour</code>");
    const response = await post(`/projects/${REPO}/app`, { csrf, action: "returns" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/setup?notice=app_returns#connected-app`);
    expect(await setup()).not.toContain("The return addresses differ");
  });

  it("renews the secret without losing the connections", async () => {
    const { app, tokens } = await connect("mona", DECLARED);
    const admin = await signIn("admin-one");
    const renewed = await (await post(`/projects/${REPO}/app`, { csrf: admin.csrf, action: "secret" }, admin.cookie)).text();
    const secret = /<dt>client_secret<\/dt><dd><code>([^<]+)<\/code>/.exec(renewed)?.[1] ?? "";
    expect(secret).not.toBe(app.clientSecret);
    expect((await me(tokens.access_token)).status).toBe(200);
    const old = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: app.clientId, client_secret: app.clientSecret });
    expect(old.status).toBe(401);
    const fresh = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: app.clientId, client_secret: secret });
    expect(fresh.status).toBe(200);
    expect(await setup()).toContain("Connected 1 time, last by <span class=\"mono\">@mona</span>");
  });

  it("revokes every connection when the super admin removes the app", async () => {
    const { tokens } = await connect();
    const admin = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/app`, { csrf: admin.csrf, action: "remove" }, admin.cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/setup?notice=app_removed#connected-app`);
    expect((await me(tokens.access_token)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/me`)).status).toBe(401);
  });

  it("lists each project's app on the apps page, for the super admin, with a link to its Setup", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const page = await (await get("/apps", (await signIn("admin-one")).cookie)).text();
    expect(page).toContain(clientId);
    expect(page).toContain(`href="/projects/${REPO}/setup#connected-app"`);
  });
});

describe("The report kit", () => {
  it("is served for download, with its version, from any origin", async () => {
    const script = await get("/kit/fabrique-report.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.headers.get("access-control-allow-origin")).toBe("*");
    const body = await script.text();
    expect(body).toContain("FabriqueReport 1.4.0");
    expect(body).toContain("to-test=1");
    expect(body).toContain("can_test");
    expect(body).not.toMatch(/\beval\(|new Function\(/);
    expect((await get("/kit/fabrique-report.css")).headers.get("content-type")).toContain("text/css");
    expect((await get("/kit/fabrique-report-early.js")).status).toBe(200);
  });

  it("has its guide in La Fabrique, and Setup points to it", async () => {
    await addProject(DECLARED);
    const { cookie } = await signIn("admin-one");
    const guide = await (await get("/guide/report-kit", cookie)).text();
    expect(guide).toContain("The report kit");
    expect(guide).toContain('href="/kit/fabrique-report.js"');
    expect(await setup()).toContain('<a href="/guide/report-kit">How, step by step</a>');
  });
});
