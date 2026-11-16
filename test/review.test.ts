import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseReviewMarker, reviewInputs, reviewStates } from "../src/review";
import { reviewSettings } from "../src/review-settings";
import { reviewPill } from "../src/review-views";
import { logActions } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

async function seed(revue: Record<string, unknown>): Promise<void> {
  const config = { nom: "Widget", workflows: { revue: "review.yml" }, revue };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
  ]);
}

function github() {
  return fetchMock.get("https://api.github.com");
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

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("the review's inputs and verdict (la-fabrique#378, #380)", () => {
  it("passes the settings to the workflow in the keys of .fabrique.json, defaults filled in", () => {
    expect(JSON.parse(reviewInputs(reviewSettings({ modele: "claude-sonnet-5-5", focus: { performance: "off" } })))).toEqual({
      modele: "claude-sonnet-5-5",
      exigence: "souple",
      max_remarques: 5,
      focus: { securite: "bloquant", architecture: "conseil", performance: "off", craftsmanship: "off", compliance: "off" },
      consignes: "",
    });
  });

  it("reads the marker of the workflow's review, a finding's text escaped", () => {
    const body = `### Review by Claude: Blocking\n\n<!-- fabrique-review {"verdict":"bloquant","summary":"s","findings":[{"area":"securite","level":"bloquant","file":"src/a.ts","line":3,"text":"x --\\u003e y"},{"area":"performance","level":"conseil","text":"slow"},{"text":""}],"model":null,"exigence":"souple","sha":"f00"} -->`;
    expect(parseReviewMarker(body)).toEqual({
      verdict: "bloquant",
      summary: "s",
      findings: [
        { area: "securite", level: "bloquant", file: "src/a.ts", line: 3, text: "x --> y" },
        { area: "performance", level: "conseil", file: null, line: null, text: "slow" },
      ],
      model: null,
      sha: "f00",
    });
    expect(parseReviewMarker("a human review")).toBeNull();
    expect(parseReviewMarker('<!-- fabrique-review {"verdict":"maybe"} -->')).toBeNull();
    expect(parseReviewMarker("<!-- fabrique-review {broken} -->")).toBeNull();
  });

  it("says where each pull request's review stands: running, its verdict, an older commit, failed", () => {
    const row = (action: string, pull: number, at: string, details: Record<string, unknown> = {}) => ({ occurred_at: at, actor: "lead", action, issue_number: pull, details: JSON.stringify(details) });
    const now = Date.parse("2026-11-16T12:00:00Z");
    const states = reviewStates(
      [
        row("review_launched", 1, "2026-11-16 11:50:00"),
        row("review_launched", 2, "2026-11-16 11:00:00"),
        row("review_finished", 2, "2026-11-16 11:10:00", { verdict: "bloquant", sha: "old", blocking: 1, advice: 2, url: "https://github.com/acme/widget/pull/2#r1" }),
        row("review_finished", 3, "2026-11-16 11:10:00", { verdict: "remarques", sha: "head3", advice: 2 }),
        row("review_launched", 4, "2026-11-16 10:00:00"),
        row("review_finished", 5, "2026-11-16 11:10:00", { verdict: "failed", run: "https://github.com/acme/widget/actions/runs/9" }),
      ],
      new Map([[2, "new"], [3, "head3"]]),
      now,
    );
    expect(states.get(1)).toEqual({ state: "running", at: "2026-11-16 11:50:00", by: "lead" });
    expect(states.get(2)).toMatchObject({ state: "bloquant", blocking: 1, stale: true });
    expect(states.get(3)).toMatchObject({ state: "remarques", advice: 2, stale: false });
    // Started long ago and never finished (cancelled by hand): no state.
    expect(states.has(4)).toBe(false);
    expect(states.get(5)).toMatchObject({ state: "failed" });

    expect(reviewPill(states.get(1))).toContain("Review running");
    expect(reviewPill(states.get(2))).toContain('href="https://github.com/acme/widget/pull/2#r1"');
    expect(reviewPill(states.get(2))).toContain("Review blocking: 1");
    expect(reviewPill(states.get(2))).toContain("older commit");
    expect(reviewPill(states.get(3))).toContain("Review: 2 remarks");
    expect(reviewPill(states.get(5))).toContain("Review failed");
  });
});

describe("every pull request reviewed when the review is on (la-fabrique#379)", () => {
  const pull = { number: 30, draft: false, state: "open", merged_at: null, body: "Refs #12", head: { ref: "claude/12-x", sha: "c0ffee" } };

  it("starts the project's review workflow on an opened pull request, by La Fabrique, with the settings", async () => {
    await seed({ active: true, modele: "claude-sonnet-5-5" });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    let dispatched: { ref: string; inputs: Record<string, string> } | null = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/review.yml/dispatches` })
      .reply(204, (options) => {
        dispatched = JSON.parse(String(options.body));
        return "";
      });
    expect((await webhook("pull_request", { action: "opened", repository: { full_name: REPO }, pull_request: pull })).status).toBe(200);
    expect(dispatched).toMatchObject({ ref: "main", inputs: { pr: "30", par: "la-fabrique" } });
    expect(JSON.parse(dispatched!.inputs["reglages"] ?? "{}")).toMatchObject({ modele: "claude-sonnet-5-5", exigence: "souple" });
    const launched = (await logActions()).find((entry) => entry.action === "review_launched");
    expect(launched?.actor).toBe("la-fabrique");
    expect(JSON.parse(launched?.details ?? "{}")).toMatchObject({ pull: 30, trigger: "auto", sha: "c0ffee", model: "claude-sonnet-5-5" });
  });

  it("leaves a draft, a closed pull request and a project whose review is off alone", async () => {
    await seed({ active: true });
    expect((await webhook("pull_request", { action: "opened", repository: { full_name: REPO }, pull_request: { ...pull, draft: true } })).status).toBe(200);
    expect((await webhook("pull_request", { action: "closed", repository: { full_name: REPO }, pull_request: { ...pull, state: "closed" } })).status).toBe(200);
    await env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify({ nom: "Widget", workflows: { revue: "review.yml" }, revue: { active: false } }), REPO).run();
    expect((await webhook("pull_request", { action: "synchronize", repository: { full_name: REPO }, pull_request: pull })).status).toBe(200);
    expect((await logActions()).some((entry) => entry.action.startsWith("review_"))).toBe(false);
  });

  it("logs GitHub's refusal and still answers the webhook", async () => {
    await seed({ active: true });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github().intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/review.yml/dispatches` }).reply(404, "{}", JSON_HEADERS);
    expect((await webhook("pull_request", { action: "ready_for_review", repository: { full_name: REPO }, pull_request: pull })).status).toBe(200);
    const refused = (await logActions()).find((entry) => entry.action === "review_launch_refused");
    expect(JSON.parse(refused?.details ?? "{}").reason).toContain("no such workflow on main");
  });
});

