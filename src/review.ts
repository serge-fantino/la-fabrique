// Claude reviews a pull request (epic F14; F14.2, la-fabrique#378): La Fabrique
// starts the project's own review workflow (`workflows.revue`, its secrets:
// principle 3) with the pull request, who started it and the project's
// settings, and writes it in the log.

import { activityStatement } from "./activity-log";
import type { Role } from "./accounts";
import type { Env } from "./env";
import { dispatchRefusal, githubJson, githubPost, installationToken } from "./github-app";
import { sprintLiveFor } from "./live";
import { productionBranch, type Project } from "./projects";
import { can } from "./rights";
import { reviewSettings, type ReviewSettings } from "./review-settings";

// Who starts the review when nobody did: the review is on (la-fabrique#379).
export const BY_LA_FABRIQUE = "la-fabrique";

export function reviewWorkflow(project: Project): string | null {
  const file = project.check?.config?.workflows?.["revue"];
  return typeof file === "string" ? file : null;
}

export function projectReviewSettings(project: Project): ReviewSettings {
  return reviewSettings(project.check?.config?.revue);
}

// Starting a review costs like launching Claude: a tech lead and above.
export function canReview(role: Role | null): boolean {
  return can(role, "launch_claude");
}

// The settings as the workflow reads them (input `reglages`), in the keys of
// `.fabrique.json`: every focus area with its level, the defaults filled in.
export function reviewInputs(settings: ReviewSettings): string {
  return JSON.stringify({
    modele: settings.model ?? "",
    exigence: settings.pickiness,
    max_remarques: settings.maxRemarks,
    focus: Object.fromEntries(settings.focus.map((entry) => [entry.area, entry.level])),
    consignes: settings.guidelines ?? "",
  });
}

export type ReviewOutcome = { ok: true } | { ok: false; message: string; status: 422 | 502 };

