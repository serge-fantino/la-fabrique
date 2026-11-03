import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { testEnvironmentOf } from "../src/defects";
import type { Environment } from "../src/fabrique-config";
import { BASE, grantRole } from "./helpers";
import { CONFIG, connect, me, REPO } from "./oauth-helpers";

// Reporting and testing apart (la-fabrique#209, #210): who may report from
// each environment, production included; the stories are tested on the
// test environment, production for a project without int.
const PROD_URL = "https://widget.example.com";
const J = { headers: { "content-type": "application/json" } };
const SCOPES = "defects:report stories:test";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function story(number: number, extra: Record<string, unknown> = {}) {
  return {
    number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }], ...extra,
  };
}

// A project without int: production only, open to its team's reports.
const ONLY_PRODUCTION = { ...CONFIG, environnements: { production: { url: PROD_URL, version: "/api/version", type: "production", signalement: "equipe" } } };

async function useConfig(config: Record<string, unknown>): Promise<void> {
  await env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify(config), REPO).run();
}

async function seedStories(): Promise<void> {
  const merged = [{ number: 30, url: `https://github.com/${REPO}/pull/30`, state: "merged" }];
  await env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)")
    .bind(
      REPO,
      JSON.stringify([
        story(150, { pullRequests: merged }),
        story(151, { pullRequests: merged, labels: ["rework"] }),
        story(152),
        story(153, { pullRequests: merged, labels: ["bug"] }),
      ]),
      new Date().toISOString(),
    )
    .run();
}

const report = (token: string, environment: string) =>
  SELF.fetch(`${BASE}/api/projects/widget/defects`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Broken", seen: "It breaks.", environment, version: "0.81", page: "/" }),
  });

describe("The test environment (la-fabrique#209)", () => {
  const environments: Record<string, Environment> = {
    int: { url: "https://int.example", type: "integration" },
    production: { url: "https://example", type: "production" },
  };

  it("is the one `recette` names, else the integration one, else production without an integration branch", () => {
    expect(testEnvironmentOf({ nom: "W", recette: { environnement: "production" } }, environments)).toBe("production");
    expect(testEnvironmentOf({ nom: "W" }, environments)).toBe("int");
    expect(testEnvironmentOf({ nom: "W" }, { production: { url: "https://example" } })).toBe("production");
    expect(testEnvironmentOf({ nom: "W", branches: { integration: "integration" } }, { production: { url: "https://example", type: "production" } })).toBeNull();
  });
});

describe("Who may report from an environment (la-fabrique#209)", () => {
  it("opens production to the team only when it says equipe", async () => {
    const { tokens } = await connect("nora", CONFIG, SCOPES);
    await useConfig(ONLY_PRODUCTION);
    // No role: nothing to do from the app.
    expect(((await (await me(tokens.access_token)).json()) as { can: unknown }).can).toEqual({ report_defect: false, test_stories: false });
    expect((await report(tokens.access_token, "production")).status).toBe(403);

    await grantRole("nora", "tester");
    expect(((await (await me(tokens.access_token)).json()) as { can: unknown }).can).toEqual({ report_defect: true, test_stories: true });
    fetchMock.get(PROD_URL).intercept({ path: "/api/version" }).reply(200, JSON.stringify({ numero: "0.81", environnement: "production" }), J);
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), J);
    let labels: string[] = [];
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues` }).reply(201, (options) => {
      labels = (JSON.parse(String(options.body)) as { labels: string[] }).labels;
      return JSON.stringify({ number: 160, title: "Broken", state: "open", html_url: `https://github.com/${REPO}/issues/160`, user: null, labels: [], created_at: "", updated_at: "", closed_at: null, body: "" });
    }, J);
    expect((await report(tokens.access_token, "production")).status).toBe(201);
    expect(labels).toEqual(["bug"]);
  });
});

describe("Testing on the test environment, even production (la-fabrique#210)", () => {
  it("lists the stories merged and still open, and those back in development, on a project without int", async () => {
    const { tokens } = await connect("mona", CONFIG, SCOPES);
    await grantRole("mona", "tester");
    await useConfig(ONLY_PRODUCTION);
    await seedStories();
    const response = await SELF.fetch(`${BASE}/api/projects/widget/to-test`, { headers: { authorization: `Bearer ${tokens.access_token}`, "x-fabrique-environment": "production" } });
    expect(response.status).toBe(200);
    const { stories } = (await response.json()) as { stories: { number: number; rework: boolean }[] };
    expect(stories.map((entry) => [entry.number, entry.rework])).toEqual([
      [150, false],
      [151, true],
    ]);
  });
});
