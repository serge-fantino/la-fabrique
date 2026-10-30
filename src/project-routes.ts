import type { Env } from "./env";
import { listInstalledRepos } from "./github-app";
import { html, json, redirect } from "./http";
import { newProjectPage, projectPage, projectsPage, type ProjectView } from "./project-views";
import {
  addProject,
  checkOtherBranch,
  checkProject,
  describeFailure,
  findProject,
  isRepoName,
  listProjects,
  productionBranch,
  type Project,
} from "./projects";
import { groupStories, loadStories, type StoryFilters } from "./stories";
import { storiesPage } from "./stories-views";
import { loadProduction, productionReady } from "./production";
import { productionPage } from "./production-views";
import { canRequest, createRequest, missingFields, myRequests, readDraft, type Rubrique } from "./requests";
import { requestFormPage, requestsPage } from "./requests-views";
import { loadActivity, RANGES } from "./activity";
import { activityPage } from "./activity-views";
import { deliveryReady, loadDelivery } from "./delivery";
import { deliveryContent, deliveryLoading, deliveryPage } from "./delivery-views";
import { epicProgress, loadReleases, storiesBetween, type Release } from "./roadmap";
import { releasesPage, roadmapPage } from "./roadmap-views";
import { messagePage, type Viewer } from "./views";
import { loadBranches } from "./branches";
import { forgetReference } from "./reference";
import { projectView } from "./view-context";
import { canPrioritize, setPriority } from "./backlog";
import { backlogPage } from "./backlog-views";
import { inDevReady, loadInDev } from "./in-dev";
import { inDevContent, inDevLoading, inDevPage } from "./in-dev-views";
import { toTestContent, toTestLoading, toTestPage, type ToTestData } from "./to-test-views";
import { cycleRules, isStage, stagesOf, storiesOnInt } from "./lifecycle";
import { setupChecklist } from "./setup";
import { setupPage } from "./setup-views";

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
  const notice = new URL(request.url).searchParams.get("notice") ?? undefined;
  const { view, cookies } = await projectView(request, env, project);
  if (!view.ref) return html(projectPage(viewer, view, { notice, failure }), { cookies });

  const outcome = await checkOtherBranch(env, project, view.ref);
  if (outcome.ok) return html(projectPage(viewer, view, { notice, branchCheck: outcome.check }), { cookies });
  // A branch that is gone: back to production, and forget it.
  const back = { ...view, ref: null, knownBranches: view.knownBranches.filter((branch) => branch !== view.ref) };
  return html(projectPage(viewer, back, { failure: outcome.message }), {
    status: 404,
    cookies: [forgetReference(request, project)],
  });
}

// The branch list of the header menu, read when it opens.
export async function showBranches(env: Env, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return json({ branches: [] }, { status: 404, headers: { "cache-control": "no-store" } });
  const { branches, failure } = await loadBranches(env, project);
  return json({ branches, ...(failure ? { failure } : {}) }, { headers: { "cache-control": "no-store" } });
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
    stage: isStage(url.searchParams.get("stage")) ? url.searchParams.get("stage") : null,
  };
}

export async function showStories(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const filters = parseFilters(new URL(request.url));
  const [{ stories, fetchedAt, failure }, { view, cookies }, onInt] = await Promise.all([
    loadStories(env, project),
    projectView(request, env, project),
    storiesOnInt(env, project),
  ]);
  const rules = cycleRules(project.check?.config);
  const stages = stagesOf(stories, rules, onInt);
  return html(
    storiesPage(viewer, view, {
      stories,
      stages,
      rules,
      groups: groupStories(stories, filters, viewer.login, stages),
      filters,
      fetchedAt,
      failure,
    }),
    { cookies },
  );
}

export async function showProduction(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  return html(productionPage(viewer, view, await loadProduction(env, project, view.ref)), { cookies });
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
  const [{ requests, failure }, { view, cookies }] = await Promise.all([
    myRequests(env, project, viewer.login),
    projectView(request, env, project),
  ]);
  return html(
    requestsPage(viewer, view, {
      requests,
      canCreate: canRequest(viewer.role),
      created: Number.isInteger(created) && created > 0 ? created : undefined,
      failure,
    }),
    { cookies },
  );
}

export async function showRequestForm(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!canRequest(viewer.role)) return forbidden(viewer);
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  return html(requestFormPage(viewer, view, { rubriques: rubriquesOf(project) }), { cookies });
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
  const { view, cookies } = await projectView(request, env, project);
  return html(activityPage(viewer, view, await loadActivity(env, project, range, view.ref)), { cookies });
}

export async function showDelivery(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  const params = new URL(request.url).searchParams;
  if (params.get("part") === "content") {
    return html(deliveryContent(await loadDelivery(env, project, view.ref)), { cookies });
  }
  // First view in a while: the page now, the figures as soon as GitHub answers.
  if (params.get("wait") !== "1" && !(await deliveryReady(env, project))) {
    return html(deliveryPage(viewer, view, deliveryLoading(view.path)), { cookies });
  }
  return html(deliveryPage(viewer, view, deliveryContent(await loadDelivery(env, project, view.ref))), { cookies });
}

// The release notes of the reference branch, read at its latest commit.
async function branchReleases(env: Env, view: ProjectView): Promise<{ releases: Release[]; failure?: string }> {
  if (!view.ref) return loadReleases(env, view);
  const outcome = await checkOtherBranch(env, view, view.ref);
  if (!outcome.ok) return { releases: [], failure: outcome.message };
  return loadReleases(env, view, outcome.check, view.ref);
}

