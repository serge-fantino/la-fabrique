import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const SHA = "1111111111111111111111111111111111111111";
const NEXT_SHA = "2222222222222222222222222222222222222222";

const WIDGET_FILE = JSON.stringify({
  nom: "Widget",
  description: "A fake project used by the tests.",
  branches: { production: "main" },
  environnements: { int: { url: "https://int.widget.example", version: "/api/version" } },
  workflows: { ci: "ci.yml", promouvoir: null },
  documentation: [{ titre: "Readme", chemin: "README.md" }],
});

const WIDGET_TREE = [
  { path: ".fabrique.json", type: "blob" },
  { path: "README.md", type: "blob" },
  { path: ".github", type: "tree" },
  { path: ".github/workflows", type: "tree" },
  { path: ".github/workflows/ci.yml", type: "blob" },
];

const JSON_HEADERS = { headers: { "content-type": "application/json" } };

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
    .reply(201, JSON.stringify({ token: "ghs_installation", expires_at: "2099-01-01T00:00:00Z" }), JSON_HEADERS);
}

function mockInstalledRepos(repos: string[]): void {
  github()
    .intercept({ path: "/app/installations?per_page=100" })
    .reply(200, JSON.stringify([{ id: 99 }]), JSON_HEADERS);
  mockToken();
  github()
    .intercept({ path: "/installation/repositories?per_page=100" })
    .reply(200, JSON.stringify({ repositories: repos.map((full_name) => ({ full_name })) }), JSON_HEADERS);
}

function mockCommit(sha: string, file: string | null, tree = WIDGET_TREE): void {
  github()
    .intercept({ path: `/repos/${REPO}/git/trees/${sha}?recursive=1` })
    .reply(200, JSON.stringify({ tree: file === null ? tree.slice(1) : tree, truncated: false }), JSON_HEADERS);
  if (file !== null) {
    github().intercept({ path: `/repos/${REPO}/contents/.fabrique.json?ref=${sha}` }).reply(200, file);
  }
}

