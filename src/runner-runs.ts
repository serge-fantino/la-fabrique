import { activityStatement } from "./activity-log";
import type { RestWorkflowRun } from "./claude";
import type { Env } from "./env";
import { githubJson, installationToken } from "./github-app";
import { costMicros, knownPrice, type TokenUse } from "./llm";
import type { Project } from "./projects";

// The runs of Claude in a project's runner (ADR 0004 § 4, epic F15,
// la-fabrique#418): the project's claude and revue workflows. Each run
// reports its usage in an annotation "Claude usage" (a JSON line, written by
// the workflow from Claude Code's execution file); La Fabrique reads it when
// the run ends, prices it at the API's rates and keeps the figures, never the
// run's content (its transcript stays an artifact of the project's run).

export const USAGE_TITLE = "Claude usage";

export interface ModelUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
}

export interface RunUsage {
  auth: "subscription" | "api";
  models: Record<string, ModelUsage>;
  turns: number | null;
  duration_ms: number | null;
  // Claude Code's own figure, at the API's rates.
  cost_usd: number | null;
}

const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const maybe = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

// The annotation's message, read; null when it is not one.
export function parseUsage(message: string): RunUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message.trim());
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const models: Record<string, ModelUsage> = {};
  if (typeof data["models"] === "object" && data["models"] !== null) {
    for (const [name, value] of Object.entries(data["models"] as Record<string, unknown>).slice(0, 10)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      models[name.slice(0, 80)] = {
        input: number(entry["input"]),
        output: number(entry["output"]),
        cache_read: number(entry["cache_read"]),
        cache_write: number(entry["cache_write"]),
        cost_usd: maybe(entry["cost_usd"]),
      };
    }
  }
  return {
    auth: data["auth"] === "api" ? "api" : "subscription",
    models,
    turns: maybe(data["turns"]),
    duration_ms: maybe(data["duration_ms"]),
    cost_usd: maybe(data["cost_usd"]),
  };
}

