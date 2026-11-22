import { activityStatement } from "./activity-log";
import { claudeWorkflow } from "./claude";
import type { Env } from "./env";
import { verifyRunToken, workflowPath } from "./github-oidc";
import { json } from "./http";
import { findProject } from "./projects";
import { sprintLiveFor } from "./live";

// The loop of a story (ADR 0003 § 2, epic F15, la-fabrique#424): the
// project's claude workflow reports each phase of Claude's run, signed by
// GitHub (the run's OIDC token, audience La Fabrique's address). Phases,
// numbers and short summaries only, never the code nor the prompts.

export const PHASES = ["plan", "tests", "code", "review", "fix", "verify", "deliver", "break"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LABELS: Record<Phase, string> = {
  plan: "Plan",
  tests: "Tests first",
  code: "Code",
  review: "Review",
  fix: "Fix",
  verify: "End-to-end check",
  deliver: "Delivery",
  break: "Stopped",
};

// The typed breaks of ADR 0003 § 3.
export const BREAKS = ["decision", "spec", "tests", "code", "review", "quota"] as const;
export type BreakKind = (typeof BREAKS)[number];

export const BREAK_LABELS: Record<BreakKind, string> = {
  decision: "A decision to take",
  spec: "A doubt on the spec",
  tests: "Tests that will not pass",
  code: "Past a limit of the code",
  review: "The review still blocks",
  quota: "Usage limit reached",
};

export interface LoopEvent {
  story: number;
  runId: number;
  phase: Phase;
  iteration: number;
  summary: string | null;
  tests: { passed: number; failed: number; new: number } | null;
  diff: { files: number; lines: number } | null;
  findings: { blocking: number; advice: number } | null;
  breakKind: BreakKind | null;
  breakReason: string | null;
  at: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000_000 ? value : null);

// The body of an event, checked: the event, or what is wrong.
export function readEvent(raw: unknown): { event: Omit<LoopEvent, "story" | "runId" | "at"> } | { errors: string[] } {
  if (!isObject(raw)) return { errors: ["The body must be a JSON object."] };
  const errors: string[] = [];
  const phase = raw["phase"];
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) errors.push(`\`phase\` must be one of ${PHASES.join(", ")}.`);
  const iteration = raw["iteration"] === undefined ? 1 : count(raw["iteration"]);
  if (iteration === null || iteration < 1 || iteration > 50) errors.push("`iteration` must be a whole number from 1 to 50.");
  const summary = raw["summary"];
  if (summary !== undefined && summary !== null && typeof summary !== "string") errors.push("`summary` must be a text.");
  const numbers = <K extends string>(key: string, fields: readonly K[]): Record<K, number> | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (!isObject(value)) {
      errors.push(`\`${key}\` must be an object of ${fields.join(", ")}.`);
      return null;
    }
    const out = {} as Record<K, number>;
    for (const field of fields) {
      const read = value[field] === undefined ? 0 : count(value[field]);
      if (read === null) errors.push(`\`${key}.${field}\` must be a whole number.`);
      out[field] = read ?? 0;
    }
    return out;
  };
  const tests = numbers("tests", ["passed", "failed", "new"] as const);
  const diff = numbers("diff", ["files", "lines"] as const);
  const findings = numbers("findings", ["blocking", "advice"] as const);
  const brk = raw["break"];
  let breakKind: BreakKind | null = null;
  let breakReason: string | null = null;
  if (phase === "break") {
    const kind = isObject(brk) ? brk["kind"] : undefined;
    if (typeof kind !== "string" || !(BREAKS as readonly string[]).includes(kind)) errors.push(`A break needs \`break.kind\`, one of ${BREAKS.join(", ")}.`);
    else breakKind = kind as BreakKind;
    const reason = isObject(brk) ? brk["reason"] : undefined;
    if (typeof reason !== "string" || !reason.trim()) errors.push("A break needs `break.reason`: why the loop stops, for the person who unblocks it.");
    else breakReason = reason.trim().slice(0, 2000);
  } else if (brk !== undefined && brk !== null) {
    errors.push("`break` goes with the phase `break` only.");
  }
  if (errors.length) return { errors };
  return {
    event: {
      phase: phase as Phase,
      iteration: iteration ?? 1,
      summary: typeof summary === "string" && summary.trim() ? summary.trim().slice(0, 1000) : null,
      tests,
      diff,
      findings,
      breakKind,
      breakReason,
    },
  };
}

