import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { githubDelete, githubFetch, githubPatch, githubPost, installationToken } from "./github-app";
import { PRODUCTION, type ProductionStatus } from "./production";
import { productionBranch, type Project } from "./projects";
import { userToken } from "./session";
import { readSnapshot } from "./snapshots";
import { acceptanceCriteria, applyIssueEvent, setCriterion, type RestIssue } from "./stories";
import { can } from "./rights";
import { wordingFor } from "./wording";

export function canValidate(role: Role): boolean {
  return can(role, "validate");
}

export type ValidationOutcome = { ok: true } | { ok: false; message: string; status: 409 | 422 | 502 };

const CHANGED: ValidationOutcome = {
  ok: false,
  message: "The issue changed on GitHub meanwhile: reload the page and try again.",
  status: 409,
};

// Writes as the person when GitHub lets them, else as the App (a tester
// may not have write access to the repository); the log says who did it.
async function write(
  request: Request,
  env: Env,
  project: Project,
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const token = await userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
  if (token) {
    const response = await send(token);
    if (response.status !== 401 && response.status !== 403 && response.status !== 404) return response;
  }
  return send(await installationToken(env, project.installationId));
}

async function readIssue(env: Env, project: Project, number: number): Promise<RestIssue | null> {
  const token = await installationToken(env, project.installationId);
  const response = await githubFetch(token, `/repos/${project.repo}/issues/${number}`);
  return response.ok ? ((await response.json()) as RestIssue) : null;
}

// The version int runs, from the last production read.
async function intVersion(env: Env, project: Project): Promise<string | null> {
  const status = (await readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION))?.data;
  const production = productionBranch(project);
  return status?.versions.find((version) => version.environment !== "production" && version.environment !== production)?.version ?? null;
}

export async function tickCriterion(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  number: number,
  index: number,
  text: string,
  done: boolean,
): Promise<ValidationOutcome> {
  try {
    const issue = await readIssue(env, project, number);
    if (!issue) return { ok: false, message: `Issue #${number} could not be read.`, status: 502 };
    const body = setCriterion(issue.body ?? "", index, text, done);
    if (body === null) return CHANGED;
    const response = await write(request, env, project, (token) =>
      githubPatch(token, `/repos/${project.repo}/issues/${number}`, { body }),
    );
    if (!response.ok) return { ok: false, message: `GitHub refused the change (HTTP ${response.status}).`, status: 502 };
    await applyIssueEvent(env, project.repo, "edited", (await response.json()) as RestIssue);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
  await activityStatement(env.DB, {
    actor: login,
    action: done ? "criterion_checked" : "criterion_unchecked",
    repo: project.repo,
    issueNumber: number,
    details: { index, text },
  }).run();
  return { ok: true };
}

export async function validateStory(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  number: number,
): Promise<ValidationOutcome> {
  const words = wordingFor(project);
  let version: string | null = null;
  try {
    const issue = await readIssue(env, project, number);
    if (!issue) return { ok: false, message: `Issue #${number} could not be read.`, status: 502 };
    const criteria = acceptanceCriteria(issue.body);
    if (criteria.some((criterion) => !criterion.done)) {
      return { ok: false, message: "Every acceptance criterion must be checked before validating.", status: 422 };
    }
    // Without an integration branch, the story is checked where it is
    // online, not released yet: validated, its issue stays open until the
    // release at the close of the sprint (la-fabrique#139).
    const inProduction = !project.check?.config?.branches?.integration;
    version = inProduction ? null : await intVersion(env, project);
    const comment = await write(request, env, project, (token) =>
      githubPost(token, `/repos/${project.repo}/issues/${number}/comments`, {
        body: inProduction ? words.validatedInProduction(login) : words.validated(login, version),
      }),
    );
    if (!comment.ok) return { ok: false, message: `GitHub refused the comment (HTTP ${comment.status}).`, status: 502 };
    const toValidate = project.check?.config?.demandes?.etiquettes?.["a_valider"];
    const labels = issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? "")));
    if (toValidate && labels.includes(toValidate)) {
      const app = await installationToken(env, project.installationId);
      await githubDelete(app, `/repos/${project.repo}/issues/${number}/labels/${encodeURIComponent(toValidate)}`);
      await applyIssueEvent(env, project.repo, "edited", {
        ...issue,
        labels: issue.labels.filter((label) => (typeof label === "string" ? label : label.name) !== toValidate),
      });
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
  await activityStatement(env.DB, {
    actor: login,
    action: "story_validated",
    repo: project.repo,
    issueNumber: number,
    details: { version },
  }).run();
  return { ok: true };
}

