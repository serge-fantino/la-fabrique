import { can } from "./rights";
import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { dispatchRefusal, githubJson, githubPost, installationToken } from "./github-app";
import { productionBranch, type Project } from "./projects";
import { applyIssueEvent, type RestIssue } from "./stories";
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
