import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { effectiveRole, ROLE_LABELS, type Role } from "./accounts";
import { activityStatement } from "./activity-log";
import { safeEqual } from "./crypto";
import { DEFECT_ROUTE, defectTargetsForApp, reportDefectFromApp, reportingEnvironments, TARGETS_ROUTE } from "./defects";
import type { Env } from "./env";
import { fetchUser, refreshUserToken } from "./github";
import { githubFetch } from "./github-app";
import { cspWithFormTarget } from "./headers";
import { html, json, redirect } from "./http";
import { findProject, type Project } from "./projects";
import { can } from "./rights";
import { readSession, userToken, type Session } from "./session";
import { escapeHtml, layout } from "./views";

// The single scope a project's app asks for (contract with the épicerie,
// la-fabrique#65).
export const DEFECTS_SCOPE = "defects:report";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REVOKE_PATH = "/oauth/revoke";
export const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";
export const ACCESS_TOKEN_TTL = 60 * 60;
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;

// What a grant carries, encrypted by the library; read back by the API.
export interface GrantProps {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  repo: string;
  // The app's name when it was connected, for the reports' signature.
  app?: string;
}

export function oauthHelpers(env: Env): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error("The OAuth provider is not set up on this request.");
  return env.OAUTH_PROVIDER;
}

// A project's id in the API: the repository's name, without its owner.
export function projectId(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

export function projectName(project: Project): string {
  return project.check?.config?.nom ?? project.repo;
}

export async function appRepo(db: D1Database, clientId: string): Promise<string | null> {
  const row = await db.prepare("SELECT repo FROM oauth_apps WHERE client_id = ?").bind(clientId).first<{ repo: string }>();
  return row?.repo ?? null;
}

// A role in La Fabrique gives access to every project; without one, the
// person's GitHub account must see the repository.
async function canSeeProject(request: Request, env: Env, role: Role | null, repo: string): Promise<boolean> {
  if (role) return true;
  const token = await personToken(request, env);
  if (!token) return false;
  const response = await githubFetch(token, `/repos/${repo}`);
  return response.ok;
}

function personToken(request: Request, env: Env): Promise<string | null> {
  return userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
}

function errorPage(title: string, message: string, status: number): Response {
  return html(
    layout(
      `${title} · La Fabrique extraordinaire`,
      `<h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>`,
    ),
    { status },
  );
}

function consentPage(
  session: Session,
  role: Role | null,
  appName: string,
  project: Project,
  action: string,
  redirectOrigin: string,
): Response {
  const projectLabel = projectName(project);
  return html(
    layout(
      `Connect ${appName} · La Fabrique extraordinaire`,
      `<section class="consent">
        <p class="eyebrow">Connect an app</p>
        <h1>${escapeHtml(appName)}</h1>
        <p class="lead"><strong>${escapeHtml(appName)}</strong> will be able to report defects in your name on <strong>${escapeHtml(projectLabel)}</strong>.</p>
        <ul class="consent-list">
          <li>Each report becomes an issue of <a href="https://github.com/${escapeHtml(project.repo)}">${escapeHtml(project.repo)}</a>, signed with your GitHub login.</li>
          <li>It never gets a GitHub token, and cannot read or change anything else.</li>
          <li>You can disconnect it at any time from <a href="/apps">Connected apps</a>.</li>
        </ul>
        <p class="muted">Signed in as <span class="mono">@${escapeHtml(session.login)}</span> · ${
          role ? escapeHtml(ROLE_LABELS[role]) : "no role in La Fabrique: your reports will be triaged"
        }.</p>
        <form method="post" action="${escapeHtml(action)}" class="actions">
          <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
          <button type="submit" name="decision" value="allow" class="button">Allow</button>
          <button type="submit" name="decision" value="deny" class="button quiet">Deny</button>
        </form>
      </section>`,
    ),
    { headers: { "content-security-policy": cspWithFormTarget(redirectOrigin) } },
  );
}

function errorRedirect(authRequest: AuthRequest, error: string, description: string): Response {
  const target = new URL(authRequest.redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (authRequest.state) target.searchParams.set("state", authRequest.state);
  return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store" } });
}

// GET shows the consent page, after a GitHub sign-in if needed; POST,
// from that page, sends the person back to the app with a code.
export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const helpers = oauthHelpers(env);
  let authRequest: AuthRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return new Response(null, { status: 302, headers: { location: error.redirectTo } });
      return errorPage("This link is not valid", `The app sent an invalid request: ${error.description}.`, 400);
    }
    throw error;
  }
  const client = await helpers.lookupClient(authRequest.clientId);
  const repo = await appRepo(env.DB, authRequest.clientId);
  const project = repo ? await findProject(env.DB, repo) : null;
  if (!client || !project) {
    return errorPage("This app is not connected to a project", "Ask the owner of La Fabrique to register it again.", 400);
  }
  const requested = authRequest.scope.length ? authRequest.scope : [DEFECTS_SCOPE];
  if (requested.some((scope) => scope !== DEFECTS_SCOPE)) {
    return errorRedirect(authRequest, "invalid_scope", `Only ${DEFECTS_SCOPE} can be granted.`);
  }

  const session = await readSession(request, env.DB);
  if (!session) {
    if (request.method !== "GET") return errorPage("Signed out", "Your session ended: open the app again to connect it.", 403);
    return redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const role = await effectiveRole(env, session.login);
  if (!(await canSeeProject(request, env, role, project.repo))) {
    return errorPage(
      "No access to this project",
      `Your GitHub account @${session.login} cannot see ${project.repo}, so it cannot report defects on it.`,
      403,
    );
  }
  const appName = client.clientName ?? "This app";

  if (request.method === "GET") {
    return consentPage(session, role, appName, project, url.pathname + url.search, new URL(authRequest.redirectUri).origin);
  }

  const origin = request.headers.get("origin");
  let form: FormData | null = null;
  if (!origin || origin === url.origin) {
    try {
      form = await request.formData();
    } catch {
      form = null;
    }
  }
  const csrf = form?.get("csrf");
  if (!form || typeof csrf !== "string" || !safeEqual(csrf, session.csrfToken)) {
    return errorPage("Not allowed", "This form expired: open the app again to connect it.", 403);
  }
  if (form.get("decision") !== "allow") return errorRedirect(authRequest, "access_denied", "The person declined.");

  const token = await personToken(request, env);
  const user = token ? await fetchUser(token) : null;
  const props: GrantProps = {
    login: session.login,
    name: user?.name ?? null,
    avatarUrl: user?.avatarUrl ?? null,
    repo: project.repo,
    app: appName,
  };
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId: session.login,
    metadata: { repo: project.repo },
    scope: requested,
    props,
    revokeExistingGrants: true,
  });
  await activityStatement(env.DB, {
    actor: session.login,
    action: "app_connected",
    repo: project.repo,
    details: { client_id: authRequest.clientId, app: appName },
  }).run();
  return new Response(null, { status: 302, headers: { location: redirectTo, "cache-control": "no-store" } });
}

