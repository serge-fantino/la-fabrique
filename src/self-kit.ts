import type { Env } from "./env";
import { json } from "./http";
import { abilities, api, DEFECTS_SCOPE, projectId, TEST_SCOPE, type GrantProps } from "./oauth";
import { findProject, type Project } from "./projects";
import { onlineVersion } from "./build";
import type { Viewer } from "./views";
import { selfRepo } from "./whats-new";

// La Fabrique tests itself (la-fabrique#211): its own pages load the report
// and test kit, whose relay is here, inside La Fabrique. The person's
// session stands for the token a project's relay keeps, so there is no
// OAuth and no connected app; the calls go to the same project API as a
// project's app, with the environment La Fabrique is (its own entry in its
// `.fabrique.json`), its version and its deployment.
export const SELF_RELAY_PATH = "/self/relay";

const PATH = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

// La Fabrique as one of its projects, and the name of its environment.
async function selfProject(env: Env, origin: string): Promise<{ project: Project; environment: string } | null> {
  const repo = await selfRepo(env.DB, origin);
  const project = repo ? await findProject(env.DB, repo) : null;
  if (!project) return null;
  const environment = Object.entries(project.check?.config?.environnements ?? {}).find(([, candidate]) => {
    try {
      return new URL(candidate.url).origin === origin;
    } catch {
      return false;
    }
  });
  return environment ? { project, environment: environment[0] } : null;
}

function refuse(status: number, error: string, message: string): Response {
  return json({ error, message }, { status, headers: { "cache-control": "no-store" } });
}

export async function selfRelay(request: Request, env: Env, viewer: Viewer | undefined): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "POST") return refuse(405, "method_not_allowed", "GET or POST only.");
  // Only La Fabrique's own pages: a request from another site is refused
  // (a cross-site form or script cannot pass as the page).
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (origin !== url.origin || (site !== null && site !== "same-origin")) return refuse(403, "cross_site", "Only La Fabrique's own pages use this relay.");
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) return refuse(415, "invalid", "The body is JSON.");
  }
  const self = await selfProject(env, url.origin);
  const path = url.searchParams.get("path") ?? (request.method === "POST" ? "defects" : null);
  if (!viewer || !self) {
    return path === null ? json({ relay: 2, linked: false, can: { report_defect: false, test_stories: false } }, { headers: { "cache-control": "no-store" } }) : refuse(403, "no_access", "Sign in to La Fabrique first.");
  }
  const scopes = [DEFECTS_SCOPE, TEST_SCOPE];
  if (path === null) {
    return json(
      { relay: 2, linked: true, login: viewer.login, can: await abilities(env, self.project, viewer.role, scopes) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (path.length > 200 || !PATH.test(path)) return refuse(400, "invalid", "This path is not one of the project API's.");

  const props: GrantProps = { login: viewer.login, name: null, avatarUrl: null, repo: self.project.repo, app: "La Fabrique extraordinaire", scopes };
  const target = new URL(`/api/projects/${encodeURIComponent(projectId(self.project.repo))}/${path}`, url.origin);
  for (const [key, value] of url.searchParams) if (key !== "path") target.searchParams.set(key, value);
  const headers = new Headers({
    "x-fabrique-environment": encodeURIComponent(self.environment),
    "x-fabrique-version": encodeURIComponent(onlineVersion() ?? ""),
    "x-fabrique-deployment": encodeURIComponent(env.COMMIT_SHA ?? ""),
  });
  const type = request.headers.get("content-type");
  if (type) headers.set("content-type", type);
  const body = request.method === "POST" ? await request.text() : null;
  return api(new Request(target, { method: request.method, headers, body }), env, props, { self: true });
}
