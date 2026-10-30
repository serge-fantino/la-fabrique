import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { html, redirect } from "./http";
import { oauthHelpers } from "./oauth";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

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

// For the super admin: every project's app, looked after from the
// project's Setup.
function registeredSection(apps: RegisteredApp[]): string {
  const rows = apps
    .map(
      (app) => `<tr>
        <td><strong>${escapeHtml(app.name)}</strong><br /><code>${escapeHtml(app.clientId)}</code></td>
        <td><a href="/projects/${escapeHtml(app.repo)}/setup#connected-app">${escapeHtml(app.repo)}</a></td>
        <td><span class="mono">@${escapeHtml(app.createdBy)}</span><br /><span class="mono">${escapeHtml(formatDate(app.createdAt))}</span></td>
      </tr>`,
    )
    .join("");
  return `<section>
      <h2>Projects' apps</h2>
      <p>Each project registers its own app, from its Setup tab (<em>Connected app</em>): return addresses, secret, what to put in the project.</p>
      ${
        apps.length
          ? `<table>
          <thead><tr><th>App</th><th>Project</th><th>Registered</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
          : `<p class="muted">No app registered yet.</p>`
      }
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
      ? registeredSection(await registeredApps(env))
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

  return redirect(APPS_PATH);
}