// Claude Code names a model as the API does, sometimes with a date or a
// context suffix: "claude-sonnet-5-5[1m]", "claude-haiku-4-5-20251001".
export function priceName(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

// What the run would cost on the API, in millionths of a dollar: La
// Fabrique's prices for the models it knows, Claude Code's figure for the
// others; null when neither says.
export function apiCost(usage: RunUsage): number | null {
  let total = 0;
  for (const [model, use] of Object.entries(usage.models)) {
    const name = priceName(model);
    if (knownPrice(name)) {
      const priced: TokenUse = { model: name, input: use.input, output: use.output, cacheRead: use.cache_read, cacheWrite: use.cache_write };
      total += costMicros([priced]) ?? 0;
    } else if (use.cost_usd !== null) {
      total += Math.round(use.cost_usd * 1_000_000);
    } else {
      return null;
    }
  }
  if (!Object.keys(usage.models).length) return usage.cost_usd === null ? null : Math.round(usage.cost_usd * 1_000_000);
  return total;
}

// The capability a run asks for, from the workflow and the run's name
// ("Claude #12", "Claude #12 · update #34", "Claude #12 · rework",
// "Claude #12 · update #34 · review", "Review #34").
export function runCapability(workflow: "claude" | "revue", title: string): { capability: string; story: number | null; pull: number | null } {
  if (workflow === "revue") return { capability: "review", story: null, pull: Number(/#(\d+)/.exec(title)?.[1] ?? NaN) || null };
  const story = Number(/#(\d+)/.exec(title)?.[1] ?? NaN) || null;
  const pull = Number(/update #(\d+)/.exec(title)?.[1] ?? NaN) || null;
  if (/·\s*rework/.test(title)) return { capability: "rework", story, pull };
  if (pull) return { capability: "update", story, pull };
  return { capability: "code", story, pull: null };
}

interface RestAnnotation {
  title?: string | null;
  message?: string | null;
  annotation_level?: string | null;
}

// The usage a run reported: the annotation of one of its jobs.
async function reportedUsage(env: Env, project: Project, runId: number): Promise<RunUsage | null> {
  const token = await installationToken(env, project.installationId);
  const { jobs } = await githubJson<{ jobs: { id: number }[] }>(token, `/repos/${project.repo}/actions/runs/${runId}/jobs`);
  for (const job of jobs.slice(0, 5)) {
    const annotations = await githubJson<RestAnnotation[]>(token, `/repos/${project.repo}/check-runs/${job.id}/annotations`);
    const found = annotations.find((note) => note.title === USAGE_TITLE && note.message);
    if (found?.message) return parseUsage(found.message);
  }
  return null;
}

function workflowOf(project: Project, path: string | undefined): "claude" | "revue" | null {
  const workflows = project.check?.config?.workflows ?? {};
  for (const key of ["claude", "revue"] as const) {
    const file = workflows[key];
    if (typeof file === "string" && file && path?.endsWith(`/${file}`)) return key;
  }
  return null;
}

// A run of the claude or revue workflow moved (webhook workflow_run): its row
// follows; once it ends, its usage is read and priced.
export async function runnerRunEvent(env: Env, project: Project, action: string, run: RestWorkflowRun): Promise<boolean> {
  const workflow = workflowOf(project, run.path);
  if (!workflow || !run.id) return false;
  const { capability, story, pull } = runCapability(workflow, run.display_title ?? "");
  const status = action === "completed" ? "completed" : (run.status ?? action);
  await env.DB.prepare(
    `INSERT INTO runner_runs (run_id, repo, workflow, capability, story, pull, status, conclusion, url, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, conclusion = excluded.conclusion,
       started_at = COALESCE(runner_runs.started_at, excluded.started_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(run.id, project.repo, workflow, capability, story, pull, status, run.conclusion ?? null, run.html_url ?? null, run.run_started_at ?? run.created_at ?? null)
    .run();
  if (action !== "completed" || run.conclusion === "cancelled" || run.conclusion === "skipped") return true;
  const usage = await reportedUsage(env, project, run.id).catch(() => null);
  const totals = usage ? Object.values(usage.models) : [];
  const sum = (key: keyof Omit<ModelUsage, "cost_usd">) => totals.reduce((total, use) => total + use[key], 0);
  const api = usage ? apiCost(usage) : null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE runner_runs SET finished_at = ?, auth = ?, models = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
         api_cost_micros = ?, real_cost_micros = ?, turns = ?, duration_ms = ? WHERE run_id = ?`,
    ).bind(
      run.updated_at ?? new Date().toISOString(),
      usage?.auth ?? null,
      usage ? JSON.stringify(usage.models) : null,
      sum("input"),
      sum("output"),
      sum("cache_read"),
      sum("cache_write"),
      api,
      usage ? (usage.auth === "api" ? api : 0) : null,
      usage?.turns ?? null,
      usage?.duration_ms ?? null,
      run.id,
    ),
    activityStatement(env.DB, {
      actor: "github",
      action: "runner_run_counted",
      repo: project.repo,
      ...(story ?? pull ? { issueNumber: (story ?? pull) as number } : {}),
      details: {
        run: run.id,
        capability,
        conclusion: run.conclusion ?? null,
        ...(usage ? { auth: usage.auth, models: Object.keys(usage.models), api_cost_micros: api } : { usage: "not reported" }),
      },
    }),
  ]);
  return true;
}

export interface RunnerUsage {
  runs: number;
  // Runs that reported their usage.
  counted: number;
  subscription: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  apiCostMicros: number;
  realCostMicros: number;
  last: string | null;
}

// The runs of each runner capability on a project, ended.
export async function runnerUsageOn(db: D1Database, repo: string): Promise<Map<string, RunnerUsage>> {
  const { results } = await db
    .prepare(
      `SELECT capability, COUNT(*) AS runs, SUM(CASE WHEN auth IS NOT NULL THEN 1 ELSE 0 END) AS counted,
         SUM(CASE WHEN auth = 'subscription' THEN 1 ELSE 0 END) AS subscription,
         SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
         COALESCE(SUM(api_cost_micros), 0) AS api, COALESCE(SUM(real_cost_micros), 0) AS real, MAX(finished_at) AS last
       FROM runner_runs WHERE repo = ? AND status = 'completed' GROUP BY capability`,
    )
    .bind(repo)
    .all<{ capability: string; runs: number; counted: number; subscription: number; input: number; output: number; cache_read: number; cache_write: number; api: number; real: number; last: string | null }>();
  return new Map(
    results.map((row) => [
      row.capability,
      {
        runs: row.runs,
        counted: row.counted,
        subscription: row.subscription,
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        apiCostMicros: row.api,
        realCostMicros: row.real,
        last: row.last,
      },
    ]),
  );
}
