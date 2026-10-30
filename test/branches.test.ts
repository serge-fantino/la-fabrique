import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const INT_SHA = "3333333333333333333333333333333333333333";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const INTEGRATION_FILE = JSON.stringify({
  nom: "Widget (next)",
  branches: { production: "main", integration: "integration" },
  documentation: [{ titre: "Guide", chemin: "docs/" }],
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function github() {
  return fetchMock.get("https://api.github.com");
}

// Production has no `.fabrique.json` yet; integration has one, with docs.
async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      `INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages)
       VALUES (?, 'main', ?, ?, '[]', '[]')`,
    ).bind(REPO, MAIN_SHA, JSON.stringify({ nom: "Widget", branches: { production: "main", integration: "integration" } })),
  ]);
}

function mockIntegration(): void {
  github()
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/branches/integration` })
    .reply(200, JSON.stringify({ commit: { sha: INT_SHA, commit: { committer: { date: "2026-10-30T01:00:00Z" } } } }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/git/trees/${INT_SHA}?recursive=1` })
    .reply(
      200,
      JSON.stringify({
        tree: [
          { path: ".fabrique.json", type: "blob" },
          { path: "docs", type: "tree" },
          { path: "docs/intro.md", type: "blob" },
        ],
        truncated: false,
      }),
      JSON_HEADERS,
    );
  github().intercept({ path: `/repos/${REPO}/contents/.fabrique.json?ref=${INT_SHA}` }).reply(200, INTEGRATION_FILE);
}

describe("Reading another branch", () => {
  it("shows the integration branch's file and documentation, production unchanged", async () => {
    await seed();
    mockIntegration();
    const { cookie } = await signIn("admin-one");

    const page = await (await get(`/projects/${REPO}?ref=integration`, cookie)).text();
    expect(page).toContain("Showing branch <code>integration</code> at <span class=\"mono\">3333333</span>");
    expect(page).toContain(`href="/projects/${REPO}/docs/docs/intro.md?ref=integration">intro</a>`);
    expect(page).toContain('aria-current="page"><code>integration</code>');

    const list = await (await get("/projects", cookie)).text();
    expect(list).toContain(">Widget</a>");
    expect(list).not.toContain("Widget (next)");
    const production = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(production).not.toContain("Showing branch");
  });

  it("renders a documentation page at the branch's commit and keeps its links on that branch", async () => {
    await seed();
    mockIntegration();
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/contents/docs/intro.md?ref=${INT_SHA}` })
      .reply(200, "# Intro\n\n[Again](intro.md)");
    const { cookie } = await signIn("admin-one");

    const page = await (await get(`/projects/${REPO}/docs/docs/intro.md?ref=integration`, cookie)).text();
    expect(page).toContain('<h1 id="intro">Intro</h1>');
    expect(page).toContain(`href="/projects/${REPO}/docs/docs/intro.md?ref=integration"`);
    expect(page).toContain("<code>integration</code> at");

    const rows = await env.DB.prepare("SELECT branch, commit_sha FROM doc_cache").all();
    expect(rows.results).toEqual([{ branch: "integration", commit_sha: INT_SHA }]);
  });

  it("reads the branch again only when it may have moved", async () => {
    await seed();
    mockIntegration();
    const { cookie } = await signIn("admin-one");
    await get(`/projects/${REPO}?ref=integration`, cookie);
    expect((await get(`/projects/${REPO}?ref=integration`, cookie)).status).toBe(200);
  });

  it("says so when the branch does not exist", async () => {
    await seed();
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/branches/nope` }).reply(404, JSON.stringify({ message: "Branch not found" }), JSON_HEADERS);

    const response = await get(`/projects/${REPO}?ref=nope`, (await signIn("admin-one")).cookie);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("There is no branch `nope` in acme/widget.");
  });

  it("ignores branch names that are not branch names", async () => {
    await seed();
    const page = await (await get(`/projects/${REPO}?ref=..%2Fsecret`, (await signIn("admin-one")).cookie)).text();
    expect(page).not.toContain("Showing branch");
  });
});
