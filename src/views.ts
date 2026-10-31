import { ROLE_LABELS, ROLES, type AccountRow, type Role } from "./accounts";
import type { ActivityRow } from "./activity-log";
import { assetUrl } from "./assets";
import { buildInfo } from "./build";
import { logoMark } from "./logo";
import { releaseAnchor, WHATS_NEW_PATH } from "./urls";
import { availablePerspectives, PERSPECTIVE_LABELS, type Perspective } from "./perspectives";

export interface Viewer {
  login: string;
  role: Role;
  csrfToken: string;
  // What the person sees (la-fabrique#75); absent: everything.
  perspective?: Perspective;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function csrfField(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`;
}

function roleOptions(selected?: Role): string {
  return ROLES.map(
    (role) =>
      `<option value="${role}"${role === selected ? " selected" : ""}>${ROLE_LABELS[role]}</option>`,
  ).join("");
}

// Links to GitHub and to the projects' environments open in a new tab.
export function externalLinks(html: string): string {
  return html.replace(/<a (?![^>]*\btarget=)([^>]*\bhref="https?:\/\/)/g, '<a target="_blank" rel="noopener noreferrer" $1');
}

// The perspective switcher, when the role opens more than one.
function perspectiveMenu(viewer: Viewer): string {
  const available = availablePerspectives(viewer.role);
  if (available.length < 2) return "";
  const current = viewer.perspective ?? "all";
  const items = available
    .map(
      (perspective) => `<li><form method="post" action="/perspective">${csrfField(viewer)}
          <input type="hidden" name="perspective" value="${perspective}" />
          <button type="submit" class="menu-choice"${perspective === current ? ' aria-current="true"' : ""}>${PERSPECTIVE_LABELS[perspective]}</button>
        </form></li>`,
    )
    .join("");
  return `<details class="branch-menu perspective-menu" data-menu>
      <summary><span class="muted">Perspective</span> ${PERSPECTIVE_LABELS[current]}</summary>
      <div class="branch-panel"><ul class="branch-list">${items}</ul></div>
    </details>`;
}

// `context` is the left part of the line under the bar (a project and its
// branch); the signed-in person is on its right.
export function layout(title: string, body: string, viewer?: Viewer, scripts: string[] = [], context = ""): string {
  const nav = viewer
    ? `<nav class="nav">
        <a class="nav-home" href="/">Dashboard</a>
        <a href="/projects">Projects</a>
        ${viewer.role === "super_admin" ? `<a href="/people">People</a>` : ""}
        <a href="/settings">Settings</a>
        <form method="post" action="/auth/logout">${csrfField(viewer)}
          <button type="submit" class="button quiet">Sign out</button>
        </form>
      </nav>`
    : "";
  const subbar = viewer
    ? `<div class="subbar">
        <div class="subbar-context">${externalLinks(context)}</div>
        <span class="who">${perspectiveMenu(viewer)}<span class="mono">@${escapeHtml(viewer.login)}</span>
          <span class="pill">${ROLE_LABELS[viewer.role]}</span></span>
      </div>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap" />
    <link rel="stylesheet" href="${assetUrl("/styles.css")}" />
    ${["/fabrique.js", ...scripts].map((src) => `<script src="${escapeHtml(assetUrl(src))}" defer></script>`).join("")}
  </head>
  <body>
    <div class="loading" data-loading aria-hidden="true"><i></i></div>
    <header class="bar">
      <span class="brand-line"><a class="brand" href="/" aria-label="La Fabrique extraordinaire">${logoMark("brand-mark")}<span class="brand-words" aria-hidden="true"><span class="brand-top">La Fabrique</span><span class="brand-bottom"><span class="strike">extra</span>ordinaire</span></span></a>${versionInfo(viewer)}</span>
      ${nav}
    </header>
    ${subbar}
    <main>
${externalLinks(body)}
    </main>
  </body>
</html>`;
}

// The (i) next to the name: the version running, when it was released
// (Paris time) and its commit; Update reloads when a newer one is out.
function versionInfo(viewer?: Viewer): string {
  const info = buildInfo();
  const short = info.commit.slice(0, 7);
  return `<span class="version-info">
      <button type="button" class="version-i" aria-describedby="version-pop" aria-label="About this version">i</button>
      <span class="version-pop" id="version-pop" role="tooltip">
        <strong>${info.version ? `Version <span class="mono">${escapeHtml(info.version)}</span>` : "Version unknown"}</strong>
        ${info.date ? `<span>Released <span class="mono">${escapeHtml(info.date)}${info.time ? ` ${escapeHtml(info.time)}` : ""}</span> (Paris)</span>` : ""}
        <span>Commit <code>${escapeHtml(short)}</code></span>
        <span class="version-actions">
          ${viewer ? `<a class="button quiet small" href="${WHATS_NEW_PATH}${info.version ? `#${releaseAnchor(info.version)}` : ""}">What's new</a>` : ""}
          <a class="button quiet small" href="" data-update data-commit="${escapeHtml(info.commit)}"><span aria-hidden="true">🔄</span> Update</a>
        </span>
      </span>
    </span>`;
}

export function homePage(): string {
  return layout(
    "La Fabrique extraordinaire",
    `<header class="hero">
        <p class="eyebrow">The control panel</p>
        <h1>La Fabrique extraordinaire</h1>
        <p class="lede">
          Documentation online, stories, what awaits production, and a traceable
          request workflow &mdash; from the Product Engineer's need to the
          version in production.
        </p>
      </header>
      <section>
        <p>Access is by invitation: a super admin grants a role to your GitHub account.</p>
        <p><a class="button" href="/auth/login">Sign in with GitHub</a></p>
      </section>`,
  );
}

export function noAccessPage(): string {
  return layout(
    "No access yet · La Fabrique extraordinaire",
    `<h1>No access yet</h1>
      <p>Your GitHub account does not have a role in La Fabrique extraordinaire.</p>
      <p>Your request has been recorded. A super admin can grant you a role; you will
        get in at your next sign-in.</p>`,
  );
}

export function messagePage(title: string, message: string, viewer?: Viewer): string {
  return layout(
    `${title} · La Fabrique extraordinaire`,
    `<h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="/">Back to La Fabrique extraordinaire</a></p>`,
    viewer,
  );
}

const PEOPLE_NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  added: { tone: "ok", text: "Person added." },
  updated: { tone: "ok", text: "Role changed." },
  removed: { tone: "ok", text: "Person removed." },
  invalid_login: { tone: "error", text: "That is not a valid GitHub login." },
  invalid_role: { tone: "error", text: "Choose one of the four roles." },
  exists: { tone: "error", text: "This person already has a role. Change it in the list." },
  unknown: { tone: "error", text: "This person has no role in La Fabrique extraordinaire." },
  configured: {
    tone: "error",
    text: "This super admin is set in the Worker configuration (SUPER_ADMINS) and cannot be changed here.",
  },
};

const ACTION_LABELS: Record<string, string> = {
  account_added: "added",
  account_role_changed: "changed the role of",
  account_removed: "removed",
};

interface PeopleData {
  viewer: Viewer;
  accounts: AccountRow[];
  configuredSuperAdmins: string[];
  requests: { login: string; lastRequestedAt: string }[];
  changes: ActivityRow[];
  notice?: string | undefined;
}

function describeChange(row: ActivityRow): string {
  const details = row.details ? (JSON.parse(row.details) as Record<string, string>) : {};
  const target = details["login"] ? `<span class="mono">@${escapeHtml(details["login"])}</span>` : "";
  const role = details["role"] && ROLE_LABELS[details["role"] as Role];
  return `<span class="mono">@${escapeHtml(row.actor)}</span> ${ACTION_LABELS[row.action] ?? escapeHtml(row.action)} ${target}${role ? ` (${role})` : ""}`;
}

export function peoplePage(data: PeopleData): string {
  const { viewer } = data;
  const notice = data.notice ? PEOPLE_NOTICES[data.notice] : undefined;

  const configuredRows = data.configuredSuperAdmins
    .map(
      (login) => `<tr>
          <td class="mono">@${escapeHtml(login)}</td>
          <td><span class="pill">Super admin</span></td>
          <td class="muted" colspan="2">Set in the Worker configuration</td>
        </tr>`,
    )
    .join("");

  const accountRows = data.accounts
    .map(
      (account) => `<tr>
          <td class="mono">@${escapeHtml(account.github_login)}</td>
          <td>
            <form method="post" action="/people" class="inline">${csrfField(viewer)}
              <input type="hidden" name="action" value="update" />
              <input type="hidden" name="login" value="${escapeHtml(account.github_login)}" />
              <label class="visually-hidden" for="role-${escapeHtml(account.github_login)}">Role</label>
              <select id="role-${escapeHtml(account.github_login)}" name="role">${roleOptions(account.role)}</select>
              <button type="submit" class="button quiet">Change</button>
            </form>
          </td>
          <td class="mono muted">${formatDate(account.updated_at)}</td>
          <td>
            <form method="post" action="/people" class="inline">${csrfField(viewer)}
              <input type="hidden" name="action" value="remove" />
              <input type="hidden" name="login" value="${escapeHtml(account.github_login)}" />
              <button type="submit" class="button danger">Remove</button>
            </form>
          </td>
        </tr>`,
    )
    .join("");

  const requests = data.requests.length
    ? `<section>
        <h2>Access requests</h2>
        <table>
          <thead><tr><th>GitHub login</th><th>Last request</th><th>Grant a role</th></tr></thead>
          <tbody>${data.requests
            .map(
              (request) => `<tr>
              <td class="mono">@${escapeHtml(request.login)}</td>
              <td class="mono muted">${formatDate(request.lastRequestedAt)}</td>
              <td>
                <form method="post" action="/people" class="inline">${csrfField(viewer)}
                  <input type="hidden" name="action" value="add" />
                  <input type="hidden" name="login" value="${escapeHtml(request.login)}" />
                  <label class="visually-hidden" for="grant-${escapeHtml(request.login)}">Role</label>
                  <select id="grant-${escapeHtml(request.login)}" name="role">${roleOptions("tester")}</select>
                  <button type="submit" class="button">Grant</button>
                </form>
              </td>
            </tr>`,
            )
            .join("")}</tbody>
        </table>
      </section>`
    : "";

  const changes = data.changes.length
    ? `<section>
        <h2>Recent changes</h2>
        <ul class="log">${data.changes
          .map(
            (row) =>
              `<li><span class="mono muted">${formatDate(row.occurred_at)}</span> ${describeChange(row)}</li>`,
          )
          .join("")}</ul>
      </section>`
    : "";

  return layout(
    "People · La Fabrique extraordinaire",
    `<h1>People</h1>
      ${notice ? `<p class="notice ${notice.tone}" role="status">${escapeHtml(notice.text)}</p>` : ""}
      <section>
        <h2>Add a person</h2>
        <form method="post" action="/people" class="row">${csrfField(viewer)}
          <input type="hidden" name="action" value="add" />
          <label>GitHub login
            <input name="login" required autocomplete="off" spellcheck="false" placeholder="octocat" />
          </label>
          <label>Role
            <select name="role">${roleOptions("tester")}</select>
          </label>
          <button type="submit" class="button">Add</button>
        </form>
      </section>
      ${requests}
      <section>
        <h2>Who has access</h2>
        <table>
          <thead><tr><th>GitHub login</th><th>Role</th><th>Updated</th><th></th></tr></thead>
          <tbody>${configuredRows}${accountRows}</tbody>
        </table>
      </section>
      ${changes}`,
    viewer,
  );
}