// The token endpoint answers revocations (a body with `token` and no
// `grant_type`); the contract gives them their own address.
export async function revoke(request: Request, provider: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> }, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.text();
  const params = new URLSearchParams(body);
  if (params.has("grant_type") || !params.get("token")) {
    return json({ error: "invalid_request", error_description: "Send the token to revoke, and no grant_type." }, { status: 400 });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return provider.fetch(new Request(new URL(TOKEN_PATH, request.url), { method: "POST", headers, body }), env, ctx);
}

// The discovery document names the revocation address of the contract.
export async function discovery(response: Response, request: Request): Promise<Response> {
  if (!response.ok) return response;
  const metadata = (await response.json()) as Record<string, unknown>;
  metadata["revocation_endpoint"] = new URL(REVOKE_PATH, request.url).href;
  return json(metadata, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}

// The API a connected app calls with its access token.
export async function api(request: Request, env: Env, props: GrantProps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/me") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
    const project = await findProject(env.DB, props.repo);
    const role = await effectiveRole(env, props.login);
    return json(
      {
        login: props.login,
        name: props.name,
        avatar_url: props.avatarUrl,
        project: { id: projectId(props.repo), role },
        can: {
          report_defect: project !== null && can(role, "report_defect") && Object.keys(await reportingEnvironments(env, project)).length > 0,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const defects = DEFECT_ROUTE.exec(pathname);
  if (defects) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
    return reportDefectFromApp(request, env, props, defects[1] ?? "");
  }
  const targets = TARGETS_ROUTE.exec(pathname);
  if (targets) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
    return defectTargetsForApp(env, props, targets[1] ?? "");
  }
  return json({ error: "not_found" }, { status: 404 });
}
