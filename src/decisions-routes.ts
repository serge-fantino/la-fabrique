import { decisionNumber, loadDecisions, STATUSES, type DecisionStatus, type DecisionsView } from "./decisions";
import { decisionPage, decisionsPage } from "./decisions-views";
import { readMarkdown } from "./docs";
import type { Env } from "./env";
import { html } from "./http";
import { checkOtherBranch, checkProject, describeFailure, findProject, type ConfigCheck } from "./projects";
import { projectView } from "./view-context";
import { messagePage, type Viewer } from "./views";

// The Decisions tab of a project and a decision's page (epic F15).

function notFound(viewer: Viewer, what: string): Response {
  return html(messagePage("Not found", what, viewer), { status: 404 });
}

async function readCheck(env: Env, project: Parameters<typeof checkProject>[1], ref: string | null): Promise<{ check: ConfigCheck | null; failure?: string }> {
  if (ref) {
    const outcome = await checkOtherBranch(env, project, ref);
    return outcome.ok ? { check: outcome.check } : { check: null, failure: outcome.message };
  }
  if (project.check) return { check: project.check };
  const outcome = await checkProject(env, project);
  return outcome.ok ? { check: outcome.check } : { check: null, failure: outcome.message };
}

export async function showDecisions(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer, "There is no such project in La Fabrique extraordinaire.");
  const { view, cookies } = await projectView(request, env, project, viewer);
  const wanted = new URL(request.url).searchParams.get("status") ?? "";
  const status = ([...STATUSES, "unknown"] as string[]).includes(wanted) ? (wanted as DecisionStatus) : null;
  const { check, failure } = await readCheck(env, project, view.ref);
  try {
    const data = await loadDecisions(env, project, check, view.ref);
    return html(decisionsPage(viewer, view, { ...data, status, failure }), { cookies });
  } catch (error) {
    const data: DecisionsView = { folder: check?.config?.decisions?.dossier ?? null, declared: Boolean(check?.config?.decisions), decisions: [], openDecisions: null, index: null, sha: null };
    return html(decisionsPage(viewer, view, { ...data, status, failure: describeFailure(error) }), { cookies });
  }
}

export async function showDecision(request: Request, env: Env, viewer: Viewer, repo: string, which: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer, "There is no such project in La Fabrique extraordinaire.");
  const { view, cookies } = await projectView(request, env, project, viewer);
  const { check, failure } = await readCheck(env, project, view.ref);
  if (!check) return html(messagePage("Decisions unavailable", failure ?? "The project could not be read.", viewer), { status: 502, cookies });
  let data: DecisionsView;
  try {
    data = await loadDecisions(env, project, check, view.ref);
  } catch (error) {
    return html(messagePage("Decisions unavailable", describeFailure(error), viewer), { status: 502, cookies });
  }
  const decision = which === "open" ? null : (data.decisions.find((entry) => entry.number === decisionNumber(which)) ?? null);
  const path = which === "open" ? data.openDecisions : decision?.path;
  if (!path || !data.sha) return notFound(viewer, "This project has no such decision.");
  let markdown: string;
  try {
    markdown = await readMarkdown(env, project, view.ref, data.sha, path);
  } catch (error) {
    return html(messagePage("Decision unavailable", describeFailure(error), viewer), { status: 502, cookies });
  }
  return html(decisionPage(viewer, view, data, decision, path, markdown), { cookies });
}
