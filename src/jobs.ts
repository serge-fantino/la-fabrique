import { findCard, saveSpec, saveSplit } from "./cards";
import type { Env } from "./env";
import { formatUsd, type Progress } from "./llm";
import { liveFor, type LiveEvent } from "./live";
import { findProject } from "./projects";
import { specRubriques, splitSpec, writeSpec, type Answer, type SpecReading } from "./specs";

// Claude works in the background (docs/decisions/0001-claude-in-the-background.md).
// A request is saved as a job at once, with what the person wrote, and
// put on a queue; the queue's consumer runs it, detached from the browser,
// writes its log and tells the card's open pages (CardLive).

export type JobKind = "spec_draft" | "spec_revise" | "spec_answer" | "spec_split";
export type JobStatus = "queued" | "running" | "done" | "failed";

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
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEvent {
  at: string;
  text: string;
}

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_SECONDS = 30;
// A job still running after this long has stopped (its consumer died).
const STALE_MS = 15 * 60 * 1000;

const LABELS: Record<JobKind, string> = {
  spec_draft: "Claude is writing the spec",
  spec_revise: "Claude is revising the spec",
  spec_answer: "Claude is reading your answers",
  spec_split: "Claude is splitting the spec into stories",
};

export function jobLabel(job: Pick<Job, "kind" | "status" | "error">): string {
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
  const since = Date.parse(job.startedAt ?? job.createdAt);
  if ((job.status === "running" || job.status === "queued") && now - since > STALE_MS) {
    const error = "it stopped without an answer";
    await db.prepare("UPDATE claude_jobs SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(error, job.id).run();
    return { ...job, status: "failed", error };
  }
  return job;
}

export function isActive(job: Job | null): job is Job {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

export async function jobEvents(db: D1Database, jobId: number): Promise<JobEvent[]> {
  const { results } = await db.prepare("SELECT at, text FROM claude_job_events WHERE job_id = ? ORDER BY id").bind(jobId).all<JobEvent>();
  return results;
}

// The cards of a project where Claude is working, for the board.
export async function workingCards(db: D1Database, repo: string): Promise<Set<number>> {
  const { results } = await db
    .prepare("SELECT DISTINCT card_id FROM claude_jobs WHERE repo = ? AND status IN ('queued', 'running')")
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
  const event: LiveEvent = { job: job.id, status: now.status, label: jobLabel(now), at: new Date().toISOString(), ...(text ? { text } : {}) };
  try {
    await liveFor(env, job.cardId)?.notify(event);
  } catch {
    // Pages learn it at their next load.
  }
}

export type EnqueueOutcome = { ok: true; job: Job } | { ok: false; message: string };

export async function enqueue(
  env: Env,
  data: { repo: string; cardId: number; kind: JobKind; request: JobRequest; login: string },
): Promise<EnqueueOutcome> {
  if (!env.CLAUDE_QUEUE) return { ok: false, message: "Claude's queue is not set up in this deployment (CLAUDE_QUEUE)." };
  if (isActive(await latestJob(env.DB, data.cardId))) return { ok: false, message: "Claude is already working on this card: wait for it to finish." };
  const row = await env.DB.prepare(
    "INSERT INTO claude_jobs (repo, card_id, kind, status, request, login) VALUES (?, ?, ?, 'queued', ?, ?) RETURNING *",
  )
    .bind(data.repo, data.cardId, data.kind, JSON.stringify(data.request), data.login)
    .first<JobRow>();
  if (!row) return { ok: false, message: "The request could not be saved." };
  const job = toJob(row);
  const answered = data.request.answers.length;
  await say(env, job, `Asked by @${data.login}${answered ? `, with ${answered} answer${answered > 1 ? "s" : ""}` : ""}.`);
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
  if (!job || job.status === "done" || job.status === "failed") return "done";
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
  const rubriques = specRubriques(project);
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
      if (job.kind === "spec_split") {
        // Each story's title, once written in full.
        const found = [...progress.text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
        for (; titles < found.length; titles++) pending.push(say(env, running, `Story ${titles + 1}: ${found[titles]}`));
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

  if (job.kind === "spec_split") {
    const outcome = await splitSpec(env, project, card, job.login, job.request.instruction, watch);
    if (!outcome.ok) return failed(outcome);
    const current = (await findCard(env.DB, job.repo, job.cardId)) ?? card;
    await saveSplit(env.DB, current, job.login, outcome.split, outcome.callId);
    const count = outcome.split.stories.length;
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
  }
}
