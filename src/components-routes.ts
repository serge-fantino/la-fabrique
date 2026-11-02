import { loadComponents, NATURES, type Nature } from "./components";
import { componentPage, componentsPage, type ComponentFiles } from "./components-views";
import { readMarkdown } from "./docs";
import type { Env } from "./env";
import { html } from "./http";
import { checkOtherBranch, checkProject, describeFailure, findProject, type ConfigCheck } from "./projects";
import { projectView } from "./view-context";
import { messagePage, type Viewer } from "./views";

// The Components tab of a project and a component's page (la-fabrique#197).

function notFound(viewer: Viewer, what: string): Response {
  return html(messagePage("Not found", what, viewer), { status: 404 });
}

// The check of the branch the person reads (the reference branch, or the
// project's own), checked first when it has never been.
async function readCheck(env: Env, project: Parameters<typeof checkProject>[1], ref: string | null): Promise<{ check: ConfigCheck | null; failure?: string }> {
  if (ref) {
    const outcome = await checkOtherBranch(env, project, ref);
    return outcome.ok ? { check: outcome.check } : { check: null, failure: outcome.message };
  }
  if (project.check) return { check: project.check };
  const outcome = await checkProject(env, project);
  return outcome.ok ? { check: outcome.check } : { check: null, failure: outcome.message };
}

export async function showComponents(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer, "There is no such project in La Fabrique extraordinaire.");
  const { view, cookies } = await projectView(request, env, project, viewer);
  const params = new URL(request.url).searchParams;
  const nature = params.get("nature");
  const filters = { nature: (NATURES as readonly string[]).includes(nature ?? "") ? (nature as Nature) : null, stack: params.get("stack") || null };
  const { check, failure } = await readCheck(env, project, view.ref);
  try {
    const data = await loadComponents(env, project, check, view.ref);
    return html(componentsPage(viewer, view, { ...data, filters, failure }), { cookies });
  } catch (error) {
    return html(componentsPage(viewer, view, { folder: check?.config?.composants?.dossier ?? null, components: [], sha: null, filters, failure: describeFailure(error) }), { cookies });
  }
}

export async function showComponent(request: Request, env: Env, viewer: Viewer, repo: string, id: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer, "There is no such project in La Fabrique extraordinaire.");
  const { view, cookies } = await projectView(request, env, project, viewer);
  const { check, failure } = await readCheck(env, project, view.ref);
  if (!check) return html(messagePage("Components unavailable", failure ?? "The project could not be read.", viewer), { status: 502, cookies });
  let data;
  try {
    data = await loadComponents(env, project, check, view.ref);
  } catch (error) {
    return html(messagePage("Components unavailable", describeFailure(error), viewer), { status: 502, cookies });
  }
  const entry = data.components.find((candidate) => candidate.id === id);
  if (!entry || !data.sha) return notFound(viewer, "This project has no such component.");
  const sha = data.sha;
  const read = (path: string | null) => (path ? readMarkdown(env, project, view.ref, sha, path).catch(() => null) : Promise.resolve(null));
  const [readme, spec, changelog, privacy, scenarios] = await Promise.all([
    read(entry.files.readme),
    read(entry.files.spec),
    read(entry.files.changelog),
    read(entry.meta?.donnees_personnelles ?? entry.files.privacy),
    Promise.all(entry.files.scenarios.slice(0, 20).map(async (path) => ({ path, text: (await read(path)) ?? "" }))),
  ]);
  const files: ComponentFiles = { readme, spec, changelog, privacy, scenarios };
  return html(componentPage(viewer, view, entry, sha, files), { cookies });
}
