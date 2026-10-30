import type { ClientInfo, GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { html, redirect } from "./http";
import { oauthHelpers, projectId, projectName } from "./oauth";
import { findProject, listProjects, type Project } from "./projects";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

export const APPS_PATH = "/apps";

// Who opens the page: a person with a role, or an account without one that
// signed in to connect an app.
export interface AppsViewer {
  login: string;
  role: Role | null;
  csrfToken: string;
}

interface RegisteredApp {
  clientId: string;
  name: string;
  repo: string;
  redirectUris: string[];
  createdBy: string;
  createdAt: string;
}

const NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  revoked: { tone: "ok", text: "App disconnected: its tokens no longer work." },
  removed: { tone: "ok", text: "App removed: every connection to it was revoked." },
  invalid: { tone: "error", text: "Give a name, a project and at least one return address (https, or http on localhost)." },
  unknown: { tone: "error", text: "This connection no longer exists." },
};

function asViewer(viewer: AppsViewer): Viewer | undefined {
  return viewer.role ? { login: viewer.login, role: viewer.role, csrfToken: viewer.csrfToken } : undefined;
}

async function registeredApps(env: Env): Promise<RegisteredApp[]> {
  const { results } = await env.DB.prepare("SELECT client_id, repo, created_by, created_at FROM oauth_apps ORDER BY created_at")
    .all<{ client_id: string; repo: string; created_by: string; created_at: string }>();
  const helpers = oauthHelpers(env);
  const apps: RegisteredApp[] = [];
  for (const row of results) {
    const client = await helpers.lookupClient(row.client_id);
    if (!client) continue;
    apps.push({
      clientId: row.client_id,
      name: client.clientName ?? row.client_id,
      repo: row.repo,
      redirectUris: client.redirectUris,
      createdBy: row.created_by,
      createdAt: row.created_at,
    });
  }
  return apps;
}

interface Connection {
  grant: GrantSummary;
  name: string;
  repo: string | null;
}

async function connections(env: Env, login: string): Promise<Connection[]> {
  const helpers = oauthHelpers(env);
  const { items } = await helpers.listUserGrants(login);
  const found: Connection[] = [];
  for (const grant of items) {
    const client = await helpers.lookupClient(grant.clientId);
    const metadata = grant.metadata as { repo?: unknown } | null;
    found.push({
      grant,
      name: client?.clientName ?? "A removed app",
      repo: typeof metadata?.repo === "string" ? metadata.repo : null,
    });
  }
  return found.sort((a, b) => b.grant.createdAt - a.grant.createdAt);
}

function connectionsSection(viewer: AppsViewer, list: Connection[]): string {
  const rows = list
    .map(
      ({ grant, name, repo }) => `<tr>
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>${repo ? `<a href="https://github.com/${escapeHtml(repo)}">${escapeHtml(repo)}</a>` : "—"}</td>
        <td><code>${escapeHtml(grant.scope.join(" "))}</code></td>
        <td class="mono">${escapeHtml(formatDate(new Date(grant.createdAt * 1000).toISOString()))}</td>
        <td><form method="post" action="${APPS_PATH}">${hiddenCsrf(viewer)}
          <input type="hidden" name="action" value="revoke" />
          <input type="hidden" name="grant" value="${escapeHtml(grant.id)}" />
          <button type="submit" class="button quiet">Disconnect</button>
        </form></td>
      </tr>`,
    )
    .join("");
  return `<section>
      <h2>Connected apps</h2>
      <p>Apps of the projects you allowed to act in your name. Disconnecting one revokes its tokens at once: its next call fails.</p>
      ${
        list.length
          ? `<table>
          <thead><tr><th>App</th><th>Project</th><th>Can</th><th>Since</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
          : `<p class="muted">No app is connected to your account.</p>`
      }
    </section>`;
}

function hiddenCsrf(viewer: AppsViewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`;
}

