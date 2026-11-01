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
