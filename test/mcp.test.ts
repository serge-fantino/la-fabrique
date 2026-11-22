import { env, fetchMock, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";
import { challenge, connect, me, token, VERIFIER, type Tokens } from "./oauth-helpers";

const REPO = "acme/widget";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

// The persisted fake GitHub of test_story is never fully used: it opts out.
let persistedGithub = false;
afterEach(() => {
  if (!persistedGithub) fetchMock.assertNoPendingInterceptors();
});

async function seedProject(config: Record<string, unknown> = { nom: "Widget", langue: "en", cycle: { priorites: ["P1", "P2", "P3"] } }): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', '2099-01-01T00:00:00.000Z')").bind(REPO),
  ]);
}

// Claude registers itself (public client, PKCE), then the person allows it.
async function register(): Promise<string> {
  const response = await SELF.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorizePath(clientId: string, scope = "fabrique", resource = `${BASE}/`): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope,
    state: "s1",
    code_challenge: await challenge(VERIFIER),
    code_challenge_method: "S256",
    resource,
  });
  return `/oauth/authorize?${query}`;
}

let lastClient = "";
async function connectClaude(login: string, scope = "fabrique", resource = `${BASE}/`): Promise<Tokens> {
  const clientId = await register();
  lastClient = clientId;
  const { cookie, csrf } = await signIn(login);
  const path = await authorizePath(clientId, scope, resource);
  const consent = await (await get(path, cookie)).text();
  expect(consent).toContain("will be able to work in La Fabrique in your name");
  expect(consent).toContain("Never the go to production");
  fetchMock.get("https://api.github.com").intercept({ path: "/user" }).reply(200, JSON.stringify({ login, id: 9, name: "Pat", avatar_url: "" }), JSON_HEADERS);
  const approved = await post(path, { csrf, decision: "allow" }, cookie);
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const response = await token({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: VERIFIER, client_id: clientId, resource });
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

let id = 0;
async function rpc(access: string, method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const response = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

async function call(access: string, name: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const { result } = await rpc(access, "tools/call", { name, arguments: args });
  return { data: (result?.["structuredContent"] ?? {}) as Record<string, unknown>, isError: result?.["isError"] === true };
}

describe("La Fabrique's MCP server", () => {
  it("asks for a token, and says where to get one", async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    const metadata = (await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(metadata["resource"]).toBe(BASE);
  });

  it("is refused to an account without a role", async () => {
    const clientId = await register();
    const { cookie } = await signIn("stranger");
    const page = await get(await authorizePath(clientId), cookie);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("has no role in La Fabrique");
  });

  it("connects as claude.ai does: the MCP address as the resource, every scope asked, `fabrique` granted", async () => {
    await grantRole("pe", "product_engineer");
    const tokens = await connectClaude("pe", "defects:report fabrique", `${BASE}/mcp`);
    expect(tokens.scope).toBe("fabrique");
    expect((await rpc(tokens.access_token, "ping")).result).toEqual({});
    // La Fabrique's mark, for the assistant to show; served as PNG too.
    const info = (await rpc(tokens.access_token, "initialize", { protocolVersion: "2025-11-25" })).result?.["serverInfo"] as { icons: { src: string; mimeType: string }[] };
    expect(info.icons.map((icon) => icon.src)).toEqual([`${BASE}/favicon.svg`, `${BASE}/icon-512.png`, `${BASE}/icon-192.png`]);
    for (const path of ["/favicon.ico", "/icon-512.png", "/icon-192.png", "/apple-touch-icon.png"]) {
      const icon = await SELF.fetch(`${BASE}${path}`);
      expect(icon.headers.get("content-type")).toBe("image/png");
      expect([...new Uint8Array(await icon.arrayBuffer()).slice(1, 4)].map((byte) => String.fromCharCode(byte)).join("")).toBe("PNG");
    }
    // Its refresh token works the same way.
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: lastClient, resource: `${BASE}/mcp` });
    expect(refreshed.status).toBe(200);
    expect((await rpc(((await refreshed.json()) as Tokens).access_token, "ping")).result).toEqual({});
  });

  it("lets Claude write a card, its spec and its stories, start the sprint, in the person's name and in the log", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");

    const init = await rpc(access, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } });
    expect(init.result?.["protocolVersion"]).toBe("2025-06-18");
    expect(String(init.result?.["instructions"])).toContain("never through this server");
    const tools = ((await rpc(access, "tools/list")).result?.["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(tools).toContain("card_create");
    // A Product Engineer does not launch Claude nor merge.
    expect(tools).not.toContain("launch_claude");
    expect(tools).not.toContain("merge");

    const projects = await call(access, "projects", {});
    expect(projects.data["role"]).toBe("product_engineer");
    expect((projects.data["projects"] as { repo: string }[])[0]?.repo).toBe(REPO);

    const created = await call(access, "card_create", { project: "widget", title: "Weekly menu", body: "Plan the week. {segment: Families}", release: "Next release", priority: "P2" });
    expect(created.isError).toBe(false);
    const card = created.data["created"] as { id: number; ref: string; release: string; priority: string; segment: string; url: string };
    expect(card).toMatchObject({ ref: `C${card.id}`, release: "Next release", priority: "P2", segment: "Families", url: `${BASE}/projects/${REPO}/cards/${card.id}` });
    expect((await call(access, "card_create", { project: REPO, title: "Wrong", release: "1.2" })).data["error"]).toContain("takes a version only once it ships");

    // The spec, by the project's sections; stories need it whole.
    const partial = await call(access, "card_spec", { project: REPO, card: card.id, answers: { context: "Families plan by hand." } });
    expect(partial.data["missing"]).toEqual(["Need", "Acceptance criteria"]);
    expect((await call(access, "card_spec", { project: REPO, card: card.id, answers: { unknown: "x" } })).data["error"]).toContain("Unknown sections: unknown");
    const whole = await call(access, "card_spec", { project: REPO, card: card.id, answers: { need: "Plan seven days.", criteria: "- [ ] When I open the menu, I see the week." }, validate: true });
    expect(whole.data["missing"]).toEqual([]);
    expect((whole.data["card"] as { status: string }).status).toBe("to_validate");
    const read = await call(access, "card", { project: REPO, card: `C${card.id}` });
    expect((read.data["spec"] as { answers: Record<string, string> }).answers["context"]).toBe("Families plan by hand.");

    // Two stories, made by the App and signed with the person's login.
    const bodies: string[] = [];
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).persist();
    let next = 40;
    github
      .intercept({ method: "POST", path: `/repos/${REPO}/issues` })
      .reply(201, (options) => {
        const body = JSON.parse(String(options.body)) as { title: string; body: string };
        bodies.push(body.body);
        next += 1;
        return JSON.stringify({ number: next, title: body.title, html_url: `https://github.com/${REPO}/issues/${next}`, state: "open", labels: [], body: body.body, user: { login: "la-fabrique[bot]" }, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", closed_at: null });
      })
      .times(2);
    github.intercept({ method: "POST", path: `/repos/${REPO}/labels` }).reply(201, "{}").persist();
    github.intercept({ method: "POST", path: /\/repos\/acme\/widget\/issues\/4\d\/labels/ }).reply(200, "[]").persist();
    const stories = await call(access, "stories_create", {
      project: REPO,
      card: card.id,
      stories: [
        { title: "See the week", answers: { context: "c", need: "n", criteria: "- [ ] a" } },
        { title: "Print the week", answers: { context: "c", need: "n", criteria: "- [ ] b" }, nice: true },
      ],
    });
    expect(stories.isError).toBe(false);
    expect((stories.data["created"] as { number: number }[]).map((story) => story.number)).toEqual([41, 42]);
    expect(bodies[0]).toContain(`/c/${card.id}?rev=`);
    expect(bodies[0]).toContain("story 1 of 2");
    expect(bodies[1]).toContain("@pe");

    const board = await call(access, "board", { project: REPO, release: "Next release" });
    expect((board.data["cards"] as { id: number; status: string; stories: number[] }[])[0]).toMatchObject({ id: card.id, status: "validated", stories: [41, 42] });

    const started = await call(access, "sprint_start", { project: REPO });
    expect(started.data).toMatchObject({ started: true, cards: 1 });
    const sprint = await call(access, "sprint", { project: REPO });
    expect((sprint.data["cards"] as { stories: { number: number; nice_to_have: boolean }[] }[])[0]?.stories).toMatchObject([{ number: 41, nice_to_have: false }, { number: 42, nice_to_have: true }]);
    expect(sprint.data["stories_left"]).toEqual([41]);

    // An issue linked to a draft card validates it, as making its stories does.
    const other = (await call(access, "card_create", { project: REPO, title: "Print it" })).data["created"] as { id: number };
    expect((await call(access, "story_link", { project: REPO, card: other.id, story: 41 })).data).toMatchObject({ linked: 41 });
    expect(((await call(access, "card", { project: REPO, card: other.id })).data["status"])).toBe("validated");

    // A change over a newer version is refused.
    expect((await call(access, "card_update", { project: REPO, card: card.id, title: "Menu", rev: 1 })).data["error"]).toContain("changed since");
    const updated = await call(access, "card_update", { project: REPO, card: card.id, title: "The weekly menu" });
    expect(updated.data["changed"]).toEqual(["text"]);

    const actions = await logActions();
    expect(actions.filter((entry) => entry.action === "mcp_write").map((entry) => JSON.parse(entry.details ?? "{}").tool)).toEqual([
      "card_create",
      "card_spec",
      "card_spec",
      "stories_create",
      "sprint_start",
      "card_create",
      "story_link",
      "card_update",
    ]);
    expect(actions.find((entry) => entry.action === "card_created")?.actor).toBe("pe");
    expect(actions.find((entry) => entry.action === "assistant_connected")?.actor).toBe("pe");
    const log = await (await get(`/projects/${REPO}/log`, (await signIn("pe")).cookie)).text();
    expect(log).toContain("through Claude");
  });

  it("reads an epic with its features, by number or by name, and filters the board by epic", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");
    const make = async (title: string, body: string) => ((await call(access, "card_create", { project: REPO, title, body })).data["created"] as { id: number }).id;
    const epic = await make("F9 Epics", "The epic's document.");
    const a = await make("Read an epic", `{epic: F9 Epics}`);
    const b = await make("Filter the board", `{epic: C${epic}}`);
    const plain = await make("Unrelated", "");

    expect((await call(access, "projects", {})).data["projects"]).toMatchObject([{ epics: 1 }]);

    const byNumber = await call(access, "epic", { project: REPO, epic });
    expect(byNumber.isError).toBe(false);
    expect(byNumber.data).toMatchObject({ id: epic, title: "F9 Epics", document: "The epic's document.", revision: 1, github_issue: null });
    expect((byNumber.data["features"] as { number: number; title: string; status: string; progress: string }[]).map((f) => f.number).sort()).toEqual([a, b].sort());
    expect(Object.values(byNumber.data["features_per_status"] as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(2);

    const byName = await call(access, "epic", { project: REPO, epic: "F9 Epics" });
    expect(byName.data).toEqual(byNumber.data);

    const notEpic = await call(access, "epic", { project: REPO, epic: plain });
    expect(notEpic.isError).toBe(true);
    expect(notEpic.data["error"]).toContain("not an epic");
    expect(notEpic.data["features"]).toBeUndefined();

    const board = await call(access, "board", { project: REPO, epic: "F9 Epics" });
    expect((board.data["cards"] as { id: number }[]).map((card) => card.id).sort()).toEqual([a, b].sort());
    const boardByNumber = await call(access, "board", { project: REPO, epic });
    expect((boardByNumber.data["cards"] as { id: number }[]).length).toBe(2);
  });

  it("creates an epic and updates its document, refusing an older revision", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    await grantRole("tester", "tester");
    const { access_token: access } = await connectClaude("pe");
    const created = await call(access, "epic_create", { project: REPO, title: "F10 Docs", document: "What and why." });
    expect(created.isError).toBe(false);
    const epic = created.data["created"] as { id: number; revision: number };
    expect(epic.revision).toBe(1);
    const card = await env.DB.prepare("SELECT kind, body FROM cards WHERE id = ?").bind(epic.id).first<{ kind: string; body: string }>();
    expect(card).toMatchObject({ kind: "epic", body: "What and why." });

    const updated = await call(access, "epic_update", { project: REPO, card: epic.id, rev: 1, document: "A better document." });
    expect(updated.data).toMatchObject({ changed: ["document"], epic: { revision: 2 } });
    const revisions = await env.DB.prepare("SELECT COUNT(*) AS n FROM card_revisions WHERE card_id = ?").bind(epic.id).first<{ n: number }>();
    expect(revisions?.n).toBe(2);

    const stale = await call(access, "epic_update", { project: REPO, card: epic.id, rev: 1, document: "Lost." });
    expect(stale.data["error"]).toContain("The card changed since (now version 2)");
    const after = await env.DB.prepare("SELECT body FROM cards WHERE id = ?").bind(epic.id).first<{ body: string }>();
    expect(after?.body).toBe("A better document.");

    const actions = await logActions();
    expect(actions.filter((entry) => entry.action === "mcp_write").map((entry) => JSON.parse(entry.details ?? "{}").tool)).toEqual(["epic_create", "epic_update"]);
  });

  it("reads a project's setup for onboarding: items with how to do them, the guide and the fitting claude workflow; tech lead and above", async () => {
    await seedProject({ nom: "Widget", langue: "en" });
    await grantRole("lead", "tech_lead");
    await grantRole("tester", "tester");
    const { access_token: lead } = await connectClaude("lead");
    const read = await call(lead, "setup", { project: "widget" });
    expect(read.isError).toBe(false);
    const data = read.data as {
      project: string;
      summary: { required_done: number; required: number; missing: string[] };
      items: { key: string; state: string; optional: boolean; title: string; found: string; why: string; how: string }[];
      guide: string;
      examples: Record<string, { from: string; text: string }>;
      url: string;
    };
    expect(data.project).toBe(REPO);
    expect(data.summary.missing).toEqual(expect.arrayContaining(["release_notes", "ci", "environments"]));
    expect(data.summary.required_done).toBeLessThan(data.summary.required);
    const notes = data.items.find((item) => item.key === "release_notes");
    expect(notes).toMatchObject({ state: "missing", optional: false, title: "Release notes in the Fabrique format", found: "No `version.fichier`." });
    // The page's explanation as text: code kept and indented, links absolute.
    expect(notes?.how).toContain('```\n"version": { "fichier": "docs/release-notes.json", "forme": "0.N" }\n```');
    expect(notes?.how).toContain('    "version": "0.2",');
    expect(notes?.how).toContain("(https://");
    expect(notes?.how).not.toMatch(/<[a-z]/);
    expect(data.items.find((item) => item.key === "integration")?.optional).toBe(true);
    expect(data.guide).toContain("# Onboarding a project with Claude Code");
    // No integration branch: La Fabrique's own workflow, pull requests to the production branch.
    expect(data.examples["claude.yml"]?.from).toContain("no integration branch");
    expect(data.examples["claude.yml"]?.text).toContain("workflow_dispatch");
    expect(data.url).toBe(`${BASE}/projects/${REPO}/setup`);

    const { access_token: tester } = await connectClaude("tester");
    const refused = await call(tester, "setup", { project: REPO });
    expect(refused.isError).toBe(true);
    expect(refused.data["error"]).toContain("tech lead and above");
  });

  it("renames an epic with a new document and keeps its features", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");
    const epic = (await call(access, "epic_create", { project: REPO, title: "F13 A new product", document: "## Features\n\nC2" })).data["created"] as { id: number };
    const make = async (title: string) => ((await call(access, "card_create", { project: REPO, title, epic: epic.id })).data["created"] as { id: number }).id;
    const a = await make("Add a project");
    const b = await make("The starter");

    const renamed = await call(access, "epic_update", { project: REPO, card: epic.id, rev: 1, title: "F13 Onboard a product", document: "## Features\n\nC99" });
    expect(renamed.data).toMatchObject({ changed: ["title", "document"], epic: { title: "F13 Onboard a product" } });

    const read = await call(access, "epic", { project: REPO, epic: epic.id });
    expect((read.data["features"] as { number: number }[]).map((f) => f.number).sort()).toEqual([a, b].sort());
    const feature = await call(access, "card", { project: REPO, card: a });
    expect(feature.data["epic"]).toBe("F13 Onboard a product");
    const board = await call(access, "board", { project: REPO, epic: "F13 Onboard a product" });
    expect((board.data["cards"] as { id: number }[]).map((card) => card.id).sort()).toEqual([a, b].sort());

    const renames = (await logActions()).filter((entry) => entry.action === "epic_renamed");
    expect(renames).toHaveLength(1);
    const details = JSON.parse(renames[0]?.details ?? "{}") as { card: number; from: string; to: string; features: number[] };
    expect({ ...details, features: details.features.sort() }).toEqual({ card: epic.id, from: "F13 A new product", to: "F13 Onboard a product", features: [a, b].sort() });
  });

  it("writes an epic's technical GitHub issue on create and update, and survives a GitHub refusal", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");
    const github = fetchMock.get("https://api.github.com");
    const issue = (number: number, body: string) =>
      JSON.stringify({ number, title: "F10 Docs", html_url: `https://github.com/${REPO}/issues/${number}`, state: "open", labels: [{ name: "epique" }], body, user: { login: "la-fabrique[bot]" }, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", closed_at: null });
    const sent: { labels?: string[]; body: string }[] = [];
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues` }).reply(201, (options) => {
      const body = JSON.parse(String(options.body)) as { labels?: string[]; body: string };
      sent.push(body);
      return issue(60, body.body);
    });
    const created = await call(access, "epic_create", { project: REPO, title: "F10 Docs", document: "Functional document.", technical: "Use a queue." });
    const epic = created.data["created"] as { id: number };
    expect(created.data["github_issue"]).toMatchObject({ number: 60, created: true });
    expect(sent[0]?.labels).toEqual(["epique"]);
    expect(sent[0]?.body).toContain("Use a queue.");
    expect(sent[0]?.body).toContain("@pe");
    expect(sent[0]?.body).toContain(`/c/${epic.id}`);
    expect(sent[0]?.body).not.toContain("Functional document.");
    const link = await env.DB.prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = 'epic_issue'").bind(epic.id).first<{ ref: string }>();
    expect(link?.ref).toBe("60");
    expect((await call(access, "epic", { project: REPO, epic: epic.id })).data["github_issue"]).toMatchObject({ number: 60 });

    // Update with a technical text replaces the issue's body.
    const patched: string[] = [];
    github.intercept({ method: "PATCH", path: `/repos/${REPO}/issues/60` }).reply(200, (options) => {
      const body = JSON.parse(String(options.body)) as { body: string };
      patched.push(body.body);
      return issue(60, body.body);
    });
    const updated = await call(access, "epic_update", { project: REPO, card: epic.id, rev: 1, document: "Doc 2.", technical: "Use a cron." });
    expect(updated.data["github_issue"]).toMatchObject({ number: 60, updated: true });
    expect(patched[0]).toContain("Use a cron.");

    // No technical text: nothing is sent to GitHub (no interceptor left pending).
    const quiet = await call(access, "epic_update", { project: REPO, card: epic.id, rev: 2, document: "Doc 3." });
    expect(quiet.data["github_issue"]).toBeUndefined();

    // GitHub refuses: said, and the card is still written.
    github.intercept({ method: "PATCH", path: `/repos/${REPO}/issues/60` }).reply(403, "{}");
    const refused = await call(access, "epic_update", { project: REPO, card: epic.id, rev: 3, document: "Doc 4.", technical: "x" });
    expect((refused.data["github_issue"] as { error: string }).error).toContain("refused");
    expect(refused.data).toMatchObject({ epic: { revision: 4 } });

    // An epic with no issue gets one on update.
    const bare = (await call(access, "epic_create", { project: REPO, title: "F11 Tests", document: "b" })).data["created"] as { id: number };
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues` }).reply(201, (options) => issue(61, (JSON.parse(String(options.body)) as { body: string }).body));
    const made = await call(access, "epic_update", { project: REPO, card: bare.id, rev: 1, technical: "How." });
    expect(made.data["github_issue"]).toMatchObject({ number: 61, created: true });

    // A refused creation leaves the card written.
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues` }).reply(422, "{}");
    const failed = await call(access, "epic_create", { project: REPO, title: "F12 X", document: "c", technical: "t" });
    expect((failed.data["github_issue"] as { error: string }).error).toContain("refused");
    expect(failed.data["created"]).toBeTruthy();
  });

  it("refuses to drop a card that a feature not in production needs (la-fabrique#302)", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");
    const needed = ((await call(access, "card_create", { project: REPO, title: "Needed", kind: "feature" })).data["created"] as { id: number }).id;
    const needing = ((await call(access, "card_create", { project: REPO, title: "Needing", kind: "feature" })).data["created"] as { id: number }).id;
    await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'depends', ?)").bind(needing, String(needed)).run();
    const refused = await call(access, "card_update", { project: REPO, card: needed, status: "dropped" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toContain(`C${needing}`);
    expect((await env.DB.prepare("SELECT status FROM cards WHERE id = ?").bind(needed).first<{ status: string }>())?.status).not.toBe("dropped");
    expect((await call(access, "card_update", { project: REPO, card: needing, status: "dropped" })).isError).toBe(false);
    expect((await call(access, "card_update", { project: REPO, card: needed, status: "dropped" })).isError).toBe(false);
  });

  it("attaches a feature to an epic, moves it, detaches it, and refuses what is not an epic", async () => {
    await seedProject();
    await grantRole("pe", "product_engineer");
    await grantRole("tester", "tester");
    const { access_token: access } = await connectClaude("pe");
    const one = (await call(access, "epic_create", { project: REPO, title: "F10 Docs", document: "a" })).data["created"] as { id: number };
    const two = (await call(access, "epic_create", { project: REPO, title: "F11 Tests", document: "b" })).data["created"] as { id: number };
    const epicOf = async (id: number) => (await env.DB.prepare("SELECT epic FROM cards WHERE id = ?").bind(id).first<{ epic: string | null }>())?.epic;

    const made = await call(access, "card_create", { project: REPO, title: "A feature", epic: one.id });
    expect(made.isError).toBe(false);
    const feature = (made.data["created"] as { id: number }).id;
    expect(await epicOf(feature)).toBe("F10 Docs");
    // The epic page's Features list reads the card links: they follow too.
    const linked = async () => (await env.DB.prepare("SELECT card_id FROM card_links WHERE kind = 'feature' AND ref = ?").bind(String(feature)).all<{ card_id: number }>()).results.map((r) => r.card_id);
    expect(await linked()).toEqual([one.id]);

    expect((await call(access, "card_update", { project: REPO, card: feature, epic: "F11 Tests" })).data).toMatchObject({ changed: ["epic"] });
    expect(await epicOf(feature)).toBe("F11 Tests");
    expect(await linked()).toEqual([two.id]);
    expect((await call(access, "card_update", { project: REPO, card: feature, epic: null })).data).toMatchObject({ changed: ["epic"] });
    expect(await epicOf(feature)).toBeNull();
    expect(await linked()).toEqual([]);

    await call(access, "card_update", { project: REPO, card: feature, epic: two.id });
    const notEpic = await call(access, "card_update", { project: REPO, card: feature, epic: feature });
    expect(notEpic.isError).toBe(true);
    expect((await call(access, "card_update", { project: REPO, card: feature, epic: "Nope" })).isError).toBe(true);
    expect((await call(access, "card_create", { project: REPO, title: "Other", epic: 9999 })).isError).toBe(true);
    expect((await call(access, "card_update", { project: REPO, card: two.id, epic: one.id })).isError).toBe(true);
    expect(await epicOf(feature)).toBe("F11 Tests");

    const { access_token: weak } = await connectClaude("tester");
    expect((await call(weak, "card_update", { project: REPO, card: feature, epic: one.id })).isError).toBe(true);
    expect(await epicOf(feature)).toBe("F11 Tests");
    const tools = (await logActions()).filter((entry) => entry.action === "mcp_write").map((entry) => JSON.parse(entry.details ?? "{}").tool);
    expect(tools).toContain("card_update");
  });

  it("refuses epic writes to a person who cannot write cards", async () => {
    await seedProject();
    await grantRole("tester", "tester");
    const { access_token: access } = await connectClaude("tester");
    const refused = await call(access, "epic_create", { project: REPO, title: "No", document: "x" });
    expect(refused.isError).toBe(true);
    expect((await call(access, "epic_update", { project: REPO, card: 1, rev: 1, document: "x" })).isError).toBe(true);
  });

  it("keeps an assistant's token and a project app's apart, and follows the role at each call", async () => {
    await grantRole("lead", "tech_lead");
    const { access_token: access } = await connectClaude("lead");
    expect((await me(access)).status).toBe(403);
    const tools = ((await rpc(access, "tools/list")).result?.["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(tools).toContain("launch_claude");
    // The role taken back: the next call is refused.
    await env.DB.prepare("DELETE FROM accounts WHERE github_login = 'lead'").run();
    expect((await call(access, "projects", {})).data["error"]).toContain("no longer has a role");

    const app = await connect("mona");
    const response = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${app.tokens.access_token}` }, body: "{}" });
    expect(response.status).toBe(403);
  });
});

