import { lastPhases, PHASE_LABELS } from "./loop-events";
import { CAPABILITIES, capability } from "./capabilities";
import { budgetState, type BudgetState } from "./claude-budget";
import type { Env } from "./env";
import { listProjects } from "./projects";

// The Agents page (ADR 0004 § 2, epic F15, la-fabrique#422): every agent
// task across projects, whatever its capability, read from the two records
// La Fabrique keeps: its own jobs (claude_jobs, in La Fabrique) and Claude's
// runs in the projects' runners (runner_runs). Nothing else is stored.

export const RECENT_DAYS = 7;

export type AgentState = "waiting" | "queued" | "running" | "decision" | "done" | "failed" | "cancelled";

export interface AgentTask {
  // fabrique: a job of La Fabrique; runner: a run in the project's runner.
  place: "fabrique" | "runner";
  id: number;
  repo: string;
  capability: string;
  label: string;
  state: AgentState;
  card: { id: number; title: string } | null;
  story: number | null;
  pull: number | null;
  who: string | null;
  since: string | null;
  ended: string | null;
  costMicros: number | null;
  // Runner runs: on the subscription or an API key; tokens new in, from cache, out.
  auth: string | null;
  tokens: { newIn: number; cacheRead: number; out: number } | null;
  url: string | null;
  // A run's last phase of the loop (la-fabrique#424).
  phase?: string | null;
}

export interface AgentsView {
  active: AgentTask[];
  decisions: AgentTask[];
  ended: AgentTask[];
  budgets: { repo: string; name: string; budget: BudgetState }[];
  repos: string[];
}

function labelOf(id: string): string {
  return capability(id)?.label ?? id;
}

interface JobRow {
  id: number;
  repo: string;
  card_id: number;
  kind: string;
  status: string;
  capability: string | null;
  login: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  title: string | null;
  cost: number | null;
}

interface RunRow {
  run_id: number;
  repo: string;
  capability: string;
  story: number | null;
  pull: number | null;
  status: string;
  conclusion: string | null;
  url: string | null;
  started_at: string | null;
  finished_at: string | null;
  auth: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  api_cost_micros: number | null;
}

function fromJob(row: JobRow): AgentTask {
  const id = row.capability ?? row.kind;
  const state = row.status as AgentState;
  return {
    place: "fabrique",
    id: row.id,
    repo: row.repo,
    capability: id,
    label: labelOf(id),
    state,
    card: { id: row.card_id, title: row.title ?? `C${row.card_id}` },
    story: null,
    pull: null,
    who: row.login,
    since: row.started_at ?? row.created_at,
    ended: row.finished_at,
    costMicros: row.cost,
    auth: null,
    tokens: null,
    url: null,
  };
}

function fromRun(row: RunRow): AgentTask {
  const state: AgentState =
    row.status !== "completed" ? (row.status === "queued" || row.status === "requested" || row.status === "waiting" ? "queued" : "running") : row.conclusion === "success" ? "done" : row.conclusion === "cancelled" ? "cancelled" : "failed";
  return {
    place: "runner",
    id: row.run_id,
    repo: row.repo,
    capability: row.capability,
    label: labelOf(row.capability),
    state,
    card: null,
    story: row.story,
    pull: row.pull,
    who: null,
    since: row.started_at,
    ended: row.finished_at,
    costMicros: row.api_cost_micros,
    auth: row.auth,
    tokens: row.auth ? { newIn: row.input_tokens + row.cache_write_tokens, cacheRead: row.cache_read_tokens, out: row.output_tokens } : null,
    url: row.url,
  };
}

// La Fabrique's capabilities whose proposals wait for a person.
const DECIDED = CAPABILITIES.filter((entry) => entry.place === "fabrique" && entry.ending === "decision").map((entry) => entry.id);

const JOB_SELECT =`SELECT j.id, j.repo, j.card_id, j.kind, j.status, j.capability, j.login, j.created_at, j.started_at, j.finished_at, c.title, l.cost_micros AS cost
  FROM claude_jobs j LEFT JOIN cards c ON c.id = j.card_id LEFT JOIN llm_calls l ON l.id = j.call_id`;

// Every agent task: what runs or waits its turn, what waits for a person's
// decision, what ended these last days; and each project's month.
export async function loadAgents(env: Env, now: Date = new Date()): Promise<AgentsView> {
  const recent = new Date(now.getTime() - RECENT_DAYS * 24 * 3600 * 1000).toISOString();
  const [activeJobs, decidingJobs, endedJobs, activeRuns, endedRuns, projects] = await Promise.all([
    env.DB.prepare(`${JOB_SELECT} WHERE j.status IN ('waiting', 'queued', 'running') ORDER BY j.id`).all<JobRow>(),
    env.DB.prepare(`${JOB_SELECT} WHERE j.status = 'done' AND j.decision IS NULL AND j.capability IN (${DECIDED.map(() => "?").join(", ")}) ORDER BY j.id`)
      .bind(...DECIDED)
      .all<JobRow>(),
    env.DB.prepare(`${JOB_SELECT} WHERE j.status IN ('done', 'failed', 'cancelled') AND j.finished_at >= ? ORDER BY j.finished_at DESC LIMIT 200`).bind(recent).all<JobRow>(),
    env.DB.prepare("SELECT * FROM runner_runs WHERE status <> 'completed' ORDER BY started_at").all<RunRow>(),
    env.DB.prepare("SELECT * FROM runner_runs WHERE status = 'completed' AND finished_at >= ? ORDER BY finished_at DESC LIMIT 200").bind(recent).all<RunRow>(),
    listProjects(env.DB),
  ]);
  const deciding = new Set(decidingJobs.results.map((row) => row.id));
  const phases = await lastPhases(env.DB, activeRuns.results.map((row) => row.run_id));
  const decisions = decidingJobs.results.map((row) => ({ ...fromJob(row), state: "decision" as const }));
  const ended = [...endedJobs.results.filter((row) => !deciding.has(row.id)).map(fromJob), ...endedRuns.results.map(fromRun)].sort((a, b) => (b.ended ?? "").localeCompare(a.ended ?? ""));
  const budgets = await Promise.all(projects.map(async (project) => ({ repo: project.repo, name: project.check?.config?.nom || project.repo, budget: await budgetState(env, project, now) })));
  return {
    active: [
      ...activeJobs.results.map(fromJob),
      ...activeRuns.results.map((row) => {
        const last = phases.get(row.run_id);
        return { ...fromRun(row), phase: last ? `${PHASE_LABELS[last.phase]}${last.iteration > 1 ? ` (${last.iteration})` : ""}` : null };
      }),
    ],
    decisions,
    ended,
    budgets,
    repos: projects.map((project) => project.repo),
  };
}
