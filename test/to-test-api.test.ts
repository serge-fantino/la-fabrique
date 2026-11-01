import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProductionStatus } from "../src/production";
import { BASE, get, grantRole, signIn } from "./helpers";
import { authorizePath, CONFIG, connect, INT_URL, me, mockRepoAccess, REPO, registerApp, addProject } from "./oauth-helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function story(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Story ${number}`,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: 140,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    pullRequests: [],
    branches: [],
    criteria: [],
    ...extra,
  };
}

async function seed(): Promise<void> {
  const production: ProductionStatus = {
    production: "main",
    integration: "integration",
    integrationHead: "abc",
    aheadBy: 1,
    groups: [{ branch: "feature/1", title: "", mergedAt: "2026-10-30T08:00:00Z", commits: [], issues: [146, 147, 140, 148] }],
    workflows: [],
    versions: [],
    waiting: [],
    ready: true,
    blockers: [],
  };
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(production), now),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
      REPO,
      JSON.stringify([
        story(140, { parent: null, subTotal: 3 }),
        story(146, { criteria: [{ text: "It saves", done: true }, { text: "It shows", done: false }] }),
        story(147),
        story(148, { labels: ["bug"] }),
      ]),
      now,
    ),
    env.DB.prepare(
      "INSERT INTO activity_log (occurred_at, actor, action, repo, issue_number, details) VALUES (?, 'tess', 'story_validated', ?, 147, '{\"version\":\"1.170\"}')",
    ).bind(now, REPO),
    env.DB.prepare("INSERT INTO cards (id, repo, kind, status, title, body, position, author) VALUES (17, ?, 'feature', 'validated', 'Plan the week', '', 1, 'pe')").bind(REPO),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (17, 'story', '146')"),
  ]);
}

const SCOPES = "defects:report stories:test";

function call(accessToken: string, query = ""): Promise<Response> {
  return SELF.fetch(`${BASE}/api/projects/widget/to-test${query}`, { headers: { authorization: `Bearer ${accessToken}` } });
}

describe("The stories to test, for the project's app", () => {
  it("lists the stories on int with their card, criteria and validation, for a tester; epics and defects are left out", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    expect(tokens.scope).toBe(SCOPES);
    await seed();
    const response = await call(tokens.access_token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stories: [
        {
          number: 146,
          title: "Story 146",
          url: `https://github.com/${REPO}/issues/146`,
          card: { id: 17, title: "Plan the week" },
          criteria: [{ text: "It saves", done: true }, { text: "It shows", done: false }],
          validated: null,
        },
        {
          number: 147,
          title: "Story 147",
          url: `https://github.com/${REPO}/issues/147`,
          card: null,
          criteria: [],
          validated: { by: "tess", at: expect.any(String), version: "1.170" },
        },
      ],
    });
    const who = (await (await me(tokens.access_token)).json()) as { can: { test_stories: boolean } };
    expect(who.can.test_stories).toBe(true);
  });

  it("refuses a person who may not validate, an app not allowed the scope, and production", async () => {
    // No role: a defect reporter only.
    const plain = await connect("mona", CONFIG, SCOPES);
    expect((await call(plain.tokens.access_token)).status).toBe(403);
    expect(((await (await me(plain.tokens.access_token)).json()) as { can: { test_stories: boolean } }).can.test_stories).toBe(false);
  });

  it("refuses an app that asked only for defects:report", async () => {
    const { tokens } = await connect("mona");
    await grantRole("mona", "tester");
    expect(tokens.scope).toBe("defects:report");
    const response = await call(tokens.access_token);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("insufficient_scope");
    expect(((await (await me(tokens.access_token)).json()) as { can: { test_stories: boolean } }).can.test_stories).toBe(false);
  });

  it("never answers for production or an environment closed to the app", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    await seed();
    expect((await call(tokens.access_token, "?environment=production")).status).toBe(403);
    expect((await call(tokens.access_token, "?environment=nowhere")).status).toBe(403);
    expect((await call(tokens.access_token, "?environment=int")).status).toBe(200);
    const onlyProduction = { ...CONFIG, environnements: { production: { url: "https://widget.example.com", version: "/api/version", type: "production" } } };
    await env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify(onlyProduction), REPO).run();
    expect((await call(tokens.access_token)).status).toBe(403);
  });

  it("refuses another project than the connection's", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    const other = await SELF.fetch(`${BASE}/api/projects/other/to-test`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(other.status).toBe(403);
  });
});

describe("The consent page and the scope", () => {
  it("says what stories:test allows, and Connected apps shows it", async () => {
    await addProject();
    const app = await registerApp();
    const { cookie } = await signIn("mona");
    mockRepoAccess();
    const page = await (await get(await authorizePath(app.clientId, SCOPES), cookie)).text();
    expect(page).toContain("show you the stories to test");
    expect(page).toContain("stories:test");
    mockRepoAccess();
    const plain = await (await get(await authorizePath(app.clientId), cookie)).text();
    expect(plain).not.toContain("stories to test");
  });

  it("lists the connection's scopes in Connected apps", async () => {
    const { cookie } = await connect("mona", CONFIG, SCOPES);
    const apps = await (await get("/apps", cookie)).text();
    expect(apps).toContain("defects:report stories:test");
  });
});

void INT_URL;