describe("the end of a review run (la-fabrique#380)", () => {
  const run = { id: 7, path: ".github/workflows/review.yml", display_title: "Review #30", conclusion: "success", html_url: "https://github.com/acme/widget/actions/runs/7", run_started_at: "2026-11-16T10:00:00Z" };

  it("logs the verdict read from the review the workflow posted", async () => {
    await seed({ active: true });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/pulls/30/reviews?per_page=100` })
      .reply(
        200,
        JSON.stringify([
          { id: 1, body: "Looks good", html_url: "https://github.com/acme/widget/pull/30#r1", commit_id: "a", submitted_at: "2026-11-16T09:00:00Z" },
          {
            id: 2,
            body: '<!-- fabrique-review {"verdict":"remarques","summary":"","findings":[{"area":"performance","level":"conseil","text":"slow"}],"model":"claude-sonnet-5-5","sha":"c0ffee"} -->',
            html_url: "https://github.com/acme/widget/pull/30#r2",
            commit_id: "c0ffee",
            submitted_at: "2026-11-16T10:05:00Z",
          },
        ]),
        JSON_HEADERS,
      );
    expect((await webhook("workflow_run", { action: "completed", repository: { full_name: REPO }, workflow_run: run })).status).toBe(200);
    const finished = (await logActions()).find((entry) => entry.action === "review_finished");
    expect(JSON.parse(finished?.details ?? "{}")).toEqual({
      verdict: "remarques",
      model: "claude-sonnet-5-5",
      sha: "c0ffee",
      blocking: 0,
      advice: 1,
      url: "https://github.com/acme/widget/pull/30#r2",
      run: run.html_url,
    });
  });

  it("logs a failed run, and nothing for one replaced by a newer review", async () => {
    await seed({ active: true });
    expect((await webhook("workflow_run", { action: "completed", repository: { full_name: REPO }, workflow_run: { ...run, conclusion: "cancelled" } })).status).toBe(200);
    expect((await webhook("workflow_run", { action: "completed", repository: { full_name: REPO }, workflow_run: { ...run, conclusion: "failure" } })).status).toBe(200);
    const finished = (await logActions()).filter((entry) => entry.action === "review_finished");
    expect(finished).toHaveLength(1);
    expect(JSON.parse(finished[0]?.details ?? "{}")).toMatchObject({ verdict: "failed", run: run.html_url });
  });
});