describe("to_test", () => {
  const now = "2026-11-18T00:00:00.000Z";
  const story = (number: number, extra: Record<string, unknown> = {}) => ({
    number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: now, updatedAt: now, closedAt: null, pullRequests: [], branches: [], criteria: [], ...extra,
  });
  const seedStories = (stories: unknown[], production?: unknown) =>
    env.DB.batch([
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify(stories)),
      ...(production ? [env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify(production))] : []),
      env.DB.prepare("INSERT INTO cards (id, repo, kind, status, title, body, position, author) VALUES (17, ?, 'feature', 'validated', 'Plan the week', '', 1, 'pe')").bind(REPO),
      env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (17, 'story', '146')"),
    ]);

  it("lists the stories on int with their card and criteria, validated ones last, and is described as read only", async () => {
    const { addProject, CONFIG, INT_URL } = await import("./oauth-helpers");
    await addProject(CONFIG);
    await seedStories(
      [story(146, { criteria: [{ text: "It saves", done: true }, { text: "It shows", done: false }] }), story(147)],
      { production: "main", integration: "integration", integrationHead: "a", aheadBy: 1, groups: [{ branch: "f", title: "", mergedAt: now, commits: [], issues: [147, 146] }], workflows: [], versions: [], waiting: [], ready: true, blockers: [] },
    );
    await env.DB.prepare("INSERT INTO activity_log (occurred_at, actor, action, repo, issue_number, details) VALUES (?, 'tess', 'story_validated', ?, 146, '{\"version\":\"1.1\"}')").bind(now, REPO).run();
    await grantRole("tess", "tester");
    const { access_token: access } = await connectClaude("tess");

    const tools = (await rpc(access, "tools/list")).result?.["tools"] as { name: string; description: string; annotations: { readOnlyHint: boolean } }[];
    const tool = tools.find((entry) => entry.name === "to_test");
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(tool?.description).toContain("Use it before testing");

    const listed = await call(access, "to_test", { project: REPO });
    expect(listed.isError).toBe(false);
    expect(listed.data["environment"]).toEqual({ name: "int", url: INT_URL });
    const stories = listed.data["stories"] as { number: number; card: { ref: string } | null; criteria: unknown[]; validated: unknown }[];
    expect(stories.map((entry) => entry.number)).toEqual([147, 146]);
    expect(stories[1]?.card?.ref).toBe("C17");
    expect(stories[1]?.criteria).toEqual([{ index: 0, text: "It saves", checked: true }, { index: 1, text: "It shows", checked: false }]);
    expect(stories[0]?.validated).toBeNull();
  });

  it("lists the merged stories of a project without int, and says so when there is no environment", async () => {
    await seedProject({ nom: "Widget", langue: "en", environnements: { production: { url: "https://widget.example.com", version: "/v", type: "production" } } });
    await env.DB.prepare("DELETE FROM snapshots WHERE repo = ?").bind(REPO).run();
    await seedStories([story(146, { pullRequests: [{ number: 5, title: "x", state: "merged", url: "u", head: "b", base: "main", draft: false }] }), story(150)]);
    await grantRole("tess", "tester");
    const { access_token: access } = await connectClaude("tess");
    const listed = await call(access, "to_test", { project: REPO });
    expect((listed.data["environment"] as { name: string }).name).toBe("production");
    expect((listed.data["stories"] as { number: number }[]).map((entry) => entry.number)).toEqual([146]);
  });

  it("says the project has no environment to test on", async () => {
    await seedProject();
    await grantRole("tess", "tester");
    const { access_token: access } = await connectClaude("tess");
    const listed = await call(access, "to_test", { project: REPO });
    expect(listed.data["stories"]).toEqual([]);
    expect(listed.data["message"]).toContain("no environment to test on");
  });
});

