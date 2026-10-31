import { can } from "./rights";
import { storyCards } from "./card-groups";
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
import { loadProduction, PRODUCTION, productionReady, type ProductionStatus } from "./production";
import { readSnapshot } from "./snapshots";
import { defectPage, defectHistory, readDefectLive } from "./defect-page";
import { defectRows, defectsPage, filterDefects, readDefectFilters } from "./defects-tab";
import { defectTargets } from "./defect-targets";
import { triageDefect } from "./defect-triage";
import { appLink, appSection, changeProjectApp, type AppActionFailure } from "./project-app";
import { projectKit, proposeKitUpdate, relayChanges } from "./kit-update";
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
import { canLaunchClaude, claudeCap, claudeLaunches, claudeWorkflow, launchClaude } from "./claude";
import { giveGo, goSummary, lastGo } from "./go";
import { LOG_GROUPS, readLog } from "./log";
import { logPage } from "./log-views";
import { defectUrl, projectUrl } from "./urls";
import { canValidate, readDefect, reportDefect, storyChecks, tickCriterion, validateStory } from "./validation";
import { proposeCycle, readCycleForm } from "./config-change";
import { projectCard } from "./dashboard";
import { cardHtml, dashboardPage } from "./dashboard-views";
import { canPrioritize, setPriority } from "./backlog";
import { backlogPage } from "./backlog-views";
import { inDevReady, loadInDev } from "./in-dev";
import { inDevContent, inDevLoading, inDevPage } from "./in-dev-views";
import { toTestContent, toTestLoading, toTestPage, type ToTestData } from "./to-test-views";
import { cycleRules, isStage, stageOf, stagesOf, storiesOnInt } from "./lifecycle";
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

function notFound(viewer: Viewer, what = "There is no such project in La Fabrique extraordinaire."): Response {
  return html(messagePage("Not found", what, viewer), { status: 404 });
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
  const { view, cookies } = await projectView(request, env, project, viewer);
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
    group: url.searchParams.get("group") === "card" ? "card" : "epic",
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
  const [{ stories, fetchedAt, failure }, { view, cookies }, onInt, cards] = await Promise.all([
    loadStories(env, project),
    projectView(request, env, project, viewer),
    storiesOnInt(env, project),
    storyCards(env.DB, project.repo),
  ]);
  const rules = cycleRules(project.check?.config);
  const stages = stagesOf(stories, rules, onInt);
  return html(
    storiesPage(viewer, view, {
      stories,
      stages,
      rules,
      groups: groupStories(stories, filters, viewer.login, stages, cards),
      filters,
      cards,
      fetchedAt,
      failure,
    }),
    { cookies },
  );
}

const GO_NOTICES: Record<string, string> = {
  given: "Go given: the promotion workflow is starting on GitHub. Its run shows here in a moment.",
};

export async function showProduction(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  failed?: { message: string; status: number },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project, viewer);
  const [production, checks, last] = await Promise.all([
    loadProduction(env, project, view.ref),
    storyChecks(env.DB, project.repo),
    lastGo(env.DB, project.repo),
  ]);
  const notice = new URL(request.url).searchParams.get("notice");
  // The go is about what integration brings, not another reference branch.
  const go = view.ref
    ? undefined
    : {
        canGo: viewer.role === "super_admin",
        declared: typeof project.check?.config?.workflows?.["promouvoir"] === "string",
        last,
        checks,
        summary: production.status ? goSummary(production.status, production.stories, checks) : null,
        notice: notice ? GO_NOTICES[notice] : undefined,
        failure: failed?.message,
      };
  return html(productionPage(viewer, view, production, go), { cookies, status: failed?.status ?? 200 });
}