function registerSection(viewer: Viewer, apps: RegisteredApp[], projects: Project[]): string {
  const rows = apps
    .map(
      (app) => `<tr>
        <td><strong>${escapeHtml(app.name)}</strong><br /><code>${escapeHtml(app.clientId)}</code></td>
        <td><a href="/projects/${escapeHtml(app.repo)}">${escapeHtml(projectId(app.repo))}</a></td>
        <td>${app.redirectUris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join("<br />")}</td>
        <td><span class="mono">@${escapeHtml(app.createdBy)}</span><br /><span class="mono">${escapeHtml(formatDate(app.createdAt))}</span></td>
        <td><form method="post" action="${APPS_PATH}">${csrfField(viewer)}
          <input type="hidden" name="action" value="remove" />
          <input type="hidden" name="client" value="${escapeHtml(app.clientId)}" />
          <button type="submit" class="button quiet">Remove</button>
        </form></td>
      </tr>`,
    )
    .join("");
  const options = projects
    .map((project) => `<option value="${escapeHtml(project.repo)}">${escapeHtml(projectName(project))} (${escapeHtml(project.repo)})</option>`)
    .join("");
  return `<section>
      <h2>Registered apps</h2>
      <p>A project's own app connects to La Fabrique with OAuth (authorization code and PKCE) to report defects in the name of the person using it, on that project only. It never gets a GitHub token.</p>
      ${
        apps.length
          ? `<table>
          <thead><tr><th>App</th><th>Project</th><th>Return addresses</th><th>Registered</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
          : `<p class="muted">No app registered yet.</p>`
      }
      <h3>Register an app</h3>
      <form method="post" action="${APPS_PATH}" class="request-form">${csrfField(viewer)}
        <input type="hidden" name="action" value="register" />
        <div class="field"><label for="app-name">Name</label>
          <p class="help">Shown on the consent page: “‹name› will be able to report defects in your name on ‹project›”.</p>
          <input id="app-name" type="text" name="name" required maxlength="80" /></div>
        <div class="field"><label for="app-repo">Project</label><select id="app-repo" name="repo" required>${options}</select></div>
        <div class="field"><label for="app-return">Return addresses</label>
          <p class="help">One per line: https, or http on localhost for local development.</p>
          <textarea id="app-return" name="redirect_uris" rows="3" required></textarea></div>
        <p><button type="submit" class="button">Register</button></p>
      </form>
    </section>`;
}

function noticeHtml(code: string | null): string {
  const notice = code ? NOTICES[code] : undefined;
  return notice ? `<p class="notice ${notice.tone}" role="status">${escapeHtml(notice.text)}</p>` : "";
}

export async function showApps(request: Request, env: Env, viewer: AppsViewer): Promise<Response> {
  const notice = new URL(request.url).searchParams.get("notice");
  const viewerWithRole = asViewer(viewer);
  const admin =
    viewerWithRole?.role === "super_admin"
      ? registerSection(viewerWithRole, await registeredApps(env), await listProjects(env.DB))
      : "";
  const who = viewerWithRole
    ? ""
    : `<p class="muted">Signed in as <span class="mono">@${escapeHtml(viewer.login)}</span>, without a role in La Fabrique.</p>`;
  return html(
    layout(
      "Apps · La Fabrique extraordinaire",
      `<h1>Apps</h1>${noticeHtml(notice)}${who}${connectionsSection(viewer, await connections(env, viewer.login))}${admin}`,
      viewerWithRole,
    ),
  );
}

// An address the app may be sent back to: https, or http on this machine
// for local development.
function isReturnAddress(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function createdPage(viewer: Viewer, name: string, repo: string, client: ClientInfo): string {
  return layout(
    "App registered · La Fabrique extraordinaire",
    `<h1>${escapeHtml(name)} is registered</h1>
      <p class="notice ok" role="status">Copy the secret now: La Fabrique keeps only its fingerprint and will not show it again.</p>
      <dl class="facts">
        <dt>Project</dt><dd><code>${escapeHtml(projectId(repo))}</code> (${escapeHtml(repo)})</dd>
        <dt>client_id</dt><dd><code>${escapeHtml(client.clientId)}</code></dd>
        <dt>client_secret</dt><dd><code>${escapeHtml(client.clientSecret ?? "")}</code></dd>
        <dt>Return addresses</dt><dd>${client.redirectUris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join("<br />")}</dd>
        <dt>Authorize</dt><dd><code>/oauth/authorize</code>, scope <code>defects:report</code>, PKCE S256</dd>
        <dt>Token</dt><dd><code>/oauth/token</code>, <code>client_secret_post</code></dd>
      </dl>
      <p>Store them as the app's own secrets, never in its code.</p>
      <p><a class="button" href="${APPS_PATH}">Back to the apps</a></p>`,
    viewer,
  );
}

export async function changeApps(form: FormData, env: Env, viewer: AppsViewer): Promise<Response> {
  const action = form.get("action");
  const helpers = oauthHelpers(env);

  if (action === "revoke") {
    const grantId = String(form.get("grant") ?? "");
    const { items } = await helpers.listUserGrants(viewer.login);
    const grant = items.find((item) => item.id === grantId);
    if (!grant) return redirect(`${APPS_PATH}?notice=unknown`);
    await helpers.revokeGrant(grant.id, viewer.login);
    const metadata = grant.metadata as { repo?: unknown } | null;
    await activityStatement(env.DB, {
      actor: viewer.login,
      action: "app_disconnected",
      ...(typeof metadata?.repo === "string" ? { repo: metadata.repo } : {}),
      details: { client_id: grant.clientId },
    }).run();
    return redirect(`${APPS_PATH}?notice=revoked`);
  }

  const admin = asViewer(viewer);
  if (admin?.role !== "super_admin") {
    return html(layout("Not allowed · La Fabrique extraordinaire", "<h1>Not allowed</h1><p>Only a super admin registers apps.</p>", admin), {
      status: 403,
    });
  }

  if (action === "register") {
    const name = String(form.get("name") ?? "").trim().slice(0, 80);
    const repo = String(form.get("repo") ?? "");
    const redirectUris = [...new Set(String(form.get("redirect_uris") ?? "").split(/\s+/).filter(Boolean))];
    const project = repo ? await findProject(env.DB, repo) : null;
    if (!name || !project || !redirectUris.length || redirectUris.length > 10 || !redirectUris.every(isReturnAddress)) {
      return redirect(`${APPS_PATH}?notice=invalid`);
    }
    const client = await helpers.createClient({
      clientName: name,
      redirectUris,
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO oauth_apps (client_id, repo, created_by) VALUES (?, ?, ?)").bind(client.clientId, project.repo, admin.login),
      activityStatement(env.DB, {
        actor: admin.login,
        action: "app_registered",
        repo: project.repo,
        details: { client_id: client.clientId, app: name, redirect_uris: redirectUris },
      }),
    ]);
    return html(createdPage(admin, name, project.repo, client));
  }

  if (action === "remove") {
    const clientId = String(form.get("client") ?? "");
    const repo = await env.DB.prepare("SELECT repo FROM oauth_apps WHERE client_id = ?").bind(clientId).first<{ repo: string }>();
    if (!repo) return redirect(`${APPS_PATH}?notice=unknown`);
    await helpers.deleteClient(clientId);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauth_apps WHERE client_id = ?").bind(clientId),
      activityStatement(env.DB, { actor: admin.login, action: "app_removed", repo: repo.repo, details: { client_id: clientId } }),
    ]);
    return redirect(`${APPS_PATH}?notice=removed`);
  }

  return redirect(APPS_PATH);
}
