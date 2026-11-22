import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiCost, parseUsage, priceName, runCapability } from "../src/runner-runs";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

const github = () => fetchMock.get("https://api.github.com");

// What the workflow's Usage step writes, from Claude Code's execution file.
const USAGE = {
  v: 1,
  auth: "subscription",
  turns: 42,
  duration_ms: 612000,
  cost_usd: 1.234,
  models: {
    "claude-sonnet-5-5": { input: 1200, output: 34000, cache_read: 2_100_000, cache_write: 150_000, cost_usd: 1.1 },
    "claude-unknown-9": { input: 5000, output: 800, cache_read: 0, cache_write: 0, cost_usd: 0.25 },
  },
};

describe("A run's reported usage", () => {
  it("is read from the annotation, priced at the API's rates of each model, Claude Code's figure for a model La Fabrique does not price", () => {
    const usage = parseUsage(JSON.stringify(USAGE));
    expect(usage).toMatchObject({ auth: "subscription", turns: 42, duration_ms: 612000 });
    // Sonnet 5.5: 1200 × $2 + 34000 × $10 + 2.1M × $0.20 + 150k × $2.50 (cache writes), per million; then $0.25.
    expect(apiCost(usage!)).toBe(2400 + 340_000 + 420_000 + 375_000 + 250_000);
    expect(parseUsage("not json")).toBeNull();
    expect(parseUsage(JSON.stringify({ auth: "api", models: { m: { input: -3 } } }))?.models["m"]).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: null });
    expect(priceName("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5");
    expect(priceName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("says the capability from the run's name", () => {
    expect(runCapability("claude", "Claude #12")).toEqual({ capability: "code", story: 12, pull: null });
    expect(runCapability("claude", "Claude #12 · rework")).toEqual({ capability: "rework", story: 12, pull: null });
    expect(runCapability("claude", "Claude #12 · update #34")).toEqual({ capability: "update", story: 12, pull: 34 });
    expect(runCapability("claude", "Claude #12 · update #34 · review")).toEqual({ capability: "update", story: 12, pull: 34 });
    expect(runCapability("revue", "Review #34")).toEqual({ capability: "review", story: null, pull: 34 });
  });
});

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", workflows: { claude: "claude.yml", revue: "review.yml" } }),
    ),
  ]);
}

async function webhook(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return SELF.fetch("https://la-fabrique.test/api/github/webhook", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}` },
    body,
  });
}

const run = (action: string, id: number, path: string, title: string, conclusion: string | null) => ({
  action,
  repository: { full_name: REPO },
  workflow_run: {
    id,
    path,
    display_title: title,
    status: action === "completed" ? "completed" : "in_progress",
    conclusion,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    run_started_at: "2026-11-22T10:00:00Z",
    updated_at: "2026-11-22T10:12:00Z",
  },
});

// The run's one job and its annotations.
function annotations(runId: number, notes: { title: string; message: string; annotation_level: string }[]): void {
  github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
  github().intercept({ path: `/repos/${REPO}/actions/runs/${runId}/jobs` }).reply(200, JSON.stringify({ jobs: [{ id: runId * 10 }] }), JSON_HEADERS);
  github().intercept({ path: `/repos/${REPO}/check-runs/${runId * 10}/annotations` }).reply(200, JSON.stringify(notes), JSON_HEADERS);
}

describe("Claude's runs in the project's runner", () => {
  it("are followed as they run, counted when they end, and shown per capability", async () => {
    await seed();
    // Running: recorded, nothing read on GitHub yet.
    expect((await webhook("workflow_run", run("in_progress", 501, ".github/workflows/claude.yml", "Claude #12 · update #34", null))).status).toBe(200);
    expect(await env.DB.prepare("SELECT capability, story, pull, status FROM runner_runs WHERE run_id = 501").first()).toEqual({ capability: "update", story: 12, pull: 34, status: "in_progress" });

    // Ended: the usage the run reported, priced.
    annotations(501, [
      { title: "Something else", message: "x", annotation_level: "notice" },
      { title: "Claude usage", message: JSON.stringify(USAGE), annotation_level: "notice" },
    ]);
    expect((await webhook("workflow_run", run("completed", 501, ".github/workflows/claude.yml", "Claude #12 · update #34", "success"))).status).toBe(200);
    const row = await env.DB.prepare("SELECT status, conclusion, auth, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, api_cost_micros, real_cost_micros, turns FROM runner_runs WHERE run_id = 501").first();
    expect(row).toEqual({
      status: "completed",
      conclusion: "success",
      auth: "subscription",
      input_tokens: 6200,
      output_tokens: 34800,
      cache_read_tokens: 2_100_000,
      cache_write_tokens: 150_000,
      api_cost_micros: 1_387_400,
      real_cost_micros: 0,
      turns: 42,
    });
    const logged = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'runner_run_counted'").first<{ issue_number: number; details: string }>();
    expect(logged?.issue_number).toBe(12);
    expect(JSON.parse(logged?.details ?? "{}")).toMatchObject({ run: 501, capability: "update", auth: "subscription", api_cost_micros: 1_387_400 });

    // A review on an API key; an older workflow that reports nothing.
    annotations(502, [{ title: "Claude usage", message: JSON.stringify({ ...USAGE, auth: "api", models: { "claude-sonnet-5-5": { input: 1000, output: 1000, cache_read: 0, cache_write: 0 } } }), annotation_level: "notice" }]);
    await webhook("workflow_run", run("completed", 502, ".github/workflows/review.yml", "Review #34", "failure"));
    expect(await env.DB.prepare("SELECT capability, pull, auth, api_cost_micros, real_cost_micros FROM runner_runs WHERE run_id = 502").first()).toEqual({
      capability: "review",
      pull: 34,
      auth: "api",
      api_cost_micros: 12_000,
      real_cost_micros: 12_000,
    });
    annotations(503, []);
    await webhook("workflow_run", run("completed", 503, ".github/workflows/review.yml", "Review #35", "failure"));
    expect(await env.DB.prepare("SELECT auth, api_cost_micros FROM runner_runs WHERE run_id = 503").first()).toEqual({ auth: null, api_cost_micros: null });

    // Another workflow is not a run of Claude.
    await webhook("workflow_run", run("completed", 504, ".github/workflows/ci.yml", "CI", "success"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runner_runs").first()).toEqual({ n: 3 });

    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/capabilities`, cookie)).text();
    expect(page).toMatch(/<tr id="update">[\s\S]*?<span class="mono">1<\/span> run · <span class="mono">\$1\.39<\/span> <span class="muted small">at API rates<\/span>[\s\S]*?156\.2k new in, 2\.1M read from cache, 34\.8k out[\s\S]*?All on the subscription/);
    expect(page).toMatch(/<tr id="review">[\s\S]*?<span class="mono">2<\/span> runs · <span class="mono">\$0\.01<\/span>[\s\S]*?Paid on the API[\s\S]*?1 without reported usage/);
    expect(page).toMatch(/<tr id="code">[\s\S]*?No run yet/);
  });
});