// The go: only the super admin; the project's workflow does the promotion.
export async function goToProduction(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (viewer.role !== "super_admin") {
    return html(messagePage("Not allowed", "Only a super admin gives the go to production.", viewer), { status: 403 });
  }
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const [production, checks] = await Promise.all([loadProduction(env, project), storyChecks(env.DB, project.repo)]);
  const summary = production.status ? goSummary(production.status, production.stories, checks) : null;
  const reason = String(form.get("reason") ?? "").trim().slice(0, 500);
  const outcome = await giveGo(env, project, viewer.login, production.status, summary, reason);
  if (outcome.ok) return redirect(`/projects/${project.repo}/production?notice=given`);
  return showProduction(request, env, viewer, repo, outcome);
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
    projectView(request, env, project, viewer),
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
  const { view, cookies } = await projectView(request, env, project, viewer);
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
  const { view, cookies } = await projectView(request, env, project, viewer);
  return html(activityPage(viewer, view, await loadActivity(env, project, range, view.ref)), { cookies });
}

export async function showDelivery(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project, viewer);
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
  const { view, cookies } = await projectView(request, env, project, viewer);
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
  const { view, cookies } = await projectView(request, env, project, viewer);
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
const SETUP_NOTICES: Record<string, string> = {
  unchanged: "Nothing to change: the file already says this.",
  app_returns: "The app's return addresses now follow .fabrique.json.",
  app_removed: "App removed: every connection to it was revoked.",
  kit_current: "The project's kit is already up to date.",
};

const APP_FAILURES: Record<AppActionFailure, string> = {
  invalid: "Give a name and at least one return address (https, or http on localhost).",
  exists: "This project already has an app: renew its secret or remove it.",
  none: "This project has no app registered.",
  no_returns: "Add application.retour to .fabrique.json first: the return addresses come from it.",
};

// Register the project's app, renew its secret, follow .fabrique.json,
// remove it: the super admin only.
export async function projectAppAction(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!can(viewer.role, "go")) return forbidden(viewer);
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const outcome = await changeProjectApp(form, env, viewer, project, new URL(request.url).origin);
  if (outcome instanceof Response) return outcome;
  return showSetup(request, env, viewer, repo, { failure: APP_FAILURES[outcome], status: 422 });
}

export async function showSetup(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  outcome?: { failure?: string; status?: number; proposed?: { number: number; url: string; base: string } },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project, viewer);
  let check = project.check;
  let failure: string | undefined;
  if (view.ref) {
    const branch = await checkOtherBranch(env, project, view.ref);
    if (branch.ok) check = branch.check;
    else failure = branch.message;
  }
  const [releases, stories] = await Promise.all([
    loadReleases(env, project, check, view.ref),
    loadStories(env, project),
  ]);
  const production = await readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION);
  const [link, kit] = await Promise.all([appLink(env, project, new URL(request.url).origin), projectKit(env, project)]);
  const items = setupChecklist({
    check,
    app: { reporting: Object.keys(link.reporting), registered: link.app !== null, missing: link.missing.length, connections: link.connections },
    versions: production?.data.versions ?? null,
    releases: releases.failure ? null : releases.releases,
    stories: stories.failure && !stories.stories.length ? null : stories.stories,
    branches: view.knownBranches,
  });
  const params = new URL(request.url).searchParams;
  const pull = Number(params.get("pull"));
  const proposed =
    outcome?.proposed ??
    (params.get("notice") === "proposed" && Number.isInteger(pull) && pull > 0
      ? { number: pull, url: `https://github.com/${project.repo}/pull/${pull}`, base: params.get("base") ?? "" }
      : undefined);
  const rules = cycleRules(check?.config);
  const noticeKey = params.get("notice");
  return html(
    setupPage(viewer, view, {
      items,
      app: appSection(viewer, view, link, {
        kit,
        relay: relayChanges(kit.version),
        proposed:
          params.get("notice") === "kit_proposed" && Number.isInteger(pull) && pull > 0
            ? { number: pull, url: `https://github.com/${project.repo}/pull/${pull}` }
            : undefined,
      }),
      notice: noticeKey ? SETUP_NOTICES[noticeKey] : undefined,
      failure: outcome?.failure ?? failure ?? releases.failure ?? stories.failure,
      lifecycle: {
        canEdit: canEditConfig(viewer.role),
        cycle: { pret: rules.checks, priorites: rules.priorities },
        declared: Boolean(check?.config?.cycle),
        base: project.check?.config?.branches?.integration ?? productionBranch(project) ?? "main",
        proposed,
      },
    }),
    { status: outcome?.status ?? 200, cookies },
  );
}