function mockFirstCheck(file: string | null, sha = SHA): void {
  mockToken();
  github().intercept({ path: `/repos/${REPO}` }).reply(200, JSON.stringify({ default_branch: "main" }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/branches/main` })
    .reply(200, JSON.stringify({ commit: { sha } }), JSON_HEADERS);
  mockCommit(sha, file);
}

async function addWidget(file: string | null): Promise<Response> {
  const { cookie, csrf } = await signIn("admin-one");
  mockInstalledRepos([REPO, "acme/other"]);
  mockFirstCheck(file);
  return post("/projects", { csrf, repo: REPO }, cookie);
}

async function seedWidget(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors) VALUES (?, 'main', ?, ?, '[]')",
    ).bind(REPO, SHA, WIDGET_FILE),
  ]);
}

async function hmac(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sendWebhook(event: string, payload: unknown, signature?: string): Promise<Response> {
  const body = JSON.stringify(payload);
  return (async () =>
    SELF.fetch("https://la-fabrique.test/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": signature ?? (await hmac(body)),
      },
      body,
    }))();
}

describe("Adding a project", () => {
  it("is reserved to super admins", async () => {
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    expect((await get("/projects/new", cookie)).status).toBe(403);
    expect((await post("/projects", { csrf, repo: REPO }, cookie)).status).toBe(403);
  });

  it("offers the repositories where the App is installed", async () => {
    const { cookie } = await signIn("admin-one");
    mockInstalledRepos([REPO, "acme/other"]);
    const page = await (await get("/projects/new", cookie)).text();
    expect(page).toContain(`<option value="${REPO}">`);
    expect(page).toContain('<option value="acme/other">');
  });

  it("adds a project, reads its .fabrique.json and shows its page", async () => {
    const response = await addWidget(WIDGET_FILE);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}?notice=added`);

    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(page).toContain("<h1>Widget</h1>");
    expect(page).toContain("A fake project used by the tests.");
    expect(page).toContain('href="https://github.com/acme/widget"');
    expect(page).toContain('href="https://int.widget.example"');
    expect(page).toContain('<span class="pill ok">Valid</span>');
    expect(page).toContain("1111111");

    expect(await logActions()).toEqual([
      { actor: "admin-one", action: "project_added", details: JSON.stringify({ installation_id: 99 }) },
    ]);
  });

  it("shows a broken file as readable errors without breaking the project list", async () => {
    await seedWidget();
    await env.DB.prepare("UPDATE projects SET repo = 'acme/healthy' WHERE repo = ?").bind(REPO).run();
    await env.DB.prepare("UPDATE project_configs SET repo = 'acme/healthy'").run();

    await addWidget('{ "nom": "Widget", "workflows": ');
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(page).toContain('<span class="pill alert">1 problem</span>');
    expect(page).toContain("The file is not valid JSON");

    const list = await (await get("/projects", cookie)).text();
    expect(list).toContain("acme/healthy");
    expect(list).toContain(REPO);
  });

  it("reports a missing file", async () => {
    await addWidget(null);
    const { cookie } = await signIn("admin-one");
    expect(await (await get(`/projects/${REPO}`, cookie)).text()).toContain(
      "There is no <code>.fabrique.json</code> at the root of <code>main</code>.",
    );
  });

  it("refuses a repository where the App is not installed", async () => {
    const { cookie, csrf } = await signIn("admin-one");
    mockInstalledRepos([REPO]);
    const response = await post("/projects", { csrf, repo: "acme/ghost" }, cookie);
    expect(response.headers.get("location")).toBe("/projects/new?notice=not_installed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first("n")).toBe(0);
  });

  it("follows the production branch the file declares", async () => {
    const { cookie, csrf } = await signIn("admin-one");
    mockInstalledRepos([REPO]);
    mockFirstCheck(JSON.stringify({ nom: "Widget", branches: { production: "release" } }));
    github()
      .intercept({ path: `/repos/${REPO}/branches/release` })
      .reply(200, JSON.stringify({ commit: { sha: NEXT_SHA } }), JSON_HEADERS);
    mockCommit(NEXT_SHA, JSON.stringify({ nom: "Widget release", branches: { production: "release" } }));

    await post("/projects", { csrf, repo: REPO }, cookie);
    const page = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(page).toContain("<h1>Widget release</h1>");
    expect(page).toContain("Read from <code>release</code>");
  });
});

describe("Project pages", () => {
  it("are visible to every role", async () => {
    await seedWidget();
    await grantRole("qa", "tester");
    const { cookie } = await signIn("qa");
    const page = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(page).toContain("<h1>Widget</h1>");
    expect(page).not.toContain("Check again");
    expect(await (await get("/", cookie)).text()).toContain("Widget");
  });

  it("are closed to anonymous visitors", async () => {
    await seedWidget();
    expect((await get(`/projects/${REPO}`)).headers.get("location")).toBe("/");
  });
});

describe("Push webhook", () => {
  it("re-checks the file when the production branch moves", async () => {
    await seedWidget();
    mockToken();
    mockCommit(NEXT_SHA, JSON.stringify({ nom: "Widget 2" }));

    const response = await sendWebhook("push", {
      ref: "refs/heads/main",
      after: NEXT_SHA,
      repository: { full_name: REPO, default_branch: "main" },
    });
    expect(response.status).toBe(200);

    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}`, cookie)).text();
    expect(page).toContain("<h1>Widget 2</h1>");
    expect(page).toContain("2222222");
  });

  it("ignores pushes to other branches", async () => {
    await seedWidget();
    const response = await sendWebhook("push", {
      ref: "refs/heads/feature/x",
      after: NEXT_SHA,
      repository: { full_name: REPO, default_branch: "main" },
    });
    expect(response.status).toBe(202);
  });

  it("refuses a payload without a valid signature", async () => {
    await seedWidget();
    const response = await sendWebhook("push", { ref: "refs/heads/main", after: NEXT_SHA }, "sha256=forged");
    expect(response.status).toBe(401);
  });
});
