import type { Env } from "./env";
import { githubJson, installationToken } from "./github-app";
import { describeFailure, type Project } from "./projects";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";

export const DELIVERY = "delivery";
const MAX_AGE_MS = 5 * 60 * 1000;
const DAYS = 30;
const MAX_PAGES = 3;

export const WORKFLOW_LABELS: Record<string, string> = {
  ci: "CI",
  deploiement_int: "Deployment to int",
  migrations_production: "Production migrations",
  promouvoir: "Promotion to production",
  claude: "Claude",
};

export interface Run {
  workflow: string;
  title: string;
  branch: string;
  sha: string;
  event: string;
  result: "success" | "failure" | "running" | "other";
  conclusion: string | null;
  startedAt: string;
  seconds: number | null;
  url: string;
}

export interface WorkflowSummary {
  key: string;
  file: string;
  runs: number;
  successRate: number | null;
  medianSeconds: number | null;
  streak: { result: "success" | "failure"; count: number } | null;
  lastFailure: Run | null;
  recent: Run[];
}

export interface DeliveryData {
  since: string;
  runs: Run[];
}

interface RestRun {
  name: string;
  display_title: string;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_started_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

function toRun(workflow: string, run: RestRun): Run {
  const startedAt = run.run_started_at ?? run.created_at;
  const completed = run.status === "completed";
  return {
    workflow,
    title: run.display_title,
    branch: run.head_branch ?? "",
    sha: run.head_sha,
    event: run.event,
    result: !completed
      ? "running"
      : run.conclusion === "success"
        ? "success"
        : run.conclusion === "failure" || run.conclusion === "timed_out"
          ? "failure"
          : "other",
    conclusion: run.conclusion,
    startedAt,
    seconds: completed ? Math.max(0, Math.round((Date.parse(run.updated_at) - Date.parse(startedAt)) / 1000)) : null,
    url: run.html_url,
  };
}

function declaredWorkflows(project: Project): [string, string][] {
  return Object.entries(project.check?.config?.workflows ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

async function fetchDelivery(env: Env, project: Project, since: string): Promise<DeliveryData> {
  const token = await installationToken(env, project.installationId);
  const runs: Run[] = [];
  for (const [key, file] of declaredWorkflows(project)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubJson<{ workflow_runs: RestRun[] }>(
        token,
        `/repos/${project.repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=100&created=%3E%3D${since}&page=${page}`,
      );
      runs.push(...data.workflow_runs.map((run) => toRun(key, run)));
      if (data.workflow_runs.length < 100) break;
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { since, runs };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? null) : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

// Runs come newest first.
export function summarize(key: string, file: string, runs: Run[]): WorkflowSummary {
  const done = runs.filter((run) => run.result === "success" || run.result === "failure");
  let streak: WorkflowSummary["streak"] = null;
  for (const run of done) {
    if (run.result !== "success" && run.result !== "failure") continue;
    if (!streak) streak = { result: run.result, count: 1 };
    else if (streak.result === run.result) streak.count++;
    else break;
  }
  return {
    key,
    file,
    runs: runs.length,
    successRate: done.length ? done.filter((run) => run.result === "success").length / done.length : null,
    medianSeconds: median(runs.filter((run) => run.result === "success" && run.seconds !== null).map((run) => run.seconds ?? 0)),
    streak,
    lastFailure: runs.find((run) => run.result === "failure") ?? null,
    recent: runs.slice(0, 30),
  };
}

export interface DeliveryView {
  summaries: WorkflowSummary[];
  runs: Run[];
  days: string[];
  fetchedAt: string | null;
  failure?: string;
}

export async function loadDelivery(env: Env, project: Project, now = new Date()): Promise<DeliveryView> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DAYS - 1)));
  const since = start.toISOString().slice(0, 10);
  const days = Array.from({ length: DAYS }, (_, index) =>
    new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  );

  let snapshot = await readSnapshot<DeliveryData>(env.DB, project.repo, DELIVERY);
  let failure: string | undefined;
  if (!snapshot || !isFresh(snapshot, MAX_AGE_MS) || snapshot.data.since !== since) {
    try {
      const data = await fetchDelivery(env, project, since);
      snapshot = { data, fetchedAt: await writeSnapshot(env.DB, project.repo, DELIVERY, data) };
    } catch (error) {
      failure = describeFailure(error);
    }
  }
  const runs = snapshot?.data.runs ?? [];
  const summaries = declaredWorkflows(project).map(([key, file]) =>
    summarize(key, file, runs.filter((run) => run.workflow === key)),
  );
  return { summaries, runs, days, fetchedAt: snapshot?.fetchedAt ?? null, ...(failure ? { failure } : {}) };
}

export async function deliveryChanged(env: Env, repo: string): Promise<void> {
  await markStale(env.DB, repo, DELIVERY);
}
