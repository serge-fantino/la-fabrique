import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";
import { challenge, connect, me, token, VERIFIER, type Tokens } from "./oauth-helpers";

const REPO = "acme/widget";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

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
      "card_update",
    ]);
    expect(actions.find((entry) => entry.action === "card_created")?.actor).toBe("pe");
    expect(actions.find((entry) => entry.action === "assistant_connected")?.actor).toBe("pe");
    const log = await (await get(`/projects/${REPO}/log`, (await signIn("pe")).cookie)).text();
    expect(log).toContain("through Claude");
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