export interface Defect {
  title: string;
  did: string;
  saw: string;
  expected: string;
}

export function readDefect(form: FormData): Defect | null {
  const field = (name: string, max: number) => String(form.get(name) ?? "").trim().slice(0, max);
  const defect = { title: field("title", 200), did: field("did", 4000), saw: field("saw", 4000), expected: field("expected", 4000) };
  return defect.title && defect.saw ? defect : null;
}

export async function reportDefect(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  story: number,
  defect: Defect,
): Promise<ValidationOutcome & { number?: number }> {
  const words = wordingFor(project);
  const version = await intVersion(env, project);
  const body = [
    words.defectIntro(story),
    `## ${words.did}\n\n${defect.did || "—"}`,
    `## ${words.saw}\n\n${defect.saw}`,
    `## ${words.expected}\n\n${defect.expected || "—"}`,
    `---\n${words.defectSignature(login, version)}`,
  ].join("\n\n");
  let created: RestIssue;
  try {
    const response = await write(request, env, project, (token) =>
      githubPost(token, `/repos/${project.repo}/issues`, { title: defect.title, body }),
    );
    if (!response.ok) return { ok: false, message: `GitHub refused the issue (HTTP ${response.status}).`, status: 502 };
    created = (await response.json()) as RestIssue;
    await write(request, env, project, (token) =>
      githubPost(token, `/repos/${project.repo}/issues/${story}/comments`, { body: words.defectOnStory(login, created.number) }),
    );
    await applyIssueEvent(env, project.repo, "opened", created);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
  await activityStatement(env.DB, {
    actor: login,
    action: "defect_reported",
    repo: project.repo,
    issueNumber: story,
    details: { defect: created.number, title: defect.title, version },
  }).run();
  return { ok: true, number: created.number };
}

export interface StoryChecks {
  validated: { by: string; at: string; version: string | null } | null;
  defects: number[];
}

// What GitHub does not keep: who validated each story, and the defects
// reported from La Fabrique, from the log.
export async function storyChecks(db: D1Database, repo: string): Promise<Map<number, StoryChecks>> {
  const { results } = await db
    .prepare(
      `SELECT occurred_at, actor, action, issue_number, details FROM activity_log
       WHERE repo = ? AND action IN ('story_validated', 'defect_reported', 'defect_linked')
       ORDER BY id`,
    )
    .bind(repo)
    .all<{ occurred_at: string; actor: string; action: string; issue_number: number | null; details: string | null }>();
  const checks = new Map<number, StoryChecks>();
  const entry = (story: number) => {
    const found = checks.get(story) ?? { validated: null, defects: [] };
    checks.set(story, found);
    return found;
  };
  // A defect goes with the story of its latest link: the report, then triage.
  const links = new Map<number, number | null>();
  for (const row of results) {
    const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    if (row.action === "story_validated") {
      if (row.issue_number !== null) {
        entry(row.issue_number).validated = { by: row.actor, at: row.occurred_at, version: typeof details["version"] === "string" ? details["version"] : null };
      }
    } else if (typeof details["defect"] === "number") {
      links.set(details["defect"], row.issue_number);
    }
  }
  for (const [defect, story] of links) {
    if (story !== null) entry(story).defects.push(defect);
  }
  return checks;
}
