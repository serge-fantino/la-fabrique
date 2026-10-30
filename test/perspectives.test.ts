import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
}

function choose(session: { cookie: string; csrf: string }, perspective: string, from = `/projects/${REPO}/board`): Promise<Response> {
  return SELF.fetch(`${BASE}/perspective`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: session.cookie, referer: `${BASE}${from}` },
    body: new URLSearchParams({ csrf: session.csrf, perspective }).toString(),
  });
}

function tabs(page: string): string[] {
  const nav = page.slice(page.indexOf('<nav class="tabs"'), page.indexOf("</nav>", page.indexOf('<nav class="tabs"')));
  return [...nav.matchAll(/>([^<]+)<\/a>/g)].map((match) => match[1] ?? "");
}

describe("Perspectives", () => {
  it("lets a super admin switch between Product, Administration and All; the tabs follow", async () => {
    await seed();
    const session = await signIn("admin-one");
    const before = await (await get(`/projects/${REPO}/board`, session.cookie)).text();
    expect(before).toContain("<summary><span class=\"muted\">Perspective</span> All</summary>");
    expect(tabs(before)).toContain("Setup");

    const response = await choose(session, "product");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/board`);
    const product = await (await get(`/projects/${REPO}/board`, session.cookie)).text();
    expect(product).toContain("<summary><span class=\"muted\">Perspective</span> Product</summary>");
    expect(tabs(product)).toEqual(["Overview", "Board", "Stories", "Backlog", "To test", "Defects", "Roadmap", "Releases", "Requests"]);

    await choose(session, "administration");
    const admin = await (await get(`/projects/${REPO}`, session.cookie)).text();
    expect(tabs(admin)).toEqual(["Overview", "Production", "To test", "Defects", "In development", "Delivery", "Activity", "Releases", "Log", "Setup"]);
  });

  it("keeps the tab one is on, marked, when it is outside the perspective", async () => {
    await seed();
    const session = await signIn("admin-one");
    await choose(session, "product");
    const page = await (await get(`/projects/${REPO}/log`, session.cookie)).text();
    expect(page).toContain('aria-current="page" class="outside" title="Not in this perspective">Log</a>');
  });

  it("starts a Product Engineer in Product and refuses a perspective the role does not open", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    const page = await (await get(`/projects/${REPO}`, session.cookie)).text();
    expect(page).toContain("<summary><span class=\"muted\">Perspective</span> Product</summary>");
    expect(page).not.toContain(">Administration</button>");

    await choose(session, "administration");
    const still = await (await get(`/projects/${REPO}`, session.cookie)).text();
    expect(still).toContain("<summary><span class=\"muted\">Perspective</span> Product</summary>");
  });

  it("shows no switcher to a tester, who keeps every tab", async () => {
    await seed();
    await grantRole("tess", "tester");
    const page = await (await get(`/projects/${REPO}`, (await signIn("tess")).cookie)).text();
    expect(page).not.toContain("perspective-menu");
    expect(tabs(page)).toContain("Setup");
  });
});
