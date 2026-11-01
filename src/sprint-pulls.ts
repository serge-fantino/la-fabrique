import { configuredSuperAdmins, listAccounts } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { dispatchRefusal, githubJson, githubPost, installationToken } from "./github-app";
import { sprintLiveFor } from "./live";
import { productionBranch, type Project } from "./projects";
import { can } from "./rights";
import type { Role } from "./accounts";
import { userToken } from "./session";

// The pull requests of the sprint's stories (la-fabrique#113): what each
// is waiting for, read from GitHub when the sprint is shown; a review asked
// from here, in the person's name.
export interface PullDetail {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  // Asked to review and not done yet.
  reviewers: string[];
  // Against its base branch, as GitHub computes it: "dirty" (in conflict),
  // "behind", "clean", "blocked", "unstable"…; null while GitHub computes.
  mergeable: string | null;
  base: string | null;
}

interface RestPullDetail {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  draft?: boolean;
  user: { login: string } | null;
  requested_reviewers?: { login: string }[];
  mergeable_state?: string;
  base?: { ref: string };
}

export async function pullDetails(env: Env, project: Project, numbers: number[]): Promise<Map<number, PullDetail>> {
  const found = new Map<number, PullDetail>();
  if (!numbers.length) return found;
  try {
    const token = await installationToken(env, project.installationId);
    const pulls = await Promise.all(
      [...new Set(numbers)].slice(0, 20).map((number) => githubJson<RestPullDetail>(token, `/repos/${project.repo}/pulls/${number}`).catch(() => null)),
    );
    for (const pull of pulls) {
      if (!pull) continue;
      found.set(pull.number, {
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
        draft: Boolean(pull.draft),
        author: pull.user?.login ?? null,
        reviewers: (pull.requested_reviewers ?? []).map((reviewer) => reviewer.login),
        mergeable: pull.mergeable_state && pull.mergeable_state !== "unknown" ? pull.mergeable_state : null,
        base: pull.base?.ref ?? null,
      });
    }
  } catch {
    // Without GitHub, the stories still show their pull requests' numbers.
  }
  return found;
}

// Who can be asked to review: the tech leads and super admins of La Fabrique.
export async function reviewers(env: Env): Promise<string[]> {
  const accounts = await listAccounts(env.DB);
  const logins = new Set([...configuredSuperAdmins(env), ...accounts.filter((account) => account.role === "tech_lead" || account.role === "super_admin").map((account) => account.github_login)]);
  return [...logins].sort((a, b) => a.localeCompare(b));
}

export async function requestReview(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  pull: number,
  reviewer: string,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const token = await userToken(request, env.DB, (refresh) => refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh));
  if (!token) return { ok: false, message: "GitHub no longer accepts your sign-in. Sign out and sign in again.", status: 401 };
  const response = await githubPost(token, `/repos/${project.repo}/pulls/${pull}/requested_reviewers`, { reviewers: [reviewer] });
  if (!response.ok) {
    return {
      ok: false,
      message:
        response.status === 422
          ? `GitHub refused: @${reviewer} must have access to the repository, and cannot review a pull request they opened.`
          : `GitHub refused the review request (HTTP ${response.status}).`,
      status: 502,
    };
  }
  await activityStatement(env.DB, { actor: login, action: "review_requested", repo: project.repo, issueNumber: pull, details: { reviewer } }).run();
  return { ok: true };
}

// Merging from La Fabrique: the project's own workflow (`workflows.fusionner`),
// which numbers and dates the release notes at the merge, checks again and
// merges. Into the production branch, it is a go: Product Engineer or super admin;
// into another branch (integration), a tech lead.
export function mergeWorkflow(project: Project): string | null {
  const file = project.check?.config?.workflows?.["fusionner"];
  return typeof file === "string" ? file : null;
}

export function canMerge(role: Role, project: Project, base: string | null): boolean {
  return can(role, base !== null && base !== (productionBranch(project) ?? "main") ? "launch_claude" : "promote");
}