describe("test_story", () => {
  const now = "2026-11-18T00:00:00.000Z";
  const J = { headers: { "content-type": "application/json" } };
  let issueBody = "";
  let labels: string[] = [];
  let comments: string[] = [];
  let patches = 0;

  beforeAll(() => {
    persistedGithub = true;
  });
  afterAll(() => {
    persistedGithub = false;
  });
  afterEach(() => {
    fetchMock.deactivate();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const story = (number: number) => ({
    number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [...labels], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: now, updatedAt: now, closedAt: null, pullRequests: [], branches: [], criteria: [],
  });

  // A GitHub that holds issue 146: reads, edits, comments, labels.
  function github(): void {
    const api = fetchMock.get("https://api.github.com");
    const issue = () => JSON.stringify({ number: 146, title: "Story 146", state: "open", html_url: "", labels: labels.map((name) => ({ name })), user: null, created_at: "", updated_at: "", closed_at: null, body: issueBody });
    api.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_x" }), J).persist();
    api.intercept({ method: "GET", path: `/repos/${REPO}/issues/146` }).reply(200, issue, J).persist();
    api.intercept({ method: "PATCH", path: `/repos/${REPO}/issues/146` }).reply(200, (options) => {
      patches++;
      issueBody = (JSON.parse(String(options.body)) as { body: string }).body;
      return issue();
    }, J).persist();
    api.intercept({ method: "POST", path: `/repos/${REPO}/issues/146/comments` }).reply(201, (options) => {
      comments.push((JSON.parse(String(options.body)) as { body: string }).body);
      return JSON.stringify({ html_url: `https://github.com/${REPO}/issues/146#issuecomment-${comments.length}` });
    }, J).persist();
    api.intercept({ method: "POST", path: `/repos/${REPO}/issues/146/labels` }).reply(200, (options) => {
      labels = [...new Set([...labels, ...(JSON.parse(String(options.body)) as { labels: string[] }).labels])];
      return "[]";
    }, J).persist();
  }

  async function setUp(role: "tester" | "tech_lead" = "tester", rework = false): Promise<string> {
    const { addProject, CONFIG } = await import("./oauth-helpers");
    await addProject(CONFIG);
    issueBody = "## Acceptance criteria\n\n- [ ] It saves\n- [ ] It shows\n";
    labels = rework ? ["rework"] : [];
    comments = [];
    patches = 0;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify([story(146)])),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, '2099-01-01T00:00:00.000Z')").bind(
        REPO,
        JSON.stringify({ production: "main", integration: "integration", integrationHead: "a", aheadBy: 1, groups: [{ branch: "f", title: "", mergedAt: now, commits: [], issues: [146] }], workflows: [], versions: [], waiting: [], ready: true, blockers: [] }),
      ),
    ]);
    await grantRole("tess", role);
    github();
    return (await connectClaude("tess")).access_token;
  }

  const logged = async () => (await logActions()).filter((entry) => entry.actor === "tess" && entry.action !== "assistant_connected");
  const verdicts = (...v: ("pass" | "fail")[]) => v.map((verdict, index) => ({ index, verdict, ...(verdict === "fail" ? { saw: `Saw nothing for ${index}` } : {}) }));

  it("checks every criterion and validates when all pass, marked via Claude, steps recorded", async () => {
    const access = await setUp();
    const result = await call(access, "test_story", {
      project: REPO,
      story: 146,
      verdicts: [
        { index: 0, verdict: "pass", steps: [{ kind: "page", page: "/app" }, { kind: "click", name: "Save", page: "/app" }] },
        { index: 1, verdict: "pass" },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.data["result"]).toBe("validated");
    expect(issueBody).toContain("- [x] It saves");
    expect(issueBody).toContain("- [x] It shows");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("Validated by @tess");
    expect(comments[0]).toContain("Tested by Claude through La Fabrique extraordinaire's MCP server, in @tess's name.");
    const entries = await logged();
    expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["criterion_checked", "story_test_recorded", "story_validated", "mcp_write"]));
    const recorded = entries.find((entry) => entry.action === "story_test_recorded");
    expect(JSON.parse(recorded?.details ?? "{}")).toMatchObject({ index: 0, via: "mcp", steps: [{ kind: "page" }, { kind: "click", name: "Save" }] });
    expect(entries.filter((entry) => entry.action === "story_test_recorded")).toHaveLength(1);
    for (const action of ["criterion_checked", "story_validated"]) expect(JSON.parse(entries.find((entry) => entry.action === action)?.details ?? "{}").via).toBe("mcp");
  });

  it("with one failure: checks the other, a feedback quoting the criterion, rework label, no validation", async () => {
    const access = await setUp();
    const result = await call(access, "test_story", { project: REPO, story: 146, verdicts: verdicts("pass", "fail") });
    expect(result.isError).toBe(false);
    expect(result.data["validated"]).toBe(false);
    expect(issueBody).toContain("- [x] It saves");
    expect(issueBody).toContain("- [ ] It shows");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("Criterion 2 fails: “It shows”");
    expect(comments[0]).toContain("> Saw nothing for 1");
    expect(comments[0]).toContain("Tested by Claude");
    expect(labels).toContain("rework");
    const entries = await logged();
    expect(entries.map((entry) => entry.action)).not.toContain("story_validated");
    expect(JSON.parse(entries.find((entry) => entry.action === "story_feedback")?.details ?? "{}").via).toBe("mcp");
  });

  it("with two failures: one feedback comment each", async () => {
    const access = await setUp();
    await call(access, "test_story", { project: REPO, story: 146, verdicts: verdicts("fail", "fail") });
    expect(comments).toHaveLength(2);
    expect(comments[0]).toContain("Criterion 1 fails");
    expect(comments[1]).toContain("Criterion 2 fails");
    expect(issueBody).not.toContain("[x]");
  });

  it("a feedback on the whole: one comment quoting no criterion, no validation, even if all pass", async () => {
    const access = await setUp();
    const result = await call(access, "test_story", { project: REPO, story: 146, verdicts: verdicts("pass", "pass"), feedback: "The page is slow" });
    expect(result.data["validated"]).toBe(false);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("The story fails.");
    expect(comments[0]).not.toContain("Criterion");
    expect(comments[0]).toContain("> The page is slow");
    expect(labels).toContain("rework");
    expect((await logged()).map((entry) => entry.action)).not.toContain("story_validated");
  });

  it("refuses, writing nothing: a story not to test, an unknown index, a missing verdict, feedback waiting for rework", async () => {
    const access = await setUp();
    const refused = async (args: Record<string, unknown>) => {
      const result = await call(access, "test_story", { project: REPO, ...args });
      expect(result.isError).toBe(true);
      return String(result.data["error"]);
    };
    expect(await refused({ story: 999, verdicts: verdicts("pass", "pass") })).toContain("not one of the stories to test");
    expect(await refused({ story: 146, verdicts: [...verdicts("pass", "pass"), { index: 5, verdict: "pass" }] })).toContain("no criterion 5");
    expect(await refused({ story: 146, verdicts: verdicts("pass") })).toContain("missing 1");
    expect(await refused({ story: 146, verdicts: [{ index: 0, verdict: "fail" }, { index: 1, verdict: "pass" }] })).toContain("what you saw");
    expect(comments).toHaveLength(0);
    expect(patches).toBe(0);
    expect(labels).toEqual([]);
    expect((await logged()).map((entry) => entry.action)).toEqual([]);
  });

  it("refuses to validate a story with feedback waiting for rework, as To test does", async () => {
    const access = await setUp("tester", true);
    const result = await call(access, "test_story", { project: REPO, story: 146, verdicts: verdicts("pass", "pass") });
    expect(result.isError).toBe(true);
    expect(String(result.data["error"])).toBe("This story has feedbacks: it is back in development until its code takes them into account.");
    expect(patches).toBe(0);
    expect(comments).toHaveLength(0);
  });

  it("refuses a role below tester and a project without a test environment, writing nothing", async () => {
    const access = await setUp();
    // The role is read again at each call: taken back, nothing is written.
    await env.DB.prepare("DELETE FROM accounts WHERE github_login = 'tess'").run();
    const denied = await call(access, "test_story", { project: REPO, story: 146, verdicts: verdicts("pass", "pass") });
    expect(denied.isError).toBe(true);
    expect(comments).toHaveLength(0);
    await grantRole("tess", "tester");
    await env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify({ nom: "Widget", langue: "en" }), REPO).run();
    const none = await call(access, "test_story", { project: REPO, story: 146, verdicts: verdicts("pass", "pass") });
    expect(none.isError).toBe(true);
    expect(String(none.data["error"])).toContain("no environment to test on");
    expect(patches).toBe(0);
  });

  it("gives no way to give the go", async () => {
    const access = await setUp();
    const tools = (await rpc(access, "tools/list")).result?.["tools"] as { name: string }[];
    expect(tools.map((tool) => tool.name).filter((name) => /promote|go$|deploy/.test(name))).toEqual([]);
  });
});

