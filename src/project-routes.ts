import type { Env } from "./env";
import { listInstalledRepos } from "./github-app";
import { html, redirect } from "./http";
import { newProjectPage, projectPage, projectsPage } from "./project-views";
import { addProject, checkProject, describeFailure, findProject, isRepoName, listProjects } from "./projects";
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
  const notice = new URL(request.url).searchParams.get("notice") ?? undefined;
  return html(projectPage(viewer, project, { notice, failure }));
}

export async function recheckProject(env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const outcome = await checkProject(env, project, true);
  if (outcome.ok) return redirect(`/projects/${project.repo}?notice=checked`);
  return html(projectPage(viewer, project, { failure: outcome.message }));
}
