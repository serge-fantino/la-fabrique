import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, signIn } from "./helpers";

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
    expect(page).toContain("Reference branch <code>integration</code>; production is <code>main</code>.");
    expect(page).toContain("Read from <code>integration</code> at");
    expect(page).toContain(">3333333</a>");
    expect(page).toContain(`href="/projects/${REPO}/docs/docs/intro.md?ref=integration">intro</a>`);
    expect(page).toContain('<summary><span class="muted">Branch</span> <code>integration</code></summary>');
    expect(page).toContain('aria-current="true"><code>integration</code>');

    const list = await (await get("/projects", cookie)).text();
    expect(list).toContain(">Widget</a>");
    expect(list).not.toContain("Widget (next)");
    const production = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(production).not.toContain("Reference branch");
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
    expect(page).not.toContain("Reference branch");
  });
});

function refCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /__Host-lf_ref=[^;]*/.exec(header);
  return match?.[0] ?? "";
}

describe("The reference branch of the header", () => {
  it("is remembered per project, like a checkout, until production is chosen again", async () => {
    await seed();
    mockIntegration();
    const { cookie } = await signIn("admin-one");

    const chosen = await get(`/projects/${REPO}?ref=integration`, cookie);
    const ref = refCookie(chosen);
    expect(ref).toMatch(/^__Host-lf_ref=.+/);
    expect(chosen.headers.get("set-cookie")).toContain("Secure");

    const later = await (await get(`/projects/${REPO}`, `${cookie}; ${ref}`)).text();
    expect(later).toContain("Reference branch <code>integration</code>");
    expect(later).toContain(`<a href="/projects/${REPO}?ref=">Back to production</a>`);

    const back = await get(`/projects/${REPO}?ref=`, `${cookie}; ${ref}`);
    expect(refCookie(back)).toBe("__Host-lf_ref=");
    expect(await back.text()).not.toContain("Reference branch");
  });

  it("forgets a branch that no longer exists and shows production", async () => {
    await seed();
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/branches/gone` }).reply(404, JSON.stringify({ message: "Branch not found" }), JSON_HEADERS);
    const { cookie } = await signIn("admin-one");
    const saved = `__Host-lf_ref=${encodeURIComponent(JSON.stringify({ [REPO]: "gone" }))}`;

    const response = await get(`/projects/${REPO}`, `${cookie}; ${saved}`);
    expect(response.status).toBe(404);
    expect(refCookie(response)).toBe("__Host-lf_ref=");
    const page = await response.text();
    expect(page).toContain("There is no branch `gone` in acme/widget.");
    expect(page).toContain('<summary><span class="muted">Branch</span> <code>main</code></summary>');
  });

  it("lists every branch for the menu, production and integration first, and caches the list", async () => {
    await seed();
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: (path) => path.startsWith(`/repos/${REPO}/branches`) && path.includes("per_page=100") })
      .reply(200, JSON.stringify([{ name: "feature/b" }, { name: "main" }, { name: "claude/a" }, { name: "integration" }]), JSON_HEADERS);
    const { cookie } = await signIn("admin-one");

    const response = await get(`/projects/${REPO}/branches`, cookie);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ branches: ["main", "integration", "claude/a", "feature/b"] });
    // Read again from the cache, without GitHub.
    expect(await (await get(`/projects/${REPO}/branches`, cookie)).json()).toEqual({
      branches: ["main", "integration", "claude/a", "feature/b"],
    });

    const page = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(page).toContain('<option value="feature/b"></option>');
  });

  it("keeps the branch list for people signed in only", async () => {
    await seed();
    const response = await get(`/projects/${REPO}/branches`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("serves the shared script, which has the loading bar and the branch menu", async () => {
    const response = await get("/fabrique.js");
    expect(response.headers.get("content-type")).toContain("text/javascript");
    const source = await response.text();
    expect(source).toContain("[data-loading]");
    expect(source).toContain("[data-branch-menu]");
    const page = await (await get("/projects", (await signIn("admin-one")).cookie)).text();
    expect(page).toMatch(/<script src="\/fabrique\.js\?v=[0-9a-f]{8}" defer><\/script>/);
    expect(page).toContain('<div class="loading" data-loading aria-hidden="true"><i></i></div>');
  });

  it("links each stylesheet and script by its fingerprint, cached for good, and revalidates the bare address", async () => {
    const page = await (await get("/projects", (await signIn("admin-one")).cookie)).text();
    const href = /href="(\/styles\.css\?v=[0-9a-f]{8})"/.exec(page)?.[1] ?? "";
    expect(href).not.toBe("");

    const fingerprinted = await get(href);
    expect(fingerprinted.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = fingerprinted.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{8}"$/);

    const bare = await get("/styles.css");
    expect(bare.headers.get("cache-control")).toBe("no-cache");
    const again = await SELF.fetch(`${BASE}/styles.css`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    // An old fingerprint gets today's file, never kept for long.
    expect((await get("/styles.css?v=00000000")).headers.get("cache-control")).toBe("no-cache");
  });
});
