import { configuredSuperAdmins, listAccounts } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { githubJson, githubPost, installationToken } from "./github-app";
import type { Project } from "./projects";
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