describe("MCP: run the sprint (sprint_run)", () => {
  const NOW = "2026-11-01T12:00:00.000Z";
  async function seedSprint(config: Record<string, unknown> = { nom: "Widget", workflows: { claude: "claude.yml", fusionner: "merge.yml" }, claude: { plafond: 2 } }): Promise<void> {
    const stories = [12, 13].map((number) => ({
      number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
      subTotal: 0, subCompleted: 0, createdAt: NOW, updatedAt: NOW, closedAt: null, pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }],
    }));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify(stories)),
      env.DB.prepare("INSERT INTO sprints (repo, release, started_by, started_at) VALUES (?, 'Sprint', 'pe', '2026-10-31T12:00:00.000Z')").bind(REPO),
    ]);
    const id = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 'Sprint', 1, 'pe') RETURNING id").bind(REPO).first<{ id: number }>())?.id ?? 0;
    await env.DB.batch([12, 13].map((number, index) => env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', ?, ?)").bind(id, String(number), index + 1)));
  }

  it("shows the plan with a fingerprint, starts nothing, then starts the run once confirmed, refusing a stale fingerprint and a second run", async () => {
    persistedGithub = true;
    await seedSprint();
    await grantRole("pe", "product_engineer");
    await grantRole("tester", "tester");
    const { access_token: access } = await connectClaude("pe");
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).persist();
    github.intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS).persist();
    github.intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` }).reply(204, "").persist();
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` }).reply(201, "{}", JSON_HEADERS).persist();

    const plan = await call(access, "sprint_run", { project: REPO });
    expect(plan.isError).toBe(false);
    expect(plan.data["started"]).toBe(false);
    const lanes = plan.data["lanes"] as { stories: { story: number; plan: string }[] }[][];
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.[0]?.stories.map((story) => [story.story, story.plan])).toEqual([[12, "launch"], [13, "launch"]]);
    const fingerprint = plan.data["fingerprint"] as string;
    expect(fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect((await logActions()).map((entry) => entry.action)).not.toContain("sprint_run_started");

    const stale = await call(access, "sprint_run", { project: REPO, confirm: true, fingerprint: "0".repeat(24) });
    expect(stale.isError).toBe(true);
    expect(stale.data["error"]).toContain("The plan changed: read it again");
    expect((await call(access, "sprint_run", { project: REPO, confirm: true })).isError).toBe(true);

    expect((await call(access, "sprint_run", { project: REPO, confirm: true, fingerprint })).data).toMatchObject({ started: true });
    const actions = await logActions();
    expect(actions.find((entry) => entry.action === "sprint_run_started")?.actor).toBe("pe");
    expect(actions.filter((entry) => entry.action === "mcp_write").map((entry) => JSON.parse(entry.details ?? "{}").tool)).toEqual(["sprint_run"]);

    const again = await call(access, "sprint_run", { project: REPO, confirm: true, fingerprint });
    expect(again.isError).toBe(true);
    expect(actions.filter((entry) => entry.action === "sprint_run_started")).toHaveLength(1);
    expect((await logActions()).filter((entry) => entry.action === "sprint_run_started")).toHaveLength(1);

    const { access_token: tester } = await connectClaude("tester");
    expect((await call(tester, "sprint_run", { project: REPO })).data["error"]).toContain("does not let you run the sprint");
  });

  it("refuses when the project declares no merge workflow", async () => {
    persistedGithub = true;
    await seedSprint({ nom: "Widget", workflows: { claude: "claude.yml" } });
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).persist();
    expect((await call(access, "sprint_run", { project: REPO })).data["error"]).toContain("workflows.fusionner");
  });

  it("says in its instructions what a run does and never does", async () => {
    await grantRole("pe", "product_engineer");
    const { access_token: access } = await connectClaude("pe");
    const instructions = String((await rpc(access, "initialize", { protocolVersion: "2025-11-25" })).result?.["instructions"]);
    expect(instructions).toContain("each merge puts the work online");
    expect(instructions).toContain("never closes the sprint");
  });
});