function canEditConfig(role: Viewer["role"]): boolean {
  return can(role, "launch_claude");
}

const PROPOSE_FAILURES: Record<string, string> = {
  signed_out: "GitHub no longer accepts your sign-in. Sign out and sign in again.",
  refused:
    "GitHub refused the change. The GitHub App needs Contents and Pull requests write permission on this repository (see the owner setup), and you need write access to it.",
};

// The lifecycle form: a pull request on the project, never a direct commit.
export async function proposeLifecycle(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!canEditConfig(viewer.role)) {
    return html(messagePage("Not allowed", "Your role does not let you change a project's setup.", viewer), { status: 403 });
  }
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const read = readCycleForm(form);
  if ("error" in read) return showSetup(request, env, viewer, repo, { failure: read.error, status: 422 });
  const outcome = await proposeCycle(request, env, project, viewer.login, read.cycle);
  if (outcome.ok) {
    return redirect(`/projects/${project.repo}/setup?notice=proposed&pull=${outcome.number}&base=${encodeURIComponent(outcome.base)}#lifecycle`);
  }
  if (outcome.reason === "unchanged") return redirect(`/projects/${project.repo}/setup?notice=unchanged#lifecycle`);
  const message =
    outcome.reason === "invalid"
      ? `The change would not be valid: ${outcome.message ?? ""}`
      : `${PROPOSE_FAILURES[outcome.reason] ?? "GitHub refused the change."}${outcome.status ? ` (HTTP ${outcome.status})` : ""}`;
  return showSetup(request, env, viewer, repo, { failure: message, status: outcome.reason === "invalid" ? 422 : 502 });
}

// What the PO validates on int (or what the latest version brought).
export async function showToTest(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  failed?: { message: string; status: number },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project, viewer);
  const params = new URL(request.url).searchParams;
  const part = params.get("part") === "content";
  if (!failed && !part && params.get("wait") !== "1" && !(await productionReady(env, project, view.ref))) {
    return html(toTestPage(viewer, view, toTestLoading(view.path)), { cookies });
  }
  const data = await toTestData(env, view);
  const content = toTestContent(view, {
    ...data,
    failure: failed?.message ?? data.failure,
    actions: {
      viewer,
      base: projectUrl(project.repo),
      canValidate: canValidate(viewer.role),
      checks: await storyChecks(env.DB, project.repo),
    },
  });
  return html(part ? content : toTestPage(viewer, view, content), { cookies, status: failed?.status ?? 200 });
}

// Tick a criterion, validate a story, report a defect: written on GitHub,
// and in the log.
export async function toTestAction(
  request: Request,
  form: FormData,
  env: Env,
  viewer: Viewer,
  repo: string,
  action: "criterion" | "validate" | "defect",
): Promise<Response> {
  if (!canValidate(viewer.role)) {
    return html(messagePage("Not allowed", "Your role does not let you validate on int.", viewer), { status: 403 });
  }
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const issue = Number(form.get("issue"));
  if (!Number.isInteger(issue) || issue <= 0) return redirect(`/projects/${project.repo}/to-test`);
  let outcome;
  if (action === "criterion") {
    const index = Number(form.get("index"));
    if (!Number.isInteger(index) || index < 0) return redirect(`/projects/${project.repo}/to-test`);
    outcome = await tickCriterion(request, env, project, viewer.login, issue, index, String(form.get("text") ?? ""), form.get("done") === "1");
  } else if (action === "validate") {
    outcome = await validateStory(request, env, project, viewer.login, issue);
  } else {
    const defect = readDefect(form);
    outcome = defect
      ? await reportDefect(request, env, project, viewer.login, issue, defect)
      : ({ ok: false, message: "A defect needs a title and what you saw.", status: 422 } as const);
  }
  if (outcome.ok) return redirect(`/projects/${project.repo}/to-test#story-${issue}`);
  return showToTest(request, env, viewer, repo, { message: outcome.message, status: outcome.status });
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
  const unlinked = (await defectRows(env, view, stories.stories))
    .filter((row) => row.state === "open" && row.story === null)
    .map(({ number, title, url, triage }) => ({ number, title, url, triage }));
  return {
    status: production.status,
    stories: stories.stories,
    environment: environment ? { name: environment[0], url: environment[1].url } : null,
    latest,
    unlinked,
    failure: production.failure ?? stories.failure,
  };
}

