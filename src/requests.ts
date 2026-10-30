import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import type { FabriqueConfig } from "./fabrique-config";
import { refreshUserToken } from "./github";
import { githubPost, installationToken } from "./github-app";
import type { Project } from "./projects";
import { userToken } from "./session";
import { applyIssueEvent, loadStories, type RestIssue, type Story } from "./stories";

export const REQUEST_ROLES: readonly Role[] = ["super_admin", "product_engineer", "tech_lead"];

export function canRequest(role: Role): boolean {
  return REQUEST_ROLES.includes(role);
}

export type Rubrique = NonNullable<NonNullable<FabriqueConfig["demandes"]>["rubriques"]>[number];

export interface RequestDraft {
  title: string;
  answers: Record<string, string>;
}

export function readDraft(form: FormData, rubriques: Rubrique[]): RequestDraft {
  const answers: Record<string, string> = {};
  for (const rubrique of rubriques) answers[rubrique.cle] = String(form.get(`r_${rubrique.cle}`) ?? "").trim();
  return { title: String(form.get("title") ?? "").trim(), answers };
}

export function missingFields(draft: RequestDraft, rubriques: Rubrique[]): string[] {
  const missing = draft.title ? [] : ["Title"];
  for (const rubrique of rubriques) {
    if (rubrique.obligatoire && !draft.answers[rubrique.cle]) missing.push(rubrique.titre);
  }
  return missing;
}

// The issue keeps the project's own section titles, in the declared order.
export function issueBody(draft: RequestDraft, rubriques: Rubrique[], login: string): string {
  const sections = rubriques.map((rubrique) => `## ${rubrique.titre}\n\n${draft.answers[rubrique.cle] || "—"}`);
  return `${sections.join("\n\n")}\n\n---\nDemande de @${login} via La Fabrique extraordinaire`;
}

export type CreateOutcome =
  | { ok: true; number: number; url: string }
  | { ok: false; reason: "signed_out" | "refused"; status?: number };

export async function createRequest(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  draft: RequestDraft,
  rubriques: Rubrique[],
): Promise<CreateOutcome> {
  const clientId = env.GITHUB_APP_CLIENT_ID ?? "";
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET ?? "";
  const token = await userToken(request, env.DB, (refresh) => refreshUserToken(clientId, clientSecret, refresh));
  if (!token) return { ok: false, reason: "signed_out" };

  const label = project.check?.config?.demandes?.etiquettes?.["demande"];
  const response = await githubPost(token, `/repos/${project.repo}/issues`, {
    title: draft.title,
    body: issueBody(draft, rubriques, login),
    ...(label ? { labels: [label] } : {}),
  });
  if (response.status === 401) return { ok: false, reason: "signed_out" };
  if (!response.ok) return { ok: false, reason: "refused", status: response.status };
  const issue = (await response.json()) as RestIssue;

  // GitHub silently drops labels set by people without push access; the
  // App adds it then.
  const labelled = issue.labels.some((existing) => (typeof existing === "string" ? existing : existing.name) === label);
  if (label && !labelled) {
    const appToken = await installationToken(env, project.installationId);
    const added = await githubPost(appToken, `/repos/${project.repo}/issues/${issue.number}/labels`, { labels: [label] });
    if (added.ok) issue.labels = [...issue.labels, { name: label }];
  }

  await activityStatement(env.DB, {
    actor: login,
    action: "request_created",
    repo: project.repo,
    issueNumber: issue.number,
    details: { title: draft.title, url: issue.html_url },
  }).run();
  await applyIssueEvent(env, project.repo, "opened", issue);
  return { ok: true, number: issue.number, url: issue.html_url };
}

export type RequestStep = "open" | "ready" | "to_validate" | "closed";

export interface MyRequest {
  number: number;
  title: string;
  url: string | null;
  createdAt: string;
  step: RequestStep | null;
}

export function requestStep(story: Story, config: FabriqueConfig | null | undefined): RequestStep {
  if (story.state === "closed") return "closed";
  const labels = config?.demandes?.etiquettes ?? {};
  if (labels["a_valider"] && story.labels.includes(labels["a_valider"])) return "to_validate";
  if (labels["prete"] && story.labels.includes(labels["prete"])) return "ready";
  return "open";
}

export async function myRequests(env: Env, project: Project, login: string): Promise<{ requests: MyRequest[]; failure?: string }> {
  const { results } = await env.DB.prepare(
    `SELECT issue_number, details, occurred_at FROM activity_log
     WHERE action = 'request_created' AND actor = ? AND repo = ? ORDER BY id DESC`,
  )
    .bind(login, project.repo)
    .all<{ issue_number: number; details: string | null; occurred_at: string }>();
  if (!results.length) return { requests: [] };

  const { stories, failure } = await loadStories(env, project);
  const byNumber = new Map(stories.map((story) => [story.number, story]));
  const requests = results.map((row) => {
    const details = row.details ? (JSON.parse(row.details) as { title?: string; url?: string }) : {};
    const story = byNumber.get(row.issue_number);
    return {
      number: row.issue_number,
      title: story?.title ?? details.title ?? "",
      url: story?.url ?? details.url ?? null,
      createdAt: row.occurred_at,
      step: story ? requestStep(story, project.check?.config) : null,
    };
  });
  return failure ? { requests, failure } : { requests };
}