function monthParam(request: Request): string {
  const month = new URL(request.url).searchParams.get("month") ?? "";
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : new Date().toISOString().slice(0, 7);
}

export async function showRoadmap(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  const [releases, stories] = await Promise.all([branchReleases(env, view), loadStories(env, project)]);
  return html(
    roadmapPage(viewer, view, {
      month: monthParam(request),
      releases: releases.releases,
      stories: stories.stories,
      epics: epicProgress(stories.stories, new Date().toISOString().slice(0, 10)),
      failure: releases.failure ?? stories.failure,
    }),
    { cookies },
  );
}

export async function showReleases(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  const [releases, stories] = await Promise.all([branchReleases(env, view), loadStories(env, project)]);
  return html(
    releasesPage(viewer, view, {
      month: monthParam(request),
      releases: releases.releases,
      stories: stories.stories,
      failure: releases.failure ?? stories.failure,
    }),
    { cookies },
  );
}

// What the project needs for La Fabrique, read on the reference branch.
export async function showSetup(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  let check = project.check;
  let failure: string | undefined;
  if (view.ref) {
    const outcome = await checkOtherBranch(env, project, view.ref);
    if (outcome.ok) check = outcome.check;
    else failure = outcome.message;
  }
  const [releases, stories] = await Promise.all([
    loadReleases(env, project, check, view.ref),
    loadStories(env, project),
  ]);
  const items = setupChecklist({
    check,
    releases: releases.failure ? null : releases.releases,
    stories: stories.failure && !stories.stories.length ? null : stories.stories,
    branches: view.knownBranches,
  });
  return html(setupPage(viewer, view, { items, failure: failure ?? releases.failure ?? stories.failure }), { cookies });
}

// What the PO validates on int (or what the latest version brought).
export async function showToTest(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  const params = new URL(request.url).searchParams;
  const part = params.get("part") === "content";
  if (!part && params.get("wait") !== "1" && !(await productionReady(env, project, view.ref))) {
    return html(toTestPage(viewer, view, toTestLoading(view.path)), { cookies });
  }
  const content = toTestContent(view, await toTestData(env, view));
  return html(part ? content : toTestPage(viewer, view, content), { cookies });
}

async function toTestData(env: Env, view: ProjectView): Promise<ToTestData> {
  const config = view.check?.config;
  const [production, stories] = await Promise.all([loadProduction(env, view, view.ref), loadStories(env, view)]);
  const environment = Object.entries(config?.environnements ?? {}).find(
    ([name]) => name !== "production" && name !== productionBranch(view),
  );
  let latest: ToTestData["latest"] = null;
  if (!production.status) {
    const releases = (await branchReleases(env, view)).releases.filter((release) => !release.upcoming);
    const [release, previous] = releases;
    if (release) latest = { release, stories: storiesBetween(stories.stories, previous, release) };
  }
  return {
    status: production.status,
    stories: stories.stories,
    environment: environment ? { name: environment[0], url: environment[1].url } : null,
    latest,
    failure: production.failure ?? stories.failure,
  };
}

// Who works on what: the stories in development, their branches and PRs.
export async function showInDev(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project);
  const params = new URL(request.url).searchParams;
  const part = params.get("part") === "content";
  if (!part && params.get("wait") !== "1" && !(await inDevReady(env, project))) {
    return html(inDevPage(viewer, view, inDevLoading(view.path)), { cookies });
  }
  const [work, stories, onInt] = await Promise.all([loadInDev(env, project), loadStories(env, project), storiesOnInt(env, project)]);
  const stages = stagesOf(stories.stories, cycleRules(project.check?.config), onInt);
  const content = inDevContent(work, stories.stories, stages);
  return html(part ? content : inDevPage(viewer, view, content), { cookies });
}

const BACKLOG_NOTICES: Record<string, string> = { set: "Priority set on GitHub." };

export async function showBacklog(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  failed?: { message: string; status: number },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const [{ view, cookies }, stories, onInt] = await Promise.all([
    projectView(request, env, project),
    loadStories(env, project),
    storiesOnInt(env, project),
  ]);
  const rules = cycleRules(project.check?.config);
  const notice = new URL(request.url).searchParams.get("notice");
  return html(
    backlogPage(viewer, view, {
      stories: stories.stories,
      stages: stagesOf(stories.stories, rules, onInt),
      rules,
      canPrioritize: canPrioritize(viewer.role),
      fetchedAt: stories.fetchedAt,
      notice: notice ? BACKLOG_NOTICES[notice] : undefined,
      failure: failed?.message ?? stories.failure,
    }),
    { status: failed?.status ?? 200, cookies },
  );
}

export async function prioritize(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!canPrioritize(viewer.role)) {
    return html(messagePage("Not allowed", "Your role does not let you set priorities.", viewer), { status: 403 });
  }
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const issue = Number(form.get("issue"));
  const priority = String(form.get("priority") ?? "");
  if (!Number.isInteger(issue) || issue <= 0) return redirect(`/projects/${project.repo}/backlog`);
  const outcome = await setPriority(env, project, viewer.login, issue, priority || null);
  if (outcome.ok) return redirect(`/projects/${project.repo}/backlog?notice=set#issue-${issue}`);
  return showBacklog(request, env, viewer, repo, outcome);
}