export async function mergePull(env: Env, project: Project, login: string, pull: number): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const file = mergeWorkflow(project);
  if (!file) return { ok: false, message: "This project declares no merge workflow (workflows.fusionner).", status: 422 };
  try {
    const token = await installationToken(env, project.installationId);
    const ref = productionBranch(project) ?? "main";
    const response = await githubPost(token, `/repos/${project.repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref, inputs: { pr: String(pull), par: login } });
    if (!response.ok) return { ok: false, message: dispatchRefusal(file, ref, response.status, "take the pull request number as input"), status: 502 };
    await activityStatement(env.DB, { actor: login, action: "pull_merge_launched", repo: project.repo, issueNumber: pull, details: { workflow: file } }).run();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
}

// The end of a merge run (webhook workflow_run): merged, or refused and why
// (the run's "Merge refused" annotation), in the log; the open sprint pages
// reload to show it next to the pull request.
interface RestRun {
  id?: number;
  path?: string;
  display_title?: string;
  conclusion?: string | null;
  html_url?: string;
}

interface RestAnnotation {
  annotation_level?: string;
  title?: string | null;
  message?: string;
}

export async function mergeRunEvent(env: Env, project: Project, action: string, run: RestRun): Promise<boolean> {
  const file = mergeWorkflow(project);
  if (!file || action !== "completed" || !run.path?.endsWith(`/${file}`)) return false;
  const pull = Number(/#(\d+)/.exec(run.display_title ?? "")?.[1] ?? NaN);
  if (!Number.isInteger(pull)) return false;
  const reason = run.conclusion !== "success" && run.id ? await runFailure(env, project, run.id, "Merge refused") : null;
  await activityStatement(env.DB, {
    actor: "github",
    action: "pull_merge_finished",
    repo: project.repo,
    issueNumber: pull,
    details: { conclusion: run.conclusion ?? null, reason, url: run.html_url ?? null },
  }).run();
  await sprintLiveFor(env, project.repo)?.notify({ kind: "pull_request", issue: null, status: "merge", conclusion: run.conclusion ?? null, url: run.html_url ?? "", at: new Date().toISOString() });
  return true;
}

export interface MergeAttempt {
  conclusion: string | null;
  reason: string | null;
  url: string | null;
  at: string;
}

// The last merge run of each pull request, from the log.
export async function lastMergeAttempts(db: D1Database, repo: string): Promise<Map<number, MergeAttempt>> {
  const { results } = await db
    .prepare("SELECT occurred_at, issue_number, details FROM activity_log WHERE repo = ? AND action = 'pull_merge_finished' AND issue_number IS NOT NULL ORDER BY id")
    .bind(repo)
    .all<{ occurred_at: string; issue_number: number; details: string | null }>();
  const found = new Map<number, MergeAttempt>();
  for (const row of results) {
    const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    found.set(row.issue_number, {
      conclusion: typeof details["conclusion"] === "string" ? details["conclusion"] : null,
      reason: typeof details["reason"] === "string" ? details["reason"] : null,
      url: typeof details["url"] === "string" ? details["url"] : null,
      at: row.occurred_at,
    });
  }
  return found;
}

// Why a run failed: its annotation titled `title` (the workflow's ::error),
// else its first failure annotation; null when GitHub does not say.
export async function runFailure(env: Env, project: Project, runId: number, title: string): Promise<string | null> {
  try {
    const token = await installationToken(env, project.installationId);
    const { jobs } = await githubJson<{ jobs: { id: number; conclusion: string | null }[] }>(token, `/repos/${project.repo}/actions/runs/${runId}/jobs`);
    for (const job of jobs.filter((candidate) => candidate.conclusion === "failure")) {
      const annotations = await githubJson<RestAnnotation[]>(token, `/repos/${project.repo}/check-runs/${job.id}/annotations`);
      const failures = annotations.filter((note) => note.annotation_level === "failure" && note.message && !/^Process completed with exit code/.test(note.message));
      const found = failures.find((note) => note.title === title) ?? failures[0];
      if (found?.message) return found.message.slice(0, 500);
    }
  } catch {
    // The run's link says the rest.
  }
  return null;
}
