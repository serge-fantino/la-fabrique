import { loadAgents } from "./agents";
import { agentsPage } from "./agents-views";
import type { Env } from "./env";
import { html } from "./http";
import type { Viewer } from "./views";

// The Agents page (ADR 0004 § 2, epic F15, la-fabrique#422): a tech lead and
// above.
export async function showAgents(request: Request, env: Env, viewer: Viewer): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const data = await loadAgents(env);
  return html(agentsPage(viewer, data, { project: params.get("project") || null, capability: params.get("capability") || null }));
}
