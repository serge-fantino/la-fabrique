import { advanceStatus, findCard, reopenStatus, saveEpicReview, saveFeaturesProposal, saveSpec, saveSplit, saveTests } from "./cards";
import type { Env } from "./env";
import { formatUsd, type Progress } from "./llm";
import { liveFor, refinementLiveFor, type LiveEvent } from "./live";
import { findProject } from "./projects";
import { reviewEpic } from "./epic-review";
import { proposeFeatures, rubriquesFor, splitSpec, writeSpec, writeTests, type Answer, type SpecReading } from "./specs";

// Claude works in the background (docs/decisions/0001-claude-in-the-background.md).
// A request is saved as a job at once, with what the person wrote, and
// put on a queue; the queue's consumer runs it, detached from the browser,
// writes its log and tells the card's open pages (CardLive).

export type JobKind = "spec_draft" | "spec_revise" | "spec_answer" | "spec_split" | "spec_tests" | "epic_features" | "epic_review";
// waiting: in La Fabrique's line, not yet given to the queue; queued: given
// to it; cancelled: taken out before it started (la-fabrique#226).
export type JobStatus = "waiting" | "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobRequest {
  instruction: string;
  answers: Answer[];
}

export interface Job {
  id: number;
  repo: string;
  cardId: number;
  kind: JobKind;
  status: JobStatus;
  request: JobRequest;
  login: string;
  attempts: number;
  error: string | null;
  callId: number | null;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEvent {
  at: string;
  text: string;
}

export const MAX_ATTEMPTS = 3;
// At most this many jobs run at once; the others wait their turn, in the
// order they were launched (la-fabrique#226).
export const MAX_RUNNING = 2;
export const RETRY_DELAY_SECONDS = 30;
// A job still running after this long has stopped (its consumer died).
const STALE_MS = 15 * 60 * 1000;

const LABELS: Record<JobKind, string> = {
  spec_draft: "Claude is writing the spec",
  spec_revise: "Claude is revising the spec",
  spec_answer: "Claude is reading your answers",
  spec_split: "Claude is working on the stories",
  spec_tests: "Claude is writing the test cases",
  epic_features: "Claude is proposing the epic's features",
  epic_review: "Claude is reviewing the epic against its features",
};

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function jobLabel(job: Pick<Job, "kind" | "status" | "error">, place?: number | null): string {
  if (job.status === "waiting") return place ? `Waiting for its turn: ${ordinal(place)} in line` : "Waiting for its turn";
  if (job.status === "cancelled") return "Cancelled before it started";
  if (job.status === "queued") return "Waiting for Claude";
  if (job.status === "failed") return `Claude could not finish: ${job.error ?? "unknown error"}`;
  if (job.status === "done") return "Claude is done";
  return LABELS[job.kind];
}

interface JobRow {
  id: number;
  repo: string;
  card_id: number;
  kind: string;
  status: string;
  request: string;
  login: string;
  attempts: number;
  error: string | null;
  call_id: number | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function toJob(row: JobRow): Job {
  let request: JobRequest = { instruction: "", answers: [] };
  try {
    request = { ...request, ...(JSON.parse(row.request) as Partial<JobRequest>) };
  } catch {
    // An unreadable request is an empty one.
  }
  return {
    id: row.id,
    repo: row.repo,
    cardId: row.card_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    request,
    login: row.login,
    attempts: row.attempts,
    error: row.error,
    callId: row.call_id,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function findJob(db: D1Database, id: number): Promise<Job | null> {
  const row = await db.prepare("SELECT * FROM claude_jobs WHERE id = ?").bind(id).first<JobRow>();
  return row ? toJob(row) : null;
}

// The card's latest job; a running one that stopped long ago is failed.
export async function latestJob(db: D1Database, cardId: number, now = Date.now()): Promise<Job | null> {
  const row = await db.prepare("SELECT * FROM claude_jobs WHERE card_id = ? ORDER BY id DESC LIMIT 1").bind(cardId).first<JobRow>();
  if (!row) return null;
  const job = toJob(row);
  if (isStale(job, now)) {
    const error = "it stopped without an answer";
    await db.prepare("UPDATE claude_jobs SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(error, job.id).run();
    return { ...job, status: "failed", error };
  }
  return job;
}

// A job that left the line long ago and never answered: its consumer died.
function isStale(job: Job, now: number): boolean {
  if (job.status !== "running" && job.status !== "queued") return false;
  return now - Date.parse(job.startedAt ?? job.queuedAt ?? job.createdAt) > STALE_MS;
}

export function isActive(job: Job | null): job is Job {
  return Boolean(job && (job.status === "waiting" || job.status === "queued" || job.status === "running"));
}

// The place of each waiting job in the line (1 = next), in the order launched.
export async function waitingPlaces(db: D1Database): Promise<Map<number, number>> {
  const { results } = await db.prepare("SELECT id FROM claude_jobs WHERE status = 'waiting' ORDER BY id").all<{ id: number }>();
  return new Map(results.map((row, index) => [row.id, index + 1]));
}

// The latest job of each card of a project, with the place of the waiting ones.
export async function projectJobs(db: D1Database, repo: string, now = Date.now()): Promise<Map<number, { job: Job; place: number | null }>> {
  const [{ results }, places] = await Promise.all([
    db.prepare("SELECT * FROM claude_jobs WHERE id IN (SELECT MAX(id) FROM claude_jobs WHERE repo = ? GROUP BY card_id)").bind(repo).all<JobRow>(),
    waitingPlaces(db),
  ]);
  const out = new Map<number, { job: Job; place: number | null }>();
  for (const row of results) {
    let job = toJob(row);
    if (isStale(job, now)) job = { ...job, status: "failed", error: "it stopped without an answer" };
    out.set(job.cardId, { job, place: places.get(job.id) ?? null });
  }
  return out;
}

export async function jobEvents(db: D1Database, jobId: number): Promise<JobEvent[]> {
  const { results } = await db.prepare("SELECT at, text FROM claude_job_events WHERE job_id = ? ORDER BY id").bind(jobId).all<JobEvent>();
  return results;
}

// The cards of a project where Claude is working, for the board.
export async function workingCards(db: D1Database, repo: string): Promise<Set<number>> {
  const { results } = await db
    .prepare("SELECT DISTINCT card_id FROM claude_jobs WHERE repo = ? AND status IN ('waiting', 'queued', 'running')")
    .bind(repo)
    .all<{ card_id: number }>();
  return new Set(results.map((row) => row.card_id));
}

// A line in the job's log, a new status if any, and the card's open pages told.
async function say(env: Env, job: Job, text: string | null, status?: JobStatus, error?: string): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (text) statements.push(env.DB.prepare("INSERT INTO claude_job_events (job_id, text) VALUES (?, ?)").bind(job.id, text));
  if (status) {
    const finished = status === "done" || status === "failed";
    statements.push(
      env.DB.prepare(
        `UPDATE claude_jobs SET status = ?, error = ?${finished ? ", finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : ""} WHERE id = ?`,
      ).bind(status, error ?? null, job.id),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  const now: Job = { ...job, ...(status ? { status } : {}), error: error ?? job.error };
  const place = now.status === "waiting" ? ((await waitingPlaces(env.DB)).get(job.id) ?? null) : null;
  const event: LiveEvent = { job: job.id, card: job.cardId, status: now.status, label: jobLabel(now, place), at: new Date().toISOString(), ...(place ? { place } : {}), ...(text ? { text } : {}) };
  try {
    await liveFor(env, job.cardId)?.notify(event);
    await refinementLiveFor(env, job.repo)?.notify(event);
  } catch {
    // Pages learn it at their next load.
  }
}

// Gives the oldest waiting jobs to the queue while fewer than MAX_RUNNING
// are on it or running, then tells the ones still waiting their new place.
export async function dispatch(env: Env): Promise<void> {
  if (!env.CLAUDE_QUEUE) return;
  // A job whose consumer died must not hold a place for ever.
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  await env.DB.prepare(
    "UPDATE claude_jobs SET status = 'failed', error = 'it stopped without an answer', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('queued', 'running') AND COALESCE(started_at, queued_at, created_at) < ?",
  )
    .bind(staleBefore)
    .run();
  const busy = await env.DB.prepare("SELECT COUNT(*) AS n FROM claude_jobs WHERE status IN ('queued', 'running')").first<{ n: number }>();
  const free = MAX_RUNNING - (busy?.n ?? 0);
  if (free > 0) {
    const { results } = await env.DB.prepare("SELECT * FROM claude_jobs WHERE status = 'waiting' ORDER BY id LIMIT ?").bind(free).all<JobRow>();
    for (const row of results) {
      const claimed = await env.DB.prepare(
        "UPDATE claude_jobs SET status = 'queued', queued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'waiting'",
      )
        .bind(row.id)
        .run();
      if (!claimed.meta.changes) continue;
      const job = toJob({ ...row, status: "queued" });
      try {
        await env.CLAUDE_QUEUE.send({ job: job.id });
        await say(env, job, "It is its turn: given to Claude.", "queued");
      } catch {
        await say(env, job, "Could not reach Claude's queue.", "failed", "the queue did not take it");
      }
    }
  }
  // The others move up.
  const places = await waitingPlaces(env.DB);
  if (!places.size) return;
  const { results } = await env.DB.prepare(`SELECT * FROM claude_jobs WHERE status = 'waiting' ORDER BY id`).all<JobRow>();
  for (const row of results) await say(env, toJob(row), null);
}

export type CancelOutcome = { ok: true; job: Job } | { ok: false; message: string };

// Takes a job out of the line, if it has not started: a running job is
// never cancelled.
export async function cancelJob(env: Env, repo: string, cardId: number, login: string): Promise<CancelOutcome> {
  const last = await latestJob(env.DB, cardId);
  if (!last || last.repo.toLowerCase() !== repo.toLowerCase() || !isActive(last)) return { ok: false, message: "No job to cancel on this card." };
  const changed = await env.DB.prepare(
    "UPDATE claude_jobs SET status = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND (status = 'waiting' OR (status = 'queued' AND attempts = 0))",
  )
    .bind(last.id)
    .run();
  if (!changed.meta.changes) return { ok: false, message: "Claude already started this job: a running job is never cancelled." };
  await say(env, last, `Cancelled by @${login} before it started.`, "cancelled");
  await dispatch(env);
  return { ok: true, job: { ...last, status: "cancelled" } };
}

export type EnqueueOutcome = { ok: true; job: Job } | { ok: false; message: string };

export async function enqueue(
  env: Env,
  data: { repo: string; cardId: number; kind: JobKind; request: JobRequest; login: string },
): Promise<EnqueueOutcome> {
  if (!env.CLAUDE_QUEUE) return { ok: false, message: "Claude's queue is not set up in this deployment (CLAUDE_QUEUE)." };
  if (isActive(await latestJob(env.DB, data.cardId))) return { ok: false, message: "Claude is already working on this card: wait for it to finish." };
  // A free place: straight to the queue. Otherwise it waits its turn.
  const busy = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM claude_jobs WHERE status IN ('queued', 'running')) AS busy, (SELECT COUNT(*) FROM claude_jobs WHERE status = 'waiting') AS waiting").first<{ busy: number; waiting: number }>();
  const direct = (busy?.busy ?? 0) < MAX_RUNNING && !busy?.waiting;
  const row = await env.DB.prepare(
    `INSERT INTO claude_jobs (repo, card_id, kind, status, request, login, queued_at) VALUES (?, ?, ?, ?, ?, ?, ${direct ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "NULL"}) RETURNING *`,
  )
    .bind(data.repo, data.cardId, data.kind, direct ? "queued" : "waiting", JSON.stringify(data.request), data.login)
    .first<JobRow>();
  if (!row) return { ok: false, message: "The request could not be saved." };
  const job = toJob(row);
  const answered = data.request.answers.length;
  await say(env, job, `Asked by @${data.login}${answered ? `, with ${answered} answer${answered > 1 ? "s" : ""}` : ""}.`);
  if (!direct) await say(env, job, "Claude is busy: waiting for its turn.", "waiting");
  if (!direct) return { ok: true, job };
  try {
    await env.CLAUDE_QUEUE.send({ job: job.id });
  } catch {
    await say(env, job, "Could not reach Claude's queue.", "failed", "the queue did not take it");
    return { ok: false, message: "Claude's queue did not take the request: try again." };
  }
  return { ok: true, job };
}

// The last sentence of what Claude is thinking, short.
function tail(text: string): string {
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  const last = sentences.at(-1) || text;
  return last.length > 200 ? `…${last.slice(-199)}` : last;
}

// Runs a job; "retry" when the queue should bring it back later.
export async function runJob(env: Env, id: number): Promise<"done" | "retry" | "failed"> {
  const job = await findJob(env.DB, id);
  if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled" || job.status === "waiting") return "done";
  const [project, card] = await Promise.all([findProject(env.DB, job.repo), findCard(env.DB, job.repo, job.cardId)]);
  if (!project || !card) {
    await say(env, job, "The card is gone.", "failed", "the card is gone");
    return "failed";
  }
  await env.DB.prepare(
    "UPDATE claude_jobs SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?",
  )
    .bind(job.id)
    .run();
  const running: Job = { ...job, status: "running", attempts: job.attempts + 1 };
  await say(env, running, job.attempts ? `Trying again (attempt ${job.attempts + 1}).` : "Claude starts.", "running");

  // What Claude does, a line every few seconds at most.
  const rubriques = rubriquesFor(project, card);
  const pending: Promise<void>[] = [];
  let lastThought = "";
  let lastAt = 0;
  const written = new Set<string>();
  let titles = 0;
  const watch = {
    read: (reading: SpecReading) => {
      const parts = [reading.document, `${reading.cards} other card${reading.cards === 1 ? "" : "s"}`, `${reading.stories} open stor${reading.stories === 1 ? "y" : "ies"}`];
      pending.push(say(env, running, `Reads ${parts.filter(Boolean).join(", ")}.`));
    },
    progress: (progress: Progress) => {
      if (progress.type === "thinking") {
        const thought = tail(progress.text);
        if (!thought || thought === lastThought || Date.now() - lastAt < 4000) return;
        lastThought = thought;
        lastAt = Date.now();
        pending.push(say(env, running, `Thinks: ${thought}`));
        return;
      }
      if (job.kind === "spec_tests") return;
      if (job.kind === "spec_split" || job.kind === "epic_features") {
        // Each story's title, once written in full.
        const found = [...progress.text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
        for (; titles < found.length; titles++) pending.push(say(env, running, `${job.kind === "epic_features" ? "Feature" : "Story"} ${titles + 1}: ${found[titles]}`));
        return;
      }
      for (const rubrique of rubriques) {
        if (written.has(rubrique.cle) || !progress.text.includes(`"${rubrique.cle}"`)) continue;
        written.add(rubrique.cle);
        pending.push(say(env, running, `Writes: ${rubrique.titre}.`));
      }
      if (!written.has("questions") && /"questions"\s*:/.test(progress.text)) {
        written.add("questions");
        pending.push(say(env, running, "Writes its questions."));
      }
    },
  };

  const failed = async (outcome: { message: string; retryable: boolean }): Promise<"retry" | "failed"> => {
    await Promise.allSettled(pending);
    if (outcome.retryable && running.attempts < MAX_ATTEMPTS) {
      await say(env, running, `${outcome.message} Trying again in ${RETRY_DELAY_SECONDS} s.`, "queued");
      return "retry";
    }
    await say(env, running, outcome.message, "failed", outcome.message);
    return "failed";
  };
  // The card may have changed meanwhile: the result goes on its newest version.
  const finish = async (callId: number, summary: string, cost: number | null) => {
    await Promise.allSettled(pending);
    await env.DB.prepare("UPDATE claude_jobs SET call_id = ? WHERE id = ?").bind(callId, job.id).run();
    await say(env, running, `Done: ${summary} Cost ${formatUsd(cost)}.`, "done");
    return "done" as const;
  };

  if (job.kind === "spec_tests") {
    const outcome = await writeTests(env, project, card, job.login, job.request.instruction, watch);
    if (!outcome.ok) return failed(outcome);
    const current = (await findCard(env.DB, job.repo, job.cardId)) ?? card;
    await saveTests(env.DB, current, job.login, outcome.tests, outcome.callId);
    const count = outcome.tests.stories.length;
    return finish(outcome.callId, `test cases written for ${count} stor${count === 1 ? "y" : "ies"}.`, outcome.costMicros);
  }

  if (job.kind === "epic_review") {
    const outcome = await reviewEpic(env, project, card, job.login, job.request.instruction, watch);
    if (!outcome.ok) return failed(outcome);
    const current = (await findCard(env.DB, job.repo, job.cardId)) ?? card;
    await saveEpicReview(env.DB, current, job.login, outcome.review, { callId: outcome.callId });
    const count = outcome.review.findings.length;
    return finish(outcome.callId, count ? `${count} finding${count === 1 ? "" : "s"}, to apply or dismiss one by one; nothing is changed.` : "nothing to report.", outcome.costMicros);
  }

  if (job.kind === "epic_features") {
    const outcome = await proposeFeatures(env, project, card, job.login, job.request.instruction, watch);
    if (!outcome.ok) return failed(outcome);
    const current = (await findCard(env.DB, job.repo, job.cardId)) ?? card;
    await saveFeaturesProposal(env.DB, current, job.login, outcome.proposal, outcome.callId);
    const count = outcome.proposal.features.length;
    return finish(outcome.callId, `${count} feature${count === 1 ? "" : "s"} proposed, to review before any card is created.`, outcome.costMicros);
  }

  if (job.kind === "spec_split") {
    const outcome = await splitSpec(env, project, card, job.login, job.request.instruction, watch);
    if (!outcome.ok) return failed(outcome);
    const current = (await findCard(env.DB, job.repo, job.cardId)) ?? card;
    await saveSplit(env.DB, current, job.login, outcome.split, outcome.callId);
    const count = outcome.split.stories.length;
    const review = outcome.split.review;
    if (review) {
      const changes = review.filter((story) => story.verdict === "change").length;
      return finish(
        outcome.callId,
        `${review.length - changes} of ${review.length} stor${review.length === 1 ? "y" : "ies"} still fit${changes ? `, ${changes} to change` : ""}; ${count || "no"} new stor${count === 1 ? "y" : "ies"} proposed, to review before anything goes to GitHub.`,
        outcome.costMicros,
      );
    }
    return finish(outcome.callId, `${count} stor${count === 1 ? "y" : "ies"} proposed, to review before they go to GitHub.`, outcome.costMicros);
  }

  const outcome = await writeSpec(
    env,
    project,
    card,
    job.login,
    { mode: job.kind === "spec_draft" ? "draft" : "revise", instruction: job.request.instruction, answers: job.request.answers },
    watch,
  );
  if (!outcome.ok) return failed(outcome);
  const current = (await findCard(env.DB, job.repo, job.cardId)) ?? card;
  await saveSpec(env.DB, current, job.login, outcome.spec, outcome.callId);
  await reopenStatus(env.DB, job.repo, job.cardId, job.login, "the spec changed");
  if (outcome.spec.enough) await advanceStatus(env.DB, job.repo, job.cardId, job.login, "to_validate", "Claude knows enough");
  const asks = outcome.spec.questions.length;
  return finish(
    outcome.callId,
    outcome.spec.enough ? "Claude knows enough to write the stories." : `${asks} question${asks === 1 ? "" : "s"} for you.`,
    outcome.costMicros,
  );
}

// The queue's consumer: one job per message.
export async function consumeJobs(batch: MessageBatch<{ job: number }>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await runJob(env, Number(message.body.job));
      if (outcome === "retry") message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      else message.ack();
    } catch (error) {
      console.error("claude job", message.body.job, error);
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
    // A place is free (or soon): the next waiting job gets its turn.
    try {
      await dispatch(env);
    } catch (error) {
      console.error("claude dispatch", error);
    }
  }
}
