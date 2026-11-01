import { can } from "./rights";
import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { dispatchRefusal, githubJson, githubPost, installationToken } from "./github-app";
import { productionBranch, type Project } from "./projects";
import { developmentLinks, pullStories } from "./pull-links";
import { applyIssueEvent, STORIES, type RestIssue } from "./stories";
import { storyCards } from "./card-groups";
import { heldStories, waitReason } from "./card-lock";
import { cardStories } from "./card-stories";
import { sprintLiveFor } from "./live";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";
import { wordingFor } from "./wording";

export const DEFAULT_CAP = 2;

export function canLaunchClaude(role: Role): boolean {
  return can(role, "launch_claude");
}

export function claudeWorkflow(project: Project): string | null {
  const file = project.check?.config?.workflows?.["claude"];
  return typeof file === "string" ? file : null;
}

export function claudeCap(project: Project): number {
  return project.check?.config?.claude?.plafond ?? DEFAULT_CAP;
}

interface RestRun {
  status: string;
  html_url: string;
  display_title?: string;
}

// The stories Claude is working on now, from the runs' names ("Claude #12").
function workingOn(runs: RestRun[]): Set<number> {
  return new Set(
    runs
      .filter((run) => run.status !== "completed")
      .map((run) => Number(/#(\d+)/.exec(run.display_title ?? "")?.[1] ?? NaN))
      .filter((number) => Number.isInteger(number)),
  );
}

// One story at a time per card (la-fabrique#159): the story in progress
// that this one waits for, if any.
async function waitingFor(env: Env, project: Project, number: number, running: Set<number>): Promise<string | null> {
  const links = await storyCards(env.DB, project.repo);
  const cards = links.byStory.get(number) ?? [];
  if (!cards.length) return null;
  const siblings = [...new Set(cards.flatMap((card) => links.order.get(card) ?? []))];
  const stories = await cardStories(env, project, siblings);
  const busy = heldStories(links, stories, running, cards).get(number);
  return busy ? waitReason(number, busy) : null;
}

export type LaunchOutcome = { ok: true; running: number } | { ok: false; message: string; status: 409 | 422 | 502 };

// Running Claude costs and writes code: the project's own workflow, a cap
// of runs at once, who launched it in the log and on the issue.
export async function launchClaude(env: Env, project: Project, login: string, number: number): Promise<LaunchOutcome> {
  const file = claudeWorkflow(project);
  if (!file) return { ok: false, message: "This project declares no Claude workflow (workflows.claude).", status: 422 };
  const repo = project.repo;
  try {
    const token = await installationToken(env, project.installationId);
    const runs = await githubJson<{ workflow_runs: RestRun[] }>(token, `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=30`);
    const running = runs.workflow_runs.filter((run) => run.status !== "completed").length;
    const cap = claudeCap(project);
    if (running >= cap) {
      return { ok: false, message: `Claude already runs ${running} time${running > 1 ? "s" : ""} on this project (cap ${cap}): wait for one to end.`, status: 409 };
    }
    const waits = await waitingFor(env, project, number, workingOn(runs.workflow_runs));
    if (waits) return { ok: false, message: waits, status: 409 };

    const path = `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`;
    const ref = productionBranch(project) ?? "main";
    let response = await githubPost(token, path, { ref, inputs: { issue: String(number), par: login } });
    if (response.status === 422) response = await githubPost(token, path, { ref, inputs: { issue: String(number) } });
    if (!response.ok) {
      return {
        ok: false,
        message: dispatchRefusal(file, ref, response.status, "take the issue number as input"),
        status: 502,
      };
    }

    // The circuit's "ready for Claude" label, and a word on the issue.
    const ready = project.check?.config?.demandes?.etiquettes?.["prete"];
    if (ready) {
      const labelled = await githubPost(token, `/repos/${repo}/issues/${number}/labels`, { labels: [ready] });
      if (labelled.ok) {
        const issue = await githubJson<RestIssue>(token, `/repos/${repo}/issues/${number}`).catch(() => null);
        if (issue) await applyIssueEvent(env, repo, "labeled", issue);
      }
    }
    const runsUrl = `https://github.com/${repo}/actions/workflows/${encodeURIComponent(file)}`;
    await githubPost(token, `/repos/${repo}/issues/${number}/comments`, { body: wordingFor(project).claudeLaunched(login, runsUrl) });

    await activityStatement(env.DB, {
      actor: login,
      action: "claude_launched",
      repo,
      issueNumber: number,
      details: { workflow: file, running: running + 1, cap },
    }).run();
    await env.DB.prepare("DELETE FROM snapshots WHERE repo = ? AND kind = ?").bind(repo, CLAUDE_RUNS).run();
    return { ok: true, running: running + 1 };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
}

// "Update with Claude" (la-fabrique#113): the same workflow with `pr`, on
// an open pull request of the story: Claude merges its base branch into it,
// resolves the conflicts, checks again and pushes to the same branch.
export async function updateWithClaude(env: Env, project: Project, login: string, story: number, pull: number): Promise<LaunchOutcome> {
  const file = claudeWorkflow(project);
  if (!file) return { ok: false, message: "This project declares no Claude workflow (workflows.claude).", status: 422 };
  const repo = project.repo;
  try {
    const token = await installationToken(env, project.installationId);
    const runs = await githubJson<{ workflow_runs: RestRun[] }>(token, `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=30`);
    const running = runs.workflow_runs.filter((run) => run.status !== "completed").length;
    const cap = claudeCap(project);
    if (running >= cap) {
      return { ok: false, message: `Claude already runs ${running} time${running > 1 ? "s" : ""} on this project (cap ${cap}): wait for one to end.`, status: 409 };
    }
    const ref = productionBranch(project) ?? "main";
    const response = await githubPost(token, `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
      ref,
      inputs: { issue: String(story), par: login, pr: String(pull) },
    });
    if (!response.ok) {
      return {
        ok: false,
        message:
          response.status === 422
            ? `GitHub refused to start ${file} with a pull request: the workflow on ${ref} needs a \`pr\` input (see Setup, Claude Code).`
            : dispatchRefusal(file, ref, response.status, "take the issue and pull request numbers as inputs"),
        status: 502,
      };
    }
    const runsUrl = `https://github.com/${repo}/actions/workflows/${encodeURIComponent(file)}`;
    await githubPost(token, `/repos/${repo}/issues/${pull}/comments`, { body: wordingFor(project).claudeUpdating(login, runsUrl) });
    await activityStatement(env.DB, {
      actor: login,
      action: "claude_update_launched",
      repo,
      issueNumber: story,
      details: { workflow: file, pull, running: running + 1, cap },
    }).run();
    await env.DB.prepare("DELETE FROM snapshots WHERE repo = ? AND kind = ?").bind(repo, CLAUDE_RUNS).run();
    return { ok: true, running: running + 1 };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
}

// When Claude was last launched on each story, from the log.
export async function claudeLaunches(db: D1Database, repo: string): Promise<Map<number, { by: string; at: string }>> {
  const { results } = await db
    .prepare(
      "SELECT occurred_at, actor, issue_number FROM activity_log WHERE repo = ? AND action = 'claude_launched' AND issue_number IS NOT NULL ORDER BY id",
    )
    .bind(repo)
    .all<{ occurred_at: string; actor: string; issue_number: number }>();
  return new Map(results.map((row) => [row.issue_number, { by: row.actor, at: row.occurred_at }]));
}

// The runs of the project's Claude workflow (la-fabrique#113), newest
// first: their story (from the run's name, "Claude #12"), state and link.
// Read from GitHub at most every 30 seconds.
export interface ClaudeRun {
  issue: number | null;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

const CLAUDE_RUNS = "claude_runs";
const RUNS_MAX_AGE_MS = 30_000;

interface RestClaudeRun {
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export async function claudeRuns(env: Env, project: Project): Promise<ClaudeRun[]> {
  const file = claudeWorkflow(project);
  if (!file) return [];
  const snapshot = await readSnapshot<ClaudeRun[]>(env.DB, project.repo, CLAUDE_RUNS);
  if (snapshot && isFresh(snapshot, RUNS_MAX_AGE_MS)) return snapshot.data;
  try {
    const token = await installationToken(env, project.installationId);
    const found = await githubJson<{ workflow_runs: RestClaudeRun[] }>(
      token,
      `/repos/${project.repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=30`,
    );
    const runs = found.workflow_runs.map((run) => ({
      issue: Number(/#(\d+)/.exec(run.display_title)?.[1] ?? NaN) || null,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    }));
    await writeSnapshot(env.DB, project.repo, CLAUDE_RUNS, runs);
    return runs;
  } catch {
    return snapshot?.data ?? [];
  }
}

export function isRunning(run: ClaudeRun): boolean {
  return run.status !== "completed";
}

// GitHub's workflow_run webhook for the project's Claude workflow: the
// sprint reads its runs again, its open pages are told, and a run that
// ends is written in the log.
export interface RestWorkflowRun {
  id?: number;
  path?: string;
  display_title?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  updated_at?: string;
  run_started_at?: string;
  created_at?: string;
}

interface RestRecentPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  head: { ref: string };
}

// The pull request a finished run opened (created since it started, and
// linked to its story) or updated ("Claude #12 · update #30"): written in
// the log, so story → run → pull request is traced (principle 4).
async function logRunPull(env: Env, project: Project, issue: number, run: RestWorkflowRun): Promise<void> {
  const updated = Number(/update #(\d+)/.exec(run.display_title ?? "")?.[1] ?? NaN);
  const details = (pull: number, url: string | null) => ({ pull, url, run: run.html_url ?? null, conclusion: run.conclusion ?? null });
  if (Number.isInteger(updated)) {
    await activityStatement(env.DB, { actor: "github", action: "claude_pr_updated", repo: project.repo, issueNumber: issue, details: details(updated, null) }).run();
    return;
  }
  const since = run.run_started_at ?? run.created_at;
  if (!since) return;
  try {
    const token = await installationToken(env, project.installationId);
    const [pulls, links] = await Promise.all([
      githubJson<RestRecentPull[]>(token, `/repos/${project.repo}/pulls?state=all&sort=created&direction=desc&per_page=20`),
      developmentLinks(token, project.repo),
    ]);
    for (const pull of pulls) {
      if (pull.created_at < since || !pullStories(pull, links).stories.includes(issue)) continue;
      await activityStatement(env.DB, { actor: "github", action: "claude_pr_opened", repo: project.repo, issueNumber: issue, details: details(pull.number, pull.html_url) }).run();
    }
  } catch {
    // The run is logged anyway; the stories, read again, still show the PR.
  }
}

export async function claudeRunEvent(env: Env, project: Project, action: string, run: RestWorkflowRun): Promise<boolean> {
  const file = claudeWorkflow(project);
  if (!file || !run.path || !run.path.endsWith(`/${file}`)) return false;
  await env.DB.prepare("DELETE FROM snapshots WHERE repo = ? AND kind = ?").bind(project.repo, CLAUDE_RUNS).run();
  const issue = Number(/#(\d+)/.exec(run.display_title ?? "")?.[1] ?? NaN) || null;
  if (action === "completed") {
    await activityStatement(env.DB, {
      actor: "github",
      action: "claude_run_finished",
      repo: project.repo,
      ...(issue ? { issueNumber: issue } : {}),
      details: { conclusion: run.conclusion ?? null, url: run.html_url ?? null },
    }).run();
    if (issue) {
      await logRunPull(env, project, issue, run);
      await markStale(env.DB, project.repo, STORIES);
    }
  }
  await sprintLiveFor(env, project.repo)?.notify({
    kind: "claude_run",
    issue,
    status: run.status ?? action,
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? "",
    at: run.updated_at ?? new Date().toISOString(),
  });
  return true;
}
