import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { summarize, type Run } from "../src/delivery";
import { duration } from "../src/delivery-views";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

function run(result: Run["result"], seconds: number | null, startedAt = "2026-10-29T10:00:00Z"): Run {
  return {
    workflow: "ci",
    title: "t",
    branch: "integration",
    sha: "abc",
    event: "push",
    result,
    conclusion: result === "success" ? "success" : result === "failure" ? "failure" : null,
    startedAt,
    seconds,
    url: "u",
  };
}

describe("Workflow summary", () => {
  it("computes the success rate, median duration of passed runs and current streak", () => {
    const summary = summarize("ci", "ci.yml", [
      run("running", null),
      run("failure", 50),
      run("failure", 40),
      run("success", 120),
      run("success", 100),
      run("success", 140),
    ]);
    expect(summary.runs).toBe(6);
    expect(summary.successRate).toBe(3 / 5);
    expect(summary.medianSeconds).toBe(120);
    expect(summary.streak).toEqual({ result: "failure", count: 2 });
    expect(summary.lastFailure?.seconds).toBe(50);
  });

  it("writes durations plainly", () => {
    expect([duration(null), duration(42), duration(125)]).toEqual(["—", "42 s", "2 min 05 s"]);
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function restRun(conclusion: string, started: string, seconds: number, branch = "integration") {
  return {
    name: "CI",
    display_title: "Intégration : feature/x",
    head_branch: branch,
    head_sha: "394e4ea0000",
    event: "push",
    status: "completed",
    conclusion,
    run_started_at: started,
    created_at: started,
    updated_at: new Date(Date.parse(started) + seconds * 1000).toISOString(),
    html_url: `https://github.com/${REPO}/actions/runs/${started}`,
  };
}

function today(hour: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour)).toISOString();
}

function mockRuns(): void {
  const github = fetchMock.get("https://api.github.com");
  github
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  github
    .intercept({ path: (path: string) => path.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?`) })
    .reply(
      200,
      JSON.stringify({
        workflow_runs: [restRun("failure", today(3), 60), restRun("success", today(2), 125), restRun("success", today(1), 115)],
      }),
      JSON_HEADERS,
    );
  github
    .intercept({ path: (path: string) => path.startsWith(`/repos/${REPO}/actions/workflows/deploy-int.yml/runs?`) })
    .reply(200, JSON.stringify({ workflow_runs: [restRun("success", today(2), 90)] }), JSON_HEADERS);
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify({ nom: "Widget", workflows: { ci: "ci.yml", deploiement_int: "deploy-int.yml", promouvoir: null } })),
  ]);
}

describe("Delivery tab", () => {
  it("shows each declared workflow's runs, success rate, median duration and streak", async () => {
    await seed();
    mockRuns();
    const page = await (await get(`/projects/${REPO}/delivery`, (await signIn("admin-one")).cookie)).text();

    expect(page).toContain("CI <code>ci.yml</code>");
    expect(page).toContain("Deployment to int <code>deploy-int.yml</code>");
    expect(page).toContain('<p class="tile-label">Passed</p><p class="tile-value mono">67%</p>');
    expect(page).toContain('<p class="tile-value mono">2 min 00 s</p>');
    expect(page).toContain("<strong>failed 1 time in a row</strong>");
    expect(page).toContain('class="run run-failure"');
    expect(page).toContain("Latest runs");
  });

  it("is visible to every role and served from the snapshot on the next view", async () => {
    await seed();
    mockRuns();
    await grantRole("qa", "tester");
    const { cookie } = await signIn("qa");
    expect((await get(`/projects/${REPO}/delivery`, cookie)).status).toBe(200);
    expect((await get(`/projects/${REPO}/delivery`, cookie)).status).toBe(200);
  });
});
