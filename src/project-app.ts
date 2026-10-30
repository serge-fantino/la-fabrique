import type { ClientInfo } from "@cloudflare/workers-oauth-provider";
import { activityStatement } from "./activity-log";
import { randomToken } from "./crypto";
import { integrationConfig, reportingEnvironments } from "./defects";
import type { Env } from "./env";
import type { Environment, FabriqueConfig } from "./fabrique-config";
import { html, redirect } from "./http";
import { KIT_GUIDE_PATH, KIT_VERSION } from "./kit";
import { AUTHORIZE_PATH, DEFECTS_SCOPE, DISCOVERY_PATH, oauthHelpers, projectId, projectName, REVOKE_PATH, TOKEN_PATH } from "./oauth";
import { projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { can } from "./rights";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

// A project's own app, connected to La Fabrique to report defects in the
// name of the person using it (la-fabrique#65). One app per project,
// registered and looked after from the project's Setup.

export const SECRET_NAMES = { id: "FABRIQUE_CLIENT_ID", secret: "FABRIQUE_CLIENT_SECRET", url: "FABRIQUE_URL" };

export interface ProjectApp {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdBy: string;
  createdAt: string;
}

export interface AppLink {
  // Environments the app may report from, by name.
  reporting: Record<string, Environment>;
  // Return addresses the project's `.fabrique.json` implies.
  expected: string[];
  name: string;
  app: ProjectApp | null;
  missing: string[];
  extra: string[];
  connections: number;
  last: { login: string; at: string } | null;
  fabriqueUrl: string;
}

export async function projectApp(env: Env, repo: string): Promise<ProjectApp | null> {
  const row = await env.DB.prepare("SELECT client_id, created_by, created_at FROM oauth_apps WHERE repo = ? ORDER BY created_at DESC LIMIT 1")
    .bind(repo)
    .first<{ client_id: string; created_by: string; created_at: string }>();
  if (!row) return null;
  const client = await oauthHelpers(env).lookupClient(row.client_id);
  if (!client) return null;
  return {
    clientId: row.client_id,
    name: client.clientName ?? row.client_id,
    redirectUris: client.redirectUris,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// Each environment open to reports, at `application.retour`, and the local
// address in development.
export function expectedReturns(application: FabriqueConfig["application"], reporting: Record<string, Environment>): string[] {
  if (!application?.retour) return [];
  const returns = Object.values(reporting).map((environment) => new URL(application.retour ?? "/", environment.url).href);
  if (application.local) returns.push(new URL(application.retour, application.local).href);
  return [...new Set(returns)];
}

export async function appLink(env: Env, project: Project, origin: string): Promise<AppLink> {
  // Like the environments, the app's declaration may reach integration
  // before production.
  const onIntegration = await integrationConfig(env, project);
  const application = project.check?.config?.application ?? onIntegration?.application;
  const [reporting, app, used] = await Promise.all([
    reportingEnvironments(env, project, onIntegration),
    projectApp(env, project.repo),
    env.DB.prepare(
      `SELECT COUNT(*) AS count, MAX(occurred_at) AS at,
         (SELECT actor FROM activity_log WHERE repo = ? AND action = 'app_connected' ORDER BY id DESC LIMIT 1) AS login
       FROM activity_log WHERE repo = ? AND action = 'app_connected'`,
    )
      .bind(project.repo, project.repo)
      .first<{ count: number; at: string | null; login: string | null }>(),
  ]);
  const expected = expectedReturns(application, reporting);
  const registered = app?.redirectUris ?? [];
  return {
    reporting,
    expected,
    name: application?.nom ?? projectName(project),
    app,
    missing: app ? expected.filter((uri) => !registered.includes(uri)) : [],
    extra: app && expected.length ? registered.filter((uri) => !expected.includes(uri)) : [],
    connections: used?.count ?? 0,
    last: used?.at && used.login ? { login: used.login, at: used.at } : null,
    fabriqueUrl: origin,
  };
}

// --- Views -----------------------------------------------------------------

function codeBlock(text: string): string {
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

function list(uris: string[]): string {
  return uris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join("<br />");
}

function envNames(link: AppLink): string[] {
  return Object.keys(link.reporting);
}

// What the project itself holds: its declaration, and the app's Worker
// settings on each environment open to reports.
function projectSide(link: AppLink, clientId: string | null): string {
  const names = envNames(link);
  const targets = names.length ? names : ["int"];
  const commands = targets
    .map((name) => `npx wrangler secret put ${SECRET_NAMES.id} --env ${name}\nnpx wrangler secret put ${SECRET_NAMES.secret} --env ${name}`)
    .join("\n");
  return `<h3>In the project</h3>
      <ol class="app-steps">
        <li><code>.fabrique.json</code> opens reporting on an environment and says where the app comes back:
          ${codeBlock(`"environnements": {
  "${targets[0]}": { "url": "…", "version": "/api/version", "type": "integration", "signalement": true }
},
"application": { "nom": "${link.name}", "retour": "/auth/fabrique/retour", "local": "http://localhost:8787" }`)}
          <p class="muted small">The version path answers <code>"environnement": "${escapeHtml(targets[0] ?? "int")}"</code>. Never on production.</p></li>
        <li>The app's Worker, on ${targets.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}: the variable <code>${SECRET_NAMES.url}</code> = <code>${escapeHtml(
          link.fabriqueUrl,
        )}</code>, and two secrets, <code>${SECRET_NAMES.id}</code>${clientId ? ` = <code>${escapeHtml(clientId)}</code>` : ""} and <code>${SECRET_NAMES.secret}</code> (shown once, when registered or renewed):
          ${codeBlock(commands)}
          <p class="muted small"><code>--env</code> takes the name of the Worker's environment in its wrangler configuration; here, the environment's name in <code>.fabrique.json</code>.</p></li>
        <li>The app sends the person to <code>${AUTHORIZE_PATH}</code> (scope <code>${DEFECTS_SCOPE}</code>, PKCE S256), exchanges the code at <code>${TOKEN_PATH}</code> (<code>client_secret_post</code>), then calls <code>GET /api/me</code> and <code>POST /api/projects/{project}/defects</code> with the token; <code>${REVOKE_PATH}</code> disconnects. Everything is in <code>${DISCOVERY_PATH}</code>.</li>
        <li>The <strong>Report a defect</strong> button: copy the report kit ${KIT_VERSION} (<a href="/kit/fabrique-report.js">fabrique-report.js</a>, <a href="/kit/fabrique-report.css">fabrique-report.css</a>, <a href="/kit/fabrique-report-early.js">fabrique-report-early.js</a>) into the app, and add its relay, two routes on the app's server that forward the reports with the person's token. <a href="${KIT_GUIDE_PATH}">How, step by step</a>.</li>
      </ol>`;
}

export function appSection(viewer: Viewer, project: Project, link: AppLink): string {
  const admin = can(viewer.role, "go");
  const action = `${escapeHtml(projectUrl(project.repo))}/app`;
  const reporting = envNames(link);
  const opened = reporting.length
    ? `Reports are open on ${reporting.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}.`
    : "No environment is open to reports yet: <code>signalement</code> is not <code>true</code> on any.";

  let status: string;
  if (!link.app) {
    status = `<p>No app is registered for this project.</p>
      ${
        admin
          ? `<form method="post" action="${action}" class="request-form">${csrfField(viewer)}
          <input type="hidden" name="action" value="register" />
          <div class="field"><label for="app-name">Name</label>
            <p class="help">On the consent page: “‹name› will be able to report defects in your name on ${escapeHtml(projectName(project))}”.</p>
            <input id="app-name" type="text" name="name" required maxlength="80" value="${escapeHtml(link.name)}" /></div>
          <div class="field"><label for="app-return">Return addresses</label>
            <p class="help">One per line: https, or http on localhost.${link.expected.length ? " Filled in from <code>.fabrique.json</code>." : " Add <code>application.retour</code> to <code>.fabrique.json</code> and La Fabrique fills them in."}</p>
            <textarea id="app-return" name="redirect_uris" rows="3" required>${escapeHtml(link.expected.join("\n"))}</textarea></div>
          <p><button type="submit" class="button">Register the app</button></p>
        </form>`
          : `<p class="muted small">A super admin registers it here.</p>`
      }`;
  } else {
    const app = link.app;
    const used = link.connections
      ? `Connected ${link.connections} time${link.connections > 1 ? "s" : ""}${link.last ? `, last by <span class="mono">@${escapeHtml(link.last.login)}</span> on <span class="mono">${escapeHtml(formatDate(link.last.at))}</span>` : ""}.`
      : "Nobody has connected it yet: once the project has its secrets, the first connection shows here.";
    const drift = link.missing.length || link.extra.length
      ? `<p class="notice error" role="status">The return addresses differ from <code>.fabrique.json</code>${
          link.missing.length ? `: missing ${list(link.missing)}` : ""
        }${link.extra.length ? `${link.missing.length ? ";" : ":"} not declared ${list(link.extra)}` : ""}.</p>
        ${
          admin
            ? `<form method="post" action="${action}">${csrfField(viewer)}
            <input type="hidden" name="action" value="returns" />
            <button type="submit" class="button">Use the addresses of .fabrique.json</button>
          </form>`
            : ""
        }`
      : "";
    status = `<dl class="facts">
        <dt>App</dt><dd><strong>${escapeHtml(app.name)}</strong></dd>
        <dt>client_id</dt><dd><code>${escapeHtml(app.clientId)}</code></dd>
        <dt>Return addresses</dt><dd>${list(app.redirectUris)}</dd>
        <dt>Registered</dt><dd><span class="mono">@${escapeHtml(app.createdBy)}</span> · <span class="mono">${escapeHtml(formatDate(app.createdAt))}</span></dd>
        <dt>Used</dt><dd>${used}</dd>
      </dl>
      ${drift}
      ${
        admin
          ? `<div class="app-actions">
          <form method="post" action="${action}">${csrfField(viewer)}
            <input type="hidden" name="action" value="secret" />
            <button type="submit" class="button quiet">New secret</button>
          </form>
          <form method="post" action="${action}">${csrfField(viewer)}
            <input type="hidden" name="action" value="remove" />
            <button type="submit" class="button quiet">Remove the app</button>
          </form>
        </div>
        <p class="muted small">A new secret keeps the connections: put it in the project's secrets right away, the old one stops working. Removing the app disconnects everyone.</p>`
          : ""
      }`;
  }

  return `<section class="project-app" id="connected-app">
      <h2>Connected app</h2>
      <p class="muted">The project's own app can report defects in the name of the person using it, from the page where they show up. ${opened}</p>
      ${status}
      ${projectSide(link, link.app?.clientId ?? null)}
    </section>`;
}

// Shown once, after registering or renewing: what goes into the project.
function secretPage(viewer: Viewer, project: Project, link: AppLink, client: ClientInfo, renewed: boolean): string {
  const names = envNames(link);
  const targets = names.length ? names : ["int"];
  return layout(
    `Connected app · ${projectName(project)} · La Fabrique extraordinaire`,
    `${projectHeader(project, "setup")}
      <h2>${escapeHtml(client.clientName ?? link.name)} ${renewed ? "has a new secret" : "is registered"}</h2>
      <p class="notice ok" role="status">Copy the secret now: La Fabrique keeps only its fingerprint and will not show it again.</p>
      <dl class="facts">
        <dt>Project</dt><dd><code>${escapeHtml(projectId(project.repo))}</code> (${escapeHtml(project.repo)})</dd>
        <dt>client_id</dt><dd><code>${escapeHtml(client.clientId)}</code></dd>
        <dt>client_secret</dt><dd><code>${escapeHtml(client.clientSecret ?? "")}</code></dd>
        <dt>Return addresses</dt><dd>${list(client.redirectUris)}</dd>
      </dl>
      <h3>Put them in the project</h3>
      <p>In the app's folder, for each environment open to reports; paste the value when wrangler asks:</p>
      ${codeBlock(
        targets
          .map((name) => `npx wrangler secret put ${SECRET_NAMES.id} --env ${name}   # ${client.clientId}\nnpx wrangler secret put ${SECRET_NAMES.secret} --env ${name}`)
          .join("\n"),
      )}
      <p>And the variable <code>${SECRET_NAMES.url}</code> = <code>${escapeHtml(link.fabriqueUrl)}</code> in its wrangler configuration, if it is not there yet.</p>
      <p><a class="button" href="${escapeHtml(projectUrl(project.repo))}/setup#connected-app">Back to Setup</a></p>`,
    viewer,
    [],
    projectContext(project),
  );
}

// --- Actions ---------------------------------------------------------------

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

function readReturns(value: unknown): string[] | null {
  const uris = [...new Set(String(value ?? "").split(/\s+/).filter(Boolean))];
  return uris.length && uris.length <= 10 && uris.every(isReturnAddress) ? uris : null;
}

export type AppActionFailure = "invalid" | "exists" | "none" | "no_returns";

// Register, renew the secret, follow `.fabrique.json`, remove: the super
// admin only, logged.
export async function changeProjectApp(
  form: FormData,
  env: Env,
  viewer: Viewer,
  project: Project,
  origin: string,
): Promise<Response | AppActionFailure> {
  const helpers = oauthHelpers(env);
  const action = form.get("action");
  const link = await appLink(env, project, origin);
  const log = (name: string, details: Record<string, unknown>) =>
    activityStatement(env.DB, { actor: viewer.login, action: name, repo: project.repo, details });

  if (action === "register") {
    if (link.app) return "exists";
    const name = String(form.get("name") ?? "").trim().slice(0, 80);
    const redirectUris = readReturns(form.get("redirect_uris"));
    if (!name || !redirectUris) return "invalid";
    const client = await helpers.createClient({
      clientName: name,
      redirectUris,
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO oauth_apps (client_id, repo, created_by) VALUES (?, ?, ?)").bind(client.clientId, project.repo, viewer.login),
      log("app_registered", { client_id: client.clientId, app: name, redirect_uris: redirectUris }),
    ]);
    return html(secretPage(viewer, project, link, client, false));
  }

  if (!link.app) return "none";
  const clientId = link.app.clientId;

  if (action === "secret") {
    const client = await helpers.updateClient(clientId, { clientSecret: randomToken(32) });
    if (!client) return "none";
    await log("app_secret_renewed", { client_id: clientId }).run();
    return html(secretPage(viewer, project, link, client, true));
  }

  if (action === "returns") {
    if (!link.expected.length) return "no_returns";
    await helpers.updateClient(clientId, { redirectUris: link.expected });
    await log("app_returns_changed", { client_id: clientId, redirect_uris: link.expected }).run();
    return redirect(`${projectUrl(project.repo)}/setup?notice=app_returns#connected-app`);
  }

  if (action === "remove") {
    await helpers.deleteClient(clientId);
    await env.DB.batch([env.DB.prepare("DELETE FROM oauth_apps WHERE client_id = ?").bind(clientId), log("app_removed", { client_id: clientId })]);
    return redirect(`${projectUrl(project.repo)}/setup?notice=app_removed#connected-app`);
  }

  return "invalid";
}
