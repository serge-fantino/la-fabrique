import type { Env } from "./env";
import { listInstalledRepos } from "./github-app";
import { html, redirect } from "./http";
import { newProjectPage, projectPage, projectsPage } from "./project-views";
import {
  addProject,
  checkOtherBranch,
  checkProject,
  describeFailure,
  findProject,
  isBranchName,
  isRepoName,
  listProjects,
  productionBranch,
  type Project,
} from "./projects";
import { globToRegExp } from "./production";
import { readSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";
import { groupStories, loadStories, type StoryFilters } from "./stories";
import { storiesPage } from "./stories-views";
import { loadProduction } from "./production";
import { productionPage } from "./production-views";
import { canRequest, createRequest, missingFields, myRequests, readDraft, type Rubrique } from "./requests";
import { requestFormPage, requestsPage } from "./requests-views";
import { loadActivity, RANGES } from "./activity";
import { activityPage } from "./activity-views";
import { messagePage, type Viewer } from "./views";

export async function showProjects(env: Env, viewer: Viewer): Promise<Response> {
  return html(projectsPage(viewer, await listProjects(env.DB)));
}

export async function showNewProject(request: Request, env: Env, viewer: Viewer): Promise<Response> {
  const notice = new URL(request.url).searchParams.get("notice") ?? undefined;
  try {
    const declared = new Set((await listProjects(env.DB)).map((project) => project.repo.toLowerCase()));
    const repos = (await listInstalledRepos(env)).filter((repo) => !declared.has(repo.repo.toLowerCase()));
    return html(newProjectPage(viewer, { repos, notice }));
  } catch (error) {
    return html(newProjectPage(viewer, { repos: [], error: describeFailure(error) }));
  }
}

export async function createProject(form: FormData, env: Env, viewer: Viewer): Promise<Response> {
  const repo = String(form.get("repo") ?? "");
  if (!isRepoName(repo)) return redirect("/projects/new?notice=invalid");

  let installed;
  try {
    installed = await listInstalledRepos(env);
  } catch (error) {
    return html(newProjectPage(viewer, { repos: [], error: describeFailure(error) }));
  }
  // The installation is looked up again server-side, never taken from the form.
  const match = installed.find((candidate) => candidate.repo.toLowerCase() === repo.toLowerCase());
  if (!match) return redirect("/projects/new?notice=not_installed");

  if (!(await findProject(env.DB, match.repo))) {
    await addProject(env.DB, match.repo, match.installationId, viewer.login);
  }
  const project = await findProject(env.DB, match.repo);
  const outcome = project ? await checkProject(env, project) : { ok: false };
  return redirect(`/projects/${match.repo}?notice=${outcome.ok ? "added" : "added_unchecked"}`);
}

function notFound(viewer: Viewer): Response {
  return html(messagePage("Not found", "There is no such project in La Fabrique extraordinaire.", viewer), { status: 404 });
}

export async function showProject(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  let project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);

  let failure: string | undefined;
  if (!project.check) {
    const outcome = await checkProject(env, project);
    if (outcome.ok) project = { ...project, check: outcome.check };
    else failure = outcome.message;
  }
  const url = new URL(request.url);
  const notice = url.searchParams.get("notice") ?? undefined;
  const choices = await branchChoices(env, project);
  const requested = url.searchParams.get("ref");
  const ref = requested && isBranchName(requested) && requested !== choices[0] ? requested : null;
  if (!ref) return html(projectPage(viewer, project, { notice, failure, choices }));

  const outcome = await checkOtherBranch(env, project, ref);
  if (!outcome.ok) return html(projectPage(viewer, project, { failure: outcome.message, choices }), { status: 404 });
  const listed = choices.includes(ref) ? choices : [...choices, ref];
  return html(projectPage(viewer, project, { notice, choices: listed, ref, branchCheck: outcome.check }));
}

