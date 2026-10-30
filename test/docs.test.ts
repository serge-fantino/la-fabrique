import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const SHA = "1111111111111111111111111111111111111111";
const NEXT_SHA = "2222222222222222222222222222222222222222";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const CONFIG = {
  nom: "Widget",
  branches: { production: "main" },
  documentation: [
    { titre: "Read me", chemin: "README.md" },
    { titre: "Guide", chemin: "docs/guide/" },
  ],
};
const PAGES = ["README.md", "docs/guide/intro.md", "docs/guide/setup.md"];

const README = [
  "# Widget",
  "",
  "See the [setup guide](docs/guide/setup.md#install) and the [code](src/index.ts).",
  "External: [example](https://example.com). Anchor: [below](#usage).",
  "",
  "## Usage",
  "",
  "<script>alert('readme')</script>",
  "",
  "[bad](javascript:alert(1))",
].join("\n");

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function github() {
  return fetchMock.get("https://api.github.com");
}

function mockToken(): void {
  github()
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
}

function mockFile(sha: string, path: string, content: string): void {
  github().intercept({ path: `/repos/${REPO}/contents/${path}?ref=${sha}` }).reply(200, content);
}

async function seed(docPages: string[] | null = PAGES): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      `INSERT INTO project_configs (repo, branch, commit_sha, config, errors, committed_at, doc_pages)
       VALUES (?, 'main', ?, ?, '[]', '2026-10-20T08:00:00Z', ?)`,
    ).bind(REPO, SHA, JSON.stringify(CONFIG), docPages ? JSON.stringify(docPages) : null),
  ]);
}

async function adminCookie(): Promise<string> {
  return (await signIn("admin-one")).cookie;
}