export async function launchReview(
  env: Env,
  project: Project,
  by: string,
  pull: number,
  options: { story?: number | null; trigger?: "person" | "auto" | "run"; sha?: string | null } = {},
): Promise<ReviewOutcome> {
  const file = reviewWorkflow(project);
  if (!file) return { ok: false, message: "This project declares no review workflow (workflows.revue).", status: 422 };
  const settings = projectReviewSettings(project);
  const trigger = options.trigger ?? "person";
  try {
    const token = await installationToken(env, project.installationId);
    const ref = productionBranch(project) ?? "main";
    const response = await githubPost(token, `/repos/${project.repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
      ref,
      inputs: { pr: String(pull), par: by, reglages: reviewInputs(settings) },
    });
    if (!response.ok) {
      const message = dispatchRefusal(file, ref, response.status, "take the inputs pr, par and reglages (see La Fabrique's own .github/workflows/review.yml)");
      if (trigger === "auto") {
        await activityStatement(env.DB, { actor: BY_LA_FABRIQUE, action: "review_launch_refused", repo: project.repo, issueNumber: pull, details: { workflow: file, reason: message } }).run();
      }
      return { ok: false, message, status: 502 };
    }
    await activityStatement(env.DB, {
      actor: by,
      action: "review_launched",
      repo: project.repo,
      issueNumber: pull,
      details: {
        workflow: file,
        pull,
        story: options.story ?? null,
        sha: options.sha ?? null,
        trigger,
        model: settings.model,
        pickiness: settings.pickiness,
      },
    }).run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (trigger === "auto") {
      await activityStatement(env.DB, { actor: BY_LA_FABRIQUE, action: "review_launch_refused", repo: project.repo, issueNumber: pull, details: { workflow: file, reason: message } })
        .run()
        .catch(() => undefined);
    }
    return { ok: false, message, status: 502 };
  }
}

// Every pull request reviewed on its own when the review is on (F14.3,
// la-fabrique#379): opened, new commits, reopened or out of draft. A draft
// waits; the workflow's concurrency replaces a review still running on older
// commits. Never throws: the webhook answers anyway.
const REVIEWED_ON = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export interface WebhookPull {
  number: number;
  draft?: boolean;
  state?: string;
  head?: { ref?: string; sha?: string };
}

export async function autoReview(env: Env, project: Project, action: string, pull: WebhookPull | undefined): Promise<boolean> {
  if (!pull || !REVIEWED_ON.has(action) || pull.draft || (pull.state && pull.state !== "open")) return false;
  if (!reviewWorkflow(project) || !projectReviewSettings(project).active) return false;
  const outcome = await launchReview(env, project, BY_LA_FABRIQUE, pull.number, { trigger: "auto", sha: pull.head?.sha ?? null }).catch(() => null);
  return Boolean(outcome?.ok);
}

// The review's verdict (F14.4, la-fabrique#380), as the workflow writes it in
// the body of its GitHub review: `<!-- fabrique-review {json} -->`.
export type Verdict = "ok" | "remarques" | "bloquant";

export interface Finding {
  area: string;
  level: "bloquant" | "conseil";
  file: string | null;
  line: number | null;
  text: string;
}

export interface ReviewMarker {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  model: string | null;
  sha: string | null;
}

const MARKER = /<!--\s*fabrique-review\s+(\{[\s\S]*?\})\s*-->/;

export function parseReviewMarker(body: string | null | undefined): ReviewMarker | null {
  const found = MARKER.exec(body ?? "");
  if (!found?.[1]) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(found[1]);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const verdict = record["verdict"];
  if (verdict !== "ok" && verdict !== "remarques" && verdict !== "bloquant") return null;
  const findings = (Array.isArray(record["findings"]) ? record["findings"] : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      area: typeof entry["area"] === "string" ? entry["area"] : "",
      level: entry["level"] === "bloquant" ? ("bloquant" as const) : ("conseil" as const),
      file: typeof entry["file"] === "string" && entry["file"] ? entry["file"] : null,
      line: Number.isInteger(entry["line"]) ? (entry["line"] as number) : null,
      text: typeof entry["text"] === "string" ? entry["text"] : "",
    }))
    .filter((finding) => finding.text);
  return {
    verdict,
    summary: typeof record["summary"] === "string" ? record["summary"] : "",
    findings,
    model: typeof record["model"] === "string" && record["model"] ? record["model"] : null,
    sha: typeof record["sha"] === "string" && record["sha"] ? record["sha"] : null,
  };
}

interface RestReview {
  id: number;
  body: string | null;
  html_url: string;
  commit_id?: string | null;
  submitted_at?: string | null;
}

interface ReviewRun {
  id?: number;
  path?: string;
  display_title?: string;
  conclusion?: string | null;
  html_url?: string;
  run_started_at?: string;
  created_at?: string;
}

// The end of a review run (webhook workflow_run): its verdict, read from the
// review it posted, in the log; failed, with the run's link. A run replaced by
// a newer one (cancelled), or that skipped a closed pull request, says nothing.
export async function reviewRunEvent(env: Env, project: Project, action: string, run: ReviewRun): Promise<boolean> {
  const file = reviewWorkflow(project);
  if (!file || !run.path?.endsWith(`/${file}`)) return false;
  const pull = Number(/#(\d+)/.exec(run.display_title ?? "")?.[1] ?? NaN);
  if (!Number.isInteger(pull) || pull <= 0) return false;
  if (action === "completed" && run.conclusion !== "cancelled" && run.conclusion !== "skipped") {
    const found = run.conclusion === "success" ? await postedReview(env, project, pull, run.run_started_at ?? run.created_at ?? null) : null;
    // Success without a review: the pull request was closed meanwhile (skipped).
    if (found || run.conclusion !== "success") {
      const counts = (level: Finding["level"]) => found?.marker.findings.filter((finding) => finding.level === level).length ?? 0;
      await activityStatement(env.DB, {
        actor: "github",
        action: "review_finished",
        repo: project.repo,
        issueNumber: pull,
        details: found
          ? {
              verdict: found.marker.verdict,
              model: found.marker.model,
              sha: found.marker.sha ?? found.sha,
              blocking: counts("bloquant"),
              advice: counts("conseil"),
              url: found.url,
              run: run.html_url ?? null,
            }
          : { verdict: "failed", model: null, sha: null, blocking: 0, advice: 0, url: null, run: run.html_url ?? null },
      }).run();
    }
  }
  await sprintLiveFor(env, project.repo)
    ?.notify({ kind: "pull_request", issue: null, status: action, conclusion: run.conclusion ?? null, url: run.html_url ?? "", at: new Date().toISOString() })
    .catch(() => undefined);
  return true;
}

// The newest review with La Fabrique's marker, posted since the run started.
async function postedReview(env: Env, project: Project, pull: number, since: string | null): Promise<{ marker: ReviewMarker; url: string; sha: string | null } | null> {
  try {
    const token = await installationToken(env, project.installationId);
    const reviews = await githubJson<RestReview[]>(token, `/repos/${project.repo}/pulls/${pull}/reviews?per_page=100`);
    for (const review of [...reviews].reverse()) {
      if (since && review.submitted_at && review.submitted_at < since) break;
      const marker = parseReviewMarker(review.body);
      if (marker) return { marker, url: review.html_url, sha: review.commit_id ?? null };
    }
  } catch {
    // Unread: logged as without a review below.
  }
  return null;
}

// Where each pull request's review stands, from the log (F14.4): running
// (started, not finished, less than 40 minutes ago), its verdict, failed;
// stale when its commit is not the pull request's latest.
export type ReviewState =
  | { state: "running"; at: string; by: string }
  | { state: Verdict | "failed"; at: string; url: string | null; run: string | null; sha: string | null; blocking: number; advice: number; stale: boolean };

const RUNNING_MAX_MS = 40 * 60_000;

interface LogRow {
  occurred_at: string;
  actor: string;
  action: string;
  issue_number: number;
  details: string | null;
}

export function reviewStates(rows: LogRow[], heads: Map<number, string | null>, now = Date.now()): Map<number, ReviewState> {
  const launched = new Map<number, LogRow>();
  const finished = new Map<number, LogRow>();
  for (const row of rows) (row.action === "review_launched" ? launched : finished).set(row.issue_number, row);
  const states = new Map<number, ReviewState>();
  for (const pull of new Set([...launched.keys(), ...finished.keys()])) {
    const start = launched.get(pull);
    const end = finished.get(pull);
    const at = (row: LogRow) => Date.parse(`${row.occurred_at.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(row.occurred_at) ? "" : "Z"}`);
    if (start && (!end || at(start) > at(end)) && now - at(start) < RUNNING_MAX_MS) {
      states.set(pull, { state: "running", at: start.occurred_at, by: start.actor });
      continue;
    }
    if (!end) continue;
    const details = end.details ? (JSON.parse(end.details) as Record<string, unknown>) : {};
    const verdict = details["verdict"];
    const sha = typeof details["sha"] === "string" ? details["sha"] : null;
    const head = heads.get(pull) ?? null;
    states.set(pull, {
      state: verdict === "ok" || verdict === "remarques" || verdict === "bloquant" ? verdict : "failed",
      at: end.occurred_at,
      url: typeof details["url"] === "string" ? details["url"] : null,
      run: typeof details["run"] === "string" ? details["run"] : null,
      sha,
      blocking: Number(details["blocking"]) || 0,
      advice: Number(details["advice"]) || 0,
      stale: Boolean(sha && head && sha !== head),
    });
  }
  return states;
}

export async function pullReviewStates(db: D1Database, repo: string, heads: Map<number, string | null>): Promise<Map<number, ReviewState>> {
  const { results } = await db
    .prepare(
      "SELECT occurred_at, actor, action, issue_number, details FROM activity_log WHERE repo = ? AND action IN ('review_launched', 'review_finished') AND issue_number IS NOT NULL ORDER BY id",
    )
    .bind(repo)
    .all<LogRow>();
  return reviewStates(results, heads);
}

// ---- The review holds the merge (C160: F14.5, la-fabrique#381; F14.6, #382) ----

// The review is on for the sprint's run: declared and active.
export function reviewHolds(project: Project): boolean {
  return Boolean(reviewWorkflow(project)) && projectReviewSettings(project).active;
}

// Forced past a blocking review, by a person: on that commit only.
export interface Forced {
  sha: string | null;
  by: string;
  reason: string;
  at: string;
}

export function canForceReview(role: Role | null): boolean {
  return can(role, "force_review");
}

export async function forcedReviews(db: D1Database, repo: string): Promise<Map<number, Forced>> {
  const { results } = await db
    .prepare("SELECT occurred_at, actor, issue_number, details FROM activity_log WHERE repo = ? AND action = 'review_forced' AND issue_number IS NOT NULL ORDER BY id")
    .bind(repo)
    .all<{ occurred_at: string; actor: string; issue_number: number; details: string | null }>();
  const found = new Map<number, Forced>();
  for (const row of results) {
    const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    found.set(row.issue_number, {
      sha: typeof details["sha"] === "string" ? details["sha"] : null,
      by: row.actor,
      reason: typeof details["reason"] === "string" ? details["reason"] : "",
      at: row.occurred_at,
    });
  }
  return found;
}

// Whether a review was forced for the pull request's latest commit.
export function isForced(forced: Forced | undefined, head: string | null | undefined): boolean {
  return Boolean(forced && (forced.sha === null || !head || forced.sha === head));
}

// A blocking review on the latest commit, not forced, holds the merge.
export function heldByReview(review: ReviewState | undefined, forced: Forced | undefined, head: string | null | undefined): boolean {
  return review?.state === "bloquant" && !review.stale && !isForced(forced, head);
}

// "Force past the review" (F14.6): a reason is required; logged with the
// commit it was forced on, so the next commit's review holds again.
export async function forceReview(
  env: Env,
  project: Project,
  login: string,
  pull: number,
  reason: string,
  head: string | null,
): Promise<{ ok: true } | { ok: false; message: string; status: 409 | 422 }> {
  const why = reason.trim().slice(0, 500);
  if (!why) return { ok: false, message: "Say why you force past the review: the reason is kept in the log.", status: 422 };
  const review = (await pullReviewStates(env.DB, project.repo, new Map([[pull, head]]))).get(pull);
  if (review?.state !== "bloquant" || review.stale) return { ok: false, message: `The latest review of #${pull} is not blocking: nothing to force.`, status: 409 };
  await activityStatement(env.DB, {
    actor: login,
    action: "review_forced",
    repo: project.repo,
    issueNumber: pull,
    details: { pull, sha: head ?? review.sha, reason: why, blocking: review.blocking, review: review.url },
  }).run();
  await sprintLiveFor(env, project.repo)
    ?.notify({ kind: "pull_request", issue: null, status: "review_forced", conclusion: null, url: "", at: new Date().toISOString() })
    .catch(() => undefined);
  return { ok: true };
}

// The checks GitHub ran on a commit (its check runs): pending while one
// runs, failure when one failed, success otherwise (none counts as success).
export type Checks = "pending" | "success" | "failure";

interface RestCheckRuns {
  check_runs: { status: string; conclusion: string | null }[];
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function checksOf(runs: RestCheckRuns["check_runs"]): Checks {
  if (runs.some((run) => run.status !== "completed")) return "pending";
  if (runs.some((run) => run.conclusion && FAILED.has(run.conclusion))) return "failure";
  return "success";
}

export async function commitChecks(env: Env, project: Project, sha: string): Promise<Checks> {
  try {
    const token = await installationToken(env, project.installationId);
    const found = await githubJson<RestCheckRuns>(token, `/repos/${project.repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
    return checksOf(found.check_runs);
  } catch {
    return "pending";
  }
}

// Why a merge is refused because of Claude's review (la-fabrique#382), or
// null: a blocking review of the latest commit, not forced past.
export async function reviewHold(env: Env, project: Project, pull: number, head: string | null): Promise<string | null> {
  if (!reviewWorkflow(project)) return null;
  const [states, forced] = await Promise.all([pullReviewStates(env.DB, project.repo, new Map([[pull, head]])), forcedReviews(env.DB, project.repo)]);
  const review = states.get(pull);
  if (!heldByReview(review, forced.get(pull), head)) return null;
  return `Claude's review of #${pull} is blocking (${review?.state === "bloquant" ? review.blocking : 0} blocking finding${review?.state === "bloquant" && review.blocking === 1 ? "" : "s"}): a tech lead or the super admin forces past it, with a reason, before the merge.`;
}

// The latest review by Claude of a pull request, as posted on GitHub (its
// marker): what the story's page lists (la-fabrique#380). Null when GitHub
// does not answer or there is none.
export async function latestReview(env: Env, project: Project, pull: number): Promise<(ReviewMarker & { url: string }) | null> {
  try {
    const token = await installationToken(env, project.installationId);
    const reviews = await githubJson<RestReview[]>(token, `/repos/${project.repo}/pulls/${pull}/reviews?per_page=100`);
    for (const review of [...reviews].reverse()) {
      const marker = parseReviewMarker(review.body);
      if (marker) return { ...marker, url: review.html_url };
    }
  } catch {
    // The page shows the state from the log anyway.
  }
  return null;
}
