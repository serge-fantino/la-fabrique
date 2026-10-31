import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { dispatchRefusal, githubFetch, githubPatch, githubPost, installationToken } from "./github-app";
import { isEpic } from "./lifecycle";
import { productionChanged, type ProductionStatus } from "./production";
import { productionBranch, type Project } from "./projects";
import { applyIssueEvent, type RestIssue, type Story } from "./stories";
import { storyChecks, type StoryChecks } from "./validation";
import type { RestWorkflowRun } from "./claude";
import { wordingFor } from "./wording";

// What the go would ship: the stories on int, and which are not validated.
export function goSummary(
  status: ProductionStatus,
  stories: Story[],
  checks: Map<number, StoryChecks>,
): { stories: Story[]; notValidated: Story[]; version: string | null } {
  const byNumber = new Map(stories.map((story) => [story.number, story]));
  const shipped = [...new Set(status.groups.flatMap((group) => group.issues))]
    .map((number) => byNumber.get(number))
    .filter((story): story is Story => Boolean(story) && !isEpic(story as Story));
  return {
    stories: shipped,
    notValidated: shipped.filter((story) => !checks.get(story.number)?.validated),
    version: status.waiting?.[0]?.version ?? null,
  };
}

export type GoOutcome = { ok: true } | { ok: false; message: string; status: 409 | 422 | 502 };

// Only a Product Engineer or a super admin gives the go; La Fabrique dispatches the project's
// own promotion workflow and keeps who gave it, when, and why if anyway.
export async function giveGo(
  env: Env,
  project: Project,
  login: string,
  status: ProductionStatus | null,
  summary: ReturnType<typeof goSummary> | null,
  reason: string,
): Promise<GoOutcome> {
  const file = project.check?.config?.workflows?.["promouvoir"];
  if (typeof file !== "string") return { ok: false, message: "This project declares no promotion workflow (workflows.promouvoir).", status: 422 };
  if (!status || !summary) return { ok: false, message: "What awaits production could not be read: try again in a moment.", status: 502 };
  if (status.aheadBy === 0) return { ok: false, message: "Production is up to date: nothing to promote.", status: 409 };
  if (!status.ready) return { ok: false, message: `Not ready for production: ${status.blockers[0]?.text ?? "see the blockers"}`, status: 409 };
  if (summary.notValidated.length && !reason) {
    return {
      ok: false,
      message: `${summary.notValidated.length} stor${summary.notValidated.length === 1 ? "y is" : "ies are"} not validated on int: say why you give the go anyway.`,
      status: 422,
    };
  }

  const token = await installationToken(env, project.installationId);
  const path = `/repos/${project.repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`;
  const ref = productionBranch(project) ?? "main";
  let response = await githubPost(token, path, { ref, inputs: { version: summary.version ?? "", par: login } });
  // A promotion workflow without these inputs: dispatched plain.
  if (response.status === 422) response = await githubPost(token, path, { ref });
  if (!response.ok) {
    return {
      ok: false,
      message: dispatchRefusal(file, ref, response.status, "accept workflow_dispatch"),
      status: 502,
    };
  }

  await activityStatement(env.DB, {
    actor: login,
    action: "go_given",
    repo: project.repo,
    details: {
      version: summary.version,
      commit: status.integrationHead,
      stories: summary.stories.map((story) => story.number),
      not_validated: summary.notValidated.map((story) => story.number),
      ...(reason ? { reason } : {}),
    },
  }).run();
  await productionChanged(env, project.repo);
  return { ok: true };
}

export interface LastGo {
  by: string;
  at: string;
  version: string | null;
  reason: string | null;
}

export async function lastGo(db: D1Database, repo: string): Promise<LastGo | null> {
  const row = await db
    .prepare("SELECT occurred_at, actor, details FROM activity_log WHERE repo = ? AND action = 'go_given' ORDER BY id DESC LIMIT 1")
    .bind(repo)
    .first<{ occurred_at: string; actor: string; details: string | null }>();
  if (!row) return null;
  const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
  return {
    by: row.actor,
    at: row.occurred_at,
    version: typeof details["version"] === "string" ? details["version"] : null,
    reason: typeof details["reason"] === "string" ? details["reason"] : null,
  };
}

// The promotion workflow ended well (webhook workflow_run): the stories of
// the last go that were validated on int are in production, so done; their
// issues are closed, with a word and in the log. A story sent anyway, not
// validated, stays open: To validate.
export async function promotionRunEvent(env: Env, project: Project, action: string, run: RestWorkflowRun): Promise<number[]> {
  const file = project.check?.config?.workflows?.["promouvoir"];
  if (typeof file !== "string" || action !== "completed" || run.conclusion !== "success" || !run.path?.endsWith(`/${file}`)) return [];
  const row = await env.DB.prepare("SELECT id, occurred_at, details FROM activity_log WHERE repo = ? AND action = 'go_given' ORDER BY id DESC LIMIT 1")
    .bind(project.repo)
    .first<{ id: number; occurred_at: string; details: string | null }>();
  if (!row) return [];
  // Once per go.
  const done = await env.DB.prepare("SELECT 1 AS found FROM activity_log WHERE repo = ? AND action = 'stories_shipped' AND id > ?").bind(project.repo, row.id).first();
  if (done) return [];
  const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
  const version = typeof details["version"] === "string" ? details["version"] : null;
  const stories = Array.isArray(details["stories"]) ? details["stories"].filter((n): n is number => typeof n === "number") : [];
  const checks = await storyChecks(env.DB, project.repo);
  const validated = stories.filter((number) => checks.get(number)?.validated);
  const closed: number[] = [];
  const words = wordingFor(project);
  const token = await installationToken(env, project.installationId);
  for (const number of validated) {
    const response = await githubFetch(token, `/repos/${project.repo}/issues/${number}`);
    if (!response.ok) continue;
    const issue = (await response.json()) as RestIssue;
    if (issue.state === "closed") continue;
    await githubPost(token, `/repos/${project.repo}/issues/${number}/comments`, { body: words.shipped(version) });
    const patched = await githubPatch(token, `/repos/${project.repo}/issues/${number}`, { state: "closed", state_reason: "completed" });
    if (!patched.ok) continue;
    await applyIssueEvent(env, project.repo, "closed", { ...issue, state: "closed", closed_at: new Date().toISOString() });
    closed.push(number);
  }
  await activityStatement(env.DB, {
    actor: "github",
    action: "stories_shipped",
    repo: project.repo,
    details: { version, closed, not_validated: stories.filter((number) => !validated.includes(number)), run: run.html_url ?? null },
  }).run();
  return closed;
}
