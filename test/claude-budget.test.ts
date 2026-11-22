import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchClaude } from "../src/claude";
import { budgetState, levelOf, monthStart } from "../src/claude-budget";
import { validateFabriqueConfig } from "../src/fabrique-config";
import { findProject } from "../src/projects";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(claude: Record<string, unknown>, spent: { runs: number; calls: number; old?: number }): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", workflows: { claude: "claude.yml" }, claude }),
    ),
    env.DB.prepare("INSERT INTO runner_runs (run_id, repo, workflow, capability, status, finished_at, api_cost_micros) VALUES (1, ?, 'claude', 'code', 'completed', ?, ?)").bind(REPO, now, spent.runs),
    // Last month's run does not count.
    env.DB.prepare("INSERT INTO runner_runs (run_id, repo, workflow, capability, status, finished_at, api_cost_micros) VALUES (2, ?, 'claude', 'code', 'completed', '2000-01-15T00:00:00Z', ?)").bind(REPO, spent.old ?? 0),
    env.DB.prepare("INSERT INTO llm_calls (login, repo, purpose, cost_micros, outcome, at) VALUES ('pe', ?, 'spec_draft', ?, 'ok', ?)").bind(REPO, spent.calls, now),
  ]);
}

describe("A project's monthly budget for Claude", () => {
  it("is declared in .fabrique.json > claude.budget, in dollars a month", () => {
    const tree = { files: new Set([".fabrique.json"]), folders: new Set<string>(), complete: true };
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", claude: { plafond: 2, budget: 50 } }), tree).config?.claude).toEqual({ plafond: 2, budget: 50 });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", claude: { budget: 0 } }), tree).errors[0]).toMatch(/^`claude.budget` must be dollars per month/);
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", claude: { budget: "50" } }), tree).errors[0]).toMatch(/^`claude.budget`/);
  });

  it("warns past 80 % and is spent at 100 %", () => {
    expect(levelOf(10_000_000, null)).toEqual({ share: null, level: "none" });
    expect(levelOf(39_000_000, 50).level).toBe("ok");
    expect(levelOf(40_000_000, 50).level).toBe("warn");
    expect(levelOf(50_000_000, 50).level).toBe("over");
    expect(monthStart(new Date("2026-11-22T10:00:00Z"))).toBe("2026-11-01T00:00:00.000Z");
  });

  it("counts this month's runs in the runner and La Fabrique's own calls, at API rates", async () => {
    await seed({ budget: 50 }, { runs: 30_000_000, calls: 12_000_000, old: 99_000_000 });
    const project = (await findProject(env.DB, REPO))!;
    expect(await budgetState(env, project)).toMatchObject({ budgetUsd: 50, spentMicros: 42_000_000, level: "warn" });
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/capabilities`, cookie)).text();
    expect(page).toMatch(/<p class="notice budget" role="status">This month: <span class="mono">\$42\.00<\/span> of <span class="mono">\$50<\/span> \(84 %\)/);
  });

  it("past it, refuses a launch by itself, not a tech lead's launch by hand", async () => {
    await seed({ budget: 10 }, { runs: 9_000_000, calls: 2_000_000 });
    const project = (await findProject(env.DB, REPO))!;
    const refused = await launchClaude(env, project, "pe", 12);
    expect(refused).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("This month's Claude budget is spent: $11.00 at API rates of $10") });
    // By hand, the budget does not stop it: the launch goes on to GitHub (here, the project's cap).
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(200, JSON.stringify({ workflow_runs: [{ status: "in_progress" }, { status: "queued" }] }), JSON_HEADERS);
    expect(await launchClaude(env, project, "tl", 12, { byHand: true })).toMatchObject({ ok: false, message: expect.stringContaining("Claude already runs 2 times") });
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/capabilities`, cookie)).text();
    expect(page).toMatch(/<p class="notice error budget" role="status">This month(&#39;|')s budget is spent/);
  });

  it("without a budget, refuses nothing and still says the month's cost", async () => {
    await seed({}, { runs: 500_000_000, calls: 0 });
    const project = (await findProject(env.DB, REPO))!;
    expect((await budgetState(env, project)).level).toBe("none");
    const { cookie } = await signIn("admin-one");
    expect(await (await get(`/projects/${REPO}/capabilities`, cookie)).text()).toContain("No monthly budget: <code>claude.budget</code>");
  });
});
