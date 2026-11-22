import { runnerUsageOn } from "./runner-runs";
import { decisionCounts } from "./agent-requests";
import { availability, CAPABILITIES, usageOn } from "./capabilities";
import { capabilitiesPage } from "./capabilities-views";
import type { Env } from "./env";
import { html } from "./http";
import { findProject } from "./projects";
import { projectView } from "./view-context";
import { messagePage, type Viewer } from "./views";

// The Capabilities tab of a project (ADR 0006, epic F15).
export async function showCapabilities(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return html(messagePage("Not found", "There is no such project in La Fabrique extraordinaire.", viewer), { status: 404 });
  const { view, cookies } = await projectView(request, env, project, viewer);
  const [usage, decided, runs] = await Promise.all([usageOn(env.DB, project.repo), decisionCounts(env.DB, project.repo), runnerUsageOn(env.DB, project.repo)]);
  const rows = CAPABILITIES.map((capability) => {
    const used = usage.get(capability.id);
    const decisions = decided.get(capability.id);
    const ran = runs.get(capability.id);
    return { capability, available: availability(capability, project, env), ...(used ? { usage: used } : {}), ...(decisions ? { decisions } : {}), ...(ran ? { runs: ran } : {}) };
  });
  return html(capabilitiesPage(viewer, view, rows), { cookies });
}