// Who works on what: the stories in development, their branches and PRs.
export async function showInDev(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const { view, cookies } = await projectView(request, env, project, viewer);
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

const BACKLOG_NOTICES: Record<string, string> = {
  set: "Priority set on GitHub.",
  claude: "Claude is starting on GitHub: its branch and pull request will show in In development.",
};

export async function showBacklog(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  failed?: { message: string; status: number },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const params = new URL(request.url).searchParams;
  const group = params.get("group") === "card" ? "card" : "priority";
  const [{ view, cookies }, stories, onInt, launches, cards] = await Promise.all([
    projectView(request, env, project, viewer),
    loadStories(env, project),
    storiesOnInt(env, project),
    claudeLaunches(env.DB, project.repo),
    group === "card" ? storyCards(env.DB, project.repo) : Promise.resolve(null),
  ]);
  const rules = cycleRules(project.check?.config);
  const notice = params.get("notice");
  return html(
    backlogPage(viewer, view, {
      stories: stories.stories,
      stages: stagesOf(stories.stories, rules, onInt),
      rules,
      canPrioritize: canPrioritize(viewer.role),
      claude: { show: canLaunchClaude(viewer.role) && claudeWorkflow(project) !== null, launches, cap: claudeCap(project) },
      fetchedAt: stories.fetchedAt,
      group,
      cards,
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
  if (outcome.ok) return redirect(`/projects/${project.repo}/backlog?${form.get("group") === "card" ? "group=card&" : ""}notice=set#issue-${issue}`);
  return showBacklog(request, env, viewer, repo, outcome);
}

export async function showDashboard(env: Env, viewer: Viewer): Promise<Response> {
  const projects = await listProjects(env.DB);
  const cards = await Promise.all(projects.map((project) => projectCard(env.DB, project, viewer.role)));
  return html(dashboardPage(viewer, cards));
}

// One project's dashboard card, after reading GitHub again.
export async function showCard(env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return html("", { status: 404 });
  await Promise.all([loadProduction(env, project), loadStories(env, project)]);
  return html(cardHtml(await projectCard(env.DB, project, viewer.role)));
}

export async function showLog(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const params = new URL(request.url).searchParams;
  const before = Number(params.get("before"));
  const group = params.get("group");
  const filters = {
    group: LOG_GROUPS.some((candidate) => candidate.id === group) ? group : null,
    actor: params.get("actor") || null,
    before: Number.isInteger(before) && before > 0 ? before : null,
  };
  const [{ view, cookies }, log] = await Promise.all([projectView(request, env, project, viewer), readLog(env.DB, project.repo, filters)]);
  return html(logPage(viewer, view, { ...log, filters }), { cookies });
}

// Launch Claude on a ready story: tech leads and super admins.
export async function launchClaudeOn(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!canLaunchClaude(viewer.role)) {
    return html(messagePage("Not allowed", "Only tech leads and super admins launch Claude.", viewer), { status: 403 });
  }
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const issue = Number(form.get("issue"));
  if (!Number.isInteger(issue) || issue <= 0) return redirect(`/projects/${project.repo}/backlog`);
  const [stories, onInt] = await Promise.all([loadStories(env, project), storiesOnInt(env, project)]);
  const story = stories.stories.find((candidate) => candidate.number === issue);
  if (!story || stageOf(story, cycleRules(project.check?.config), onInt) !== "ready") {
    return showBacklog(request, env, viewer, repo, { message: `Story #${issue} is not ready: its Definition of Ready comes first.`, status: 422 });
  }
  const outcome = await launchClaude(env, project, viewer.login, issue);
  if (outcome.ok) return redirect(`/projects/${project.repo}/backlog?notice=claude#issue-${issue}`);
  return showBacklog(request, env, viewer, repo, outcome);
}

// The project's defects: issues labelled bug, with their story and version.
export async function showDefects(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  failed?: { message: string; status: number },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const params = new URL(request.url).searchParams;
  const filters = readDefectFilters(params);
  const [{ view, cookies }, stories] = await Promise.all([projectView(request, env, project, viewer), loadStories(env, project)]);
  const all = await defectRows(env, project, stories.stories);
  return html(
    defectsPage(viewer, view, {
      rows: filterDefects(all, filters),
      all,
      stories: stories.stories,
      filters,
      failure: failed?.message ?? stories.failure,
      canTriage: can(viewer.role, "validate"),
      notice: params.get("notice"),
    }),
    { cookies, status: failed?.status ?? 200 },
  );
}

// One defect: its issue read from GitHub, its story, its triage, its history.
export async function showDefect(
  request: Request,
  env: Env,
  viewer: Viewer,
  repo: string,
  number: number,
  failed?: { message: string; status: number },
): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const [{ view, cookies }, stories] = await Promise.all([projectView(request, env, project, viewer), loadStories(env, project)]);
  const row = (await defectRows(env, project, stories.stories)).find((candidate) => candidate.number === number);
  if (!row) return notFound(viewer, `#${number} is not one of this project's defects.`);
  const canTriage = can(viewer.role, "validate");
  const [live, history, targets] = await Promise.all([
    readDefectLive(env, project, number, row.story),
    defectHistory(env.DB, project.repo, number),
    canTriage && row.state === "open" ? defectTargets(env, project) : Promise.resolve([]),
  ]);
  const url = new URL(request.url);
  return html(
    defectPage(viewer, view, {
      row,
      live,
      story: row.story === null ? undefined : stories.stories.find((story) => story.number === row.story),
      history,
      origin: url.origin,
      canTriage,
      targets,
      titles: new Map(stories.stories.map((story) => [story.number, story.title])),
      notice: url.searchParams.get("notice"),
      failure: failed?.message ?? stories.failure,
    }),
    { cookies, status: failed?.status ?? 200 },
  );
}

// Triage a defect from its page: testers and up.
export async function triage(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!can(viewer.role, "validate")) return forbidden(viewer);
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const stories = await loadStories(env, project);
  const outcome = await triageDefect(env, project, stories.stories, viewer.login, form);
  const back = String(form.get("back") ?? "");
  const number = Number(form.get("defect"));
  const onPage = back === "page" && Number.isInteger(number) && number > 0;
  if (!outcome.ok) {
    const failed = { message: outcome.message, status: outcome.status };
    return onPage && outcome.status !== 404 ? showDefect(request, env, viewer, repo, number, failed) : showDefects(request, env, viewer, repo, failed);
  }
  const notice = `notice=${outcome.changed ? "triaged" : "unchanged"}`;
  if (onPage) return redirect(`${defectUrl(project.repo, number)}?${notice}#triage`);
  const query = back.startsWith("?") ? back.slice(1) : "";
  return redirect(`${projectUrl(project.repo)}/defects?${query ? `${query}&` : ""}${notice}`);
}

const KIT_FAILURES: Record<string, string> = {
  signed_out: "GitHub no longer accepts your sign-in. Sign out and sign in again.",
  refused: "GitHub refused the change. The GitHub App needs Contents and Pull requests write permission on this repository, and you need write access to it.",
  undeclared: "Declare application.kit in .fabrique.json first: the folder where the project keeps its copy.",
  versioned: "The kit's files carry their version in their name: rename them fabrique-report.js, .css and -early.js first.",
};

// Bring the project's copy of the report kit up to date, as a pull request.
export async function proposeKit(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  if (!can(viewer.role, "launch_claude")) return forbidden(viewer);
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const outcome = await proposeKitUpdate(request, env, project, viewer.login);
  if (outcome.ok) return redirect(`${projectUrl(project.repo)}/setup?notice=kit_proposed&pull=${outcome.number}#connected-app`);
  if (outcome.reason === "current") return redirect(`${projectUrl(project.repo)}/setup?notice=kit_current#connected-app`);
  const message = KIT_FAILURES[outcome.reason] ?? "The update could not be proposed.";
  return showSetup(request, env, viewer, repo, { failure: outcome.status ? `${message} (HTTP ${outcome.status})` : message, status: 422 });
}