// Production first, then integration and the working branches the stories
// board knows of.
async function branchChoices(env: Env, project: Project): Promise<string[]> {
  const production = productionBranch(project);
  if (!production) return [];
  const branches = project.check?.config?.branches;
  const patterns = (branches?.travail ?? []).map(globToRegExp);
  const stories = await readSnapshot<Story[]>(env.DB, project.repo, STORIES);
  const working = [...new Set((stories?.data ?? []).flatMap((story) => story.branches))]
    .filter((branch) => patterns.some((pattern) => pattern.test(branch)))
    .sort();
  return [...new Set([production, ...(branches?.integration ? [branches.integration] : []), ...working])];
}

export async function recheckProject(env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const outcome = await checkProject(env, project, true);
  if (outcome.ok) return redirect(`/projects/${project.repo}?notice=checked`);
  return html(projectPage(viewer, project, { failure: outcome.message }));
}

function parseFilters(url: URL): StoryFilters {
  const epic = Number(url.searchParams.get("epic"));
  const state = url.searchParams.get("state");
  return {
    epic: Number.isInteger(epic) && epic > 0 ? epic : null,
    label: url.searchParams.get("label") || null,
    state: state === "open" || state === "closed" ? state : "all",
    mine: url.searchParams.get("mine") === "1",
  };
}

export async function showStories(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const filters = parseFilters(new URL(request.url));
  const { stories, fetchedAt, failure } = await loadStories(env, project);
  return html(
    storiesPage(viewer, project, {
      stories,
      groups: groupStories(stories, filters, viewer.login),
      filters,
      fetchedAt,
      failure,
    }),
  );
}

export async function showProduction(env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  return html(productionPage(viewer, project, await loadProduction(env, project)));
}

function forbidden(viewer: Viewer): Response {
  return html(messagePage("Not allowed", "Your role does not let you write requests.", viewer), { status: 403 });
}

function rubriquesOf(project: Project): Rubrique[] {
  return project.check?.config?.demandes?.rubriques ?? [];
}

export async function showRequests(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const created = Number(new URL(request.url).searchParams.get("created"));
  const { requests, failure } = await myRequests(env, project, viewer.login);
  return html(
    requestsPage(viewer, project, {
      requests,
      canCreate: canRequest(viewer.role),
      created: Number.isInteger(created) && created > 0 ? created : undefined,
      failure,
    }),
  );
}

export async function showRequestForm(env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!canRequest(viewer.role)) return forbidden(viewer);
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  return html(requestFormPage(viewer, project, { rubriques: rubriquesOf(project) }));
}

export async function submitRequest(
  request: Request,
  form: FormData,
  env: Env,
  viewer: Viewer,
  repo: string,
): Promise<Response> {
  if (!canRequest(viewer.role)) return forbidden(viewer);
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const rubriques = rubriquesOf(project);
  if (!rubriques.length) return html(requestFormPage(viewer, project, { rubriques }), { status: 422 });

  const draft = readDraft(form, rubriques);
  const missing = missingFields(draft, rubriques);
  if (missing.length) return html(requestFormPage(viewer, project, { rubriques, draft, missing }), { status: 422 });

  const outcome = await createRequest(request, env, project, viewer.login, draft, rubriques);
  if (outcome.ok) return redirect(`/projects/${project.repo}/requests?created=${outcome.number}`);
  const error =
    outcome.reason === "signed_out"
      ? "GitHub no longer accepts your sign-in. Sign out and sign in again; your draft stays on this device."
      : `GitHub refused to create the issue (HTTP ${outcome.status ?? "?"}). Your GitHub account may not have access to this repository.`;
  return html(requestFormPage(viewer, project, { rubriques, draft, error }), { status: 502 });
}

export async function showActivity(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const days = Number(new URL(request.url).searchParams.get("days"));
  const range = RANGES.find((candidate) => candidate === days) ?? RANGES[0];
  return html(activityPage(viewer, project, await loadActivity(env, project, range)));
}