describe("Project documentation", () => {
  it("renders a page from the production commit, with its version and links", async () => {
    await seed();
    mockToken();
    mockFile(SHA, "README.md", README);

    const response = await get(`/projects/${REPO}/docs/README.md`, await adminCookie());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const page = await response.text();

    expect(page).toContain('<h1 id="widget">Widget</h1>');
    expect(page).toContain(`href="/projects/${REPO}/docs/docs/guide/setup.md#install"`);
    expect(page).toContain(`href="https://github.com/${REPO}/blob/${SHA}/src/index.ts"`);
    expect(page).toContain('href="https://example.com"');
    expect(page).toContain('<h2 id="usage">Usage</h2>');
    expect(page).toContain("1111111");
    expect(page).toContain("2026-10-20 08:00 UTC");
    expect(page).toContain(`href="https://github.com/${REPO}/blob/${SHA}/README.md">View on GitHub</a>`);
  });

  it("never lets a script in the Markdown run", async () => {
    await seed();
    mockToken();
    mockFile(SHA, "README.md", README);

    const page = await (await get(`/projects/${REPO}/docs/README.md`, await adminCookie())).text();
    expect(page).not.toMatch(/<script(?![^>]*\bsrc="\/fabrique\.js\?v=)/i);
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain('href="javascript:');
  });

  it("reads each file once per commit", async () => {
    await seed();
    mockToken();
    mockFile(SHA, "README.md", README);
    const cookie = await adminCookie();

    await get(`/projects/${REPO}/docs/README.md`, cookie);
    const again = await get(`/projects/${REPO}/docs/README.md`, cookie);
    expect(again.status).toBe(200);
  });

  it("keeps relative links of a folder page inside La Fabrique and lists its siblings", async () => {
    await seed();
    mockToken();
    mockFile(SHA, "docs/guide/intro.md", "# Intro\n\n[next](setup.md) and [home](../../README.md#widget)");

    const page = await (await get(`/projects/${REPO}/docs/docs/guide/intro.md`, await adminCookie())).text();
    expect(page).toContain(`href="/projects/${REPO}/docs/docs/guide/setup.md"`);
    expect(page).toContain(`href="/projects/${REPO}/docs/README.md#widget"`);
    expect(page).toContain("Also in Guide");
  });

  it("only serves pages the project publishes", async () => {
    await seed();
    const cookie = await adminCookie();
    expect((await get(`/projects/${REPO}/docs/src/index.ts`, cookie)).status).toBe(404);
    expect((await get(`/projects/${REPO}/docs/docs/other/secret.md`, cookie)).status).toBe(404);
  });

  it("is listed on the project page and readable by every role", async () => {
    await seed();
    await env.DB.prepare(
      "INSERT INTO doc_cache (repo, commit_sha, path, markdown) VALUES (?, ?, 'README.md', '# Cached')",
    ).bind(REPO, SHA).run();
    await grantRole("qa", "tester");
    const { cookie } = await signIn("qa");

    const project = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(project).toContain(`href="/projects/${REPO}/docs/README.md">Read me</a>`);
    expect(project).toContain(`href="/projects/${REPO}/docs/docs/guide/setup.md">setup</a>`);
    expect(await (await get(`/projects/${REPO}/docs/README.md`, cookie)).text()).toContain("Cached");
  });

  it("is closed to anonymous visitors", async () => {
    await seed();
    expect((await get(`/projects/${REPO}/docs/README.md`)).headers.get("location")).toBe("/");
  });

  it("shows the new version after a push on the production branch", async () => {
    await seed();
    await env.DB.prepare(
      "INSERT INTO doc_cache (repo, commit_sha, path, markdown) VALUES (?, ?, 'README.md', '# Old')",
    ).bind(REPO, SHA).run();

    mockToken();
    github()
      .intercept({ path: `/repos/${REPO}/git/trees/${NEXT_SHA}?recursive=1` })
      .reply(
        200,
        JSON.stringify({
          tree: [".fabrique.json", ...PAGES].map((path) => ({ path, type: "blob" })).concat([
            { path: "docs", type: "tree" },
            { path: "docs/guide", type: "tree" },
          ]),
          truncated: false,
        }),
        JSON_HEADERS,
      );
    mockFile(NEXT_SHA, ".fabrique.json", JSON.stringify(CONFIG));

    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: NEXT_SHA,
      repository: { full_name: REPO, default_branch: "main" },
      head_commit: { timestamp: "2026-10-30T09:15:00Z" },
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const webhook = await SELF.fetch("https://la-fabrique.test/api/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      },
      body,
    });
    expect(webhook.status).toBe(200);

    mockToken();
    mockFile(NEXT_SHA, "README.md", "# New");
    const page = await (await get(`/projects/${REPO}/docs/README.md`, await adminCookie())).text();
    expect(page).toContain("<h1 id=\"new\">New</h1>");
    expect(page).toContain("2222222");
    expect(page).toContain("2026-10-30 09:15 UTC");

    const shas = await env.DB.prepare("SELECT DISTINCT commit_sha FROM doc_cache WHERE repo = ?").bind(REPO).all();
    expect(shas.results).toEqual([{ commit_sha: NEXT_SHA }]);
  });

  it("lists the pages again for a check made before documentation existed", async () => {
    await seed(null);
    mockToken();
    github()
      .intercept({ path: `/repos/${REPO}/branches/main` })
      .reply(200, JSON.stringify({ commit: { sha: SHA, commit: { committer: { date: "2026-10-20T08:00:00Z" } } } }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/git/trees/${SHA}?recursive=1` })
      .reply(
        200,
        JSON.stringify({
          tree: [".fabrique.json", ...PAGES].map((path) => ({ path, type: "blob" })).concat([
            { path: "docs", type: "tree" },
            { path: "docs/guide", type: "tree" },
          ]),
          truncated: false,
        }),
        JSON_HEADERS,
      );
    mockFile(SHA, ".fabrique.json", JSON.stringify(CONFIG));
    mockToken();
    mockFile(SHA, "docs/guide/setup.md", "# Setup");

    const response = await get(`/projects/${REPO}/docs/docs/guide/setup.md`, await adminCookie());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1 id=\"setup\">Setup</h1>");
  });
});