const ROUTE = /^\/api\/runner\/([^/]+\/[^/]+)\/loops\/(\d{1,7})\/events$/;

export function isLoopRoute(pathname: string): boolean {
  return ROUTE.test(pathname);
}

// POST /api/runner/{owner}/{repo}/loops/{story}/events, a run's OIDC token in
// Authorization: Bearer.
export async function receiveLoopEvent(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return json({ error: "Not found." }, { status: 404 });
  const repo = decodeURIComponent(match[1] ?? "");
  const story = Number(match[2]);
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) return json({ error: "A GitHub Actions OIDC token is required (Authorization: Bearer)." }, { status: 401 });
  const verified = await verifyRunToken(token, url.origin).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : "The token could not be checked." }));
  if (!verified.ok) return json({ error: verified.reason }, { status: 401 });
  const project = await findProject(env.DB, repo);
  if (!project) return json({ error: "There is no such project in La Fabrique." }, { status: 404 });
  const file = claudeWorkflow(project);
  if (verified.claims.repository.toLowerCase() !== project.repo.toLowerCase()) return json({ error: "This token belongs to another repository." }, { status: 403 });
  if (!file || workflowPath(verified.claims) !== `.github/workflows/${file}`) return json({ error: "Only the project's claude workflow reports a loop." }, { status: 403 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "The body must be JSON." }, { status: 400 });
  }
  const read = readEvent(raw);
  if ("errors" in read) return json({ error: read.errors.join(" ") }, { status: 422 });
  const event = read.event;
  const runId = Number(verified.claims.run_id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO loop_events (repo, story, run_id, phase, iteration, summary, tests, diff, findings, break_kind, break_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      project.repo,
      story,
      runId,
      event.phase,
      event.iteration,
      event.summary,
      event.tests ? JSON.stringify(event.tests) : null,
      event.diff ? JSON.stringify(event.diff) : null,
      event.findings ? JSON.stringify(event.findings) : null,
      event.breakKind,
      event.breakReason,
    ),
    // A break is a moment someone has to act on: in the project's log.
    ...(event.phase === "break"
      ? [activityStatement(env.DB, { actor: "github", action: "loop_break", repo: project.repo, issueNumber: story, details: { run: runId, kind: event.breakKind, reason: event.breakReason } })]
      : []),
  ]);
  // The sprint's open pages follow, as for the end of a run.
  await sprintLiveFor(env, project.repo)
    ?.notify({ kind: "claude_run", issue: story, status: `loop:${event.phase}`, conclusion: null, url: "", at: new Date().toISOString() })
    .catch(() => undefined);
  return json({ ok: true }, { status: 201 });
}

interface EventRow {
  story: number;
  run_id: number;
  phase: string;
  iteration: number;
  summary: string | null;
  tests: string | null;
  diff: string | null;
  findings: string | null;
  break_kind: string | null;
  break_reason: string | null;
  at: string;
}

function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toEvent(row: EventRow): LoopEvent {
  return {
    story: row.story,
    runId: row.run_id,
    phase: row.phase as Phase,
    iteration: row.iteration,
    summary: row.summary,
    tests: parse(row.tests),
    diff: parse(row.diff),
    findings: parse(row.findings),
    breakKind: row.break_kind as BreakKind | null,
    breakReason: row.break_reason,
    at: row.at,
  };
}

// A story's loop, in order, every run.
export async function storyLoop(db: D1Database, repo: string, story: number): Promise<LoopEvent[]> {
  const { results } = await db.prepare("SELECT * FROM loop_events WHERE repo = ? AND story = ? ORDER BY id LIMIT 300").bind(repo, story).all<EventRow>();
  return results.map(toEvent);
}

// The last phase of each run asked about.
export async function lastPhases(db: D1Database, runIds: number[]): Promise<Map<number, LoopEvent>> {
  if (!runIds.length) return new Map();
  const { results } = await db
    .prepare(`SELECT * FROM loop_events WHERE id IN (SELECT MAX(id) FROM loop_events WHERE run_id IN (${runIds.map(() => "?").join(", ")}) GROUP BY run_id)`)
    .bind(...runIds)
    .all<EventRow>();
  return new Map(results.map((row) => [row.run_id, toEvent(row)]));
}