describe("Tick, validate from the app (la-fabrique#166)", () => {
  const J = { headers: { "content-type": "application/json" } };
  let issueBody = "";

  function github() {
    return fetchMock.get("https://api.github.com");
  }

  // The issue as GitHub holds it: PATCH changes it, GET reads it.
  function mockIssue(number: number, text: string, times: { token: number; get: number; patch: number }): void {
    issueBody = text;
    const issue = () => JSON.stringify({ number, title: `Story ${number}`, state: "open", html_url: "", labels: [], user: null, created_at: "", updated_at: "", closed_at: null, body: issueBody });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_x" }), J).times(times.token);
    github().intercept({ method: "GET", path: `/repos/${REPO}/issues/${number}` }).reply(200, issue, J).times(times.get);
    if (!times.patch) return;
    github()
      .intercept({ method: "PATCH", path: `/repos/${REPO}/issues/${number}` })
      .reply(200, (options) => {
        issueBody = (JSON.parse(String(options.body)) as { body: string }).body;
        return issue();
      }, J)
      .times(times.patch);
  }

  function act(token: string, story: number, action: string, body?: unknown): Promise<Response> {
    return SELF.fetch(`${BASE}/api/projects/widget/to-test/${story}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
  }

  async function logged(): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT actor, action FROM activity_log ORDER BY id").all<{ actor: string; action: string }>();
    return results.map((row) => `${row.actor}:${row.action}`);
  }

  it("ticks a criterion in the issue, logs it, and To test then shows it", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    await seed();
    mockIssue(146, "## Need\n\nx\n\n## Acceptance criteria\n\n- [x] It saves\n- [ ] It shows\n", { token: 8, get: 6, patch: 2 });
    const response = await act(tokens.access_token, 146, "criteria", { index: 1, done: true });
    expect(response.status).toBe(200);
    expect(issueBody).toContain("- [x] It shows");
    expect(await logged()).toContain("mona:criterion_checked");
    const list = (await (await call(tokens.access_token)).json()) as { stories: { number: number; criteria: { done: boolean }[] }[] };
    expect(list.stories.find((s) => s.number === 146)?.criteria.map((c) => c.done)).toEqual([true, true]);
    const untick = await act(tokens.access_token, 146, "criteria", { index: 1, done: false });
    expect(untick.status).toBe(200);
    expect(issueBody).toContain("- [ ] It shows");
    expect(await logged()).toContain("mona:criterion_unchecked");
  });

  it("refuses a bad criterion, a story not to test, a missing scope and a person who may not validate", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await seed();
    expect((await act(tokens.access_token, 146, "criteria", { index: 0, done: true })).status).toBe(403);
    await grantRole("mona", "tester");
    mockIssue(146, "## Acceptance criteria\n\n- [ ] It saves\n", { token: 1, get: 1, patch: 0 });
    const r5 = await act(tokens.access_token, 146, "criteria", { index: 5, done: true });
    expect(r5.status).toBe(422);
    expect((await act(tokens.access_token, 146, "criteria", { index: "0", done: true })).status).toBe(400);
    expect((await act(tokens.access_token, 140, "criteria", { index: 0, done: true })).status).toBe(404);
    expect((await act(tokens.access_token, 148, "validate")).status).toBe(404);
    const get = await SELF.fetch(`${BASE}/api/projects/widget/to-test/146/validate`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(get.status).toBe(405);
    expect(issueBody).toBe("## Acceptance criteria\n\n- [ ] It saves\n");
  });

  it("refuses an app without the stories:test scope", async () => {
    const { tokens } = await connect("mona");
    await grantRole("mona", "tester");
    await seed();
    const response = await act(tokens.access_token, 146, "validate");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("refuses to validate before every criterion is ticked, validates after, and logs it", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    await seed();
    mockIssue(146, "## Acceptance criteria\n\n- [x] It saves\n- [ ] It shows\n", { token: 7, get: 5, patch: 1 });
    const refused = await act(tokens.access_token, 146, "validate");
    expect(refused.status).toBe(422);
    expect(await logged()).not.toContain("mona:story_validated");
    await act(tokens.access_token, 146, "criteria", { index: 1, done: true });
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/146/comments` })
      .reply(201, (options) => {
        comment = String(options.body);
        return "{}";
      }, J);
    const done = await act(tokens.access_token, 146, "validate");
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, validated: true });
    expect(comment).toContain("mona");
    expect(await logged()).toContain("mona:story_validated");
    const list = (await (await call(tokens.access_token)).json()) as { stories: { number: number; validated: { by: string } | null }[] };
    expect(list.stories.find((s) => s.number === 146)?.validated?.by).toBe("mona");
  });

  it("keeps the recorded steps with the criterion, the story, the version and the tester, without any value", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    await seed();
    mockIssue(146, "## Acceptance criteria\n\n- [x] It saves\n- [ ] It shows\n", { token: 4, get: 3, patch: 1 });
    const steps = [
      { kind: "page", page: "https://app.example/orders?token=secret#x" },
      { kind: "fill", name: "Password", page: "/login", value: "hunter2" },
      { kind: "click", name: "Save", page: "/orders" },
      { kind: "bogus", name: "x" },
    ];
    const response = await act(tokens.access_token, 146, "criteria", { index: 1, done: true, steps });
    expect(response.status).toBe(200);
    expect(await logged()).toContain("mona:story_test_recorded");
    const row = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'story_test_recorded'").first<{ issue_number: number; details: string }>();
    expect(row?.issue_number).toBe(146);
    expect(row?.details).not.toContain("hunter2");
    expect(row?.details).not.toContain("secret");
    const details = JSON.parse(row?.details ?? "{}") as { index: number; text: string; steps: { kind: string; name: string; page: string }[] };
    expect(details.index).toBe(1);
    expect(details.text).toBe("It shows");
    expect(details.steps).toEqual([
      { kind: "page", name: "", page: "/orders" },
      { kind: "fill", name: "Password", page: "/login" },
      { kind: "click", name: "Save", page: "/orders" },
    ]);
  });

  it("refuses steps that are not a list", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    await seed();
    expect((await act(tokens.access_token, 146, "criteria", { index: 0, done: true, steps: "click" })).status).toBe(400);
  });
});
