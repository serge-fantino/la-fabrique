import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { MyRequest, RequestDraft, RequestStep, Rubrique } from "./requests";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

const DRAFT_SCRIPT = "/request-draft.js";

const STEPS: Record<RequestStep, string> = {
  open: `<span class="pill">Issue open</span>`,
  ready: `<span class="pill warn">Ready for Claude</span>`,
  to_validate: `<span class="pill warn">To validate on int</span>`,
  closed: `<span class="pill ok">Closed</span>`,
};

export function draftKey(repo: string): string {
  return `lf-request:${repo.toLowerCase()}`;
}

function title(project: Project, page: string): string {
  return `${page} · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`;
}

export function requestsPage(
  viewer: Viewer,
  project: Project,
  data: { requests: MyRequest[]; canCreate: boolean; created?: number | undefined; failure?: string | undefined },
): string {
  const created = data.created
    ? `<p class="notice ok" role="status" data-draft-clear="${escapeHtml(draftKey(project.repo))}">Request #${data.created} created on GitHub.</p>`
    : "";
  const action = data.canCreate
    ? `<p><a class="button" href="${escapeHtml(projectUrl(project.repo))}/requests/new">New request</a></p>`
    : "";
  const list = data.requests.length
    ? `<table>
        <thead><tr><th>#</th><th>Request</th><th>Where it stands</th><th>Created</th></tr></thead>
        <tbody>${data.requests
          .map(
            (request) => `<tr>
              <td class="mono number">${request.url ? `<a href="${escapeHtml(request.url)}">#${request.number}</a>` : `#${request.number}`}</td>
              <td>${request.url ? `<a href="${escapeHtml(request.url)}">${escapeHtml(request.title)}</a>` : escapeHtml(request.title)}</td>
              <td>${request.step ? STEPS[request.step] : `<span class="muted">unknown</span>`}</td>
              <td class="mono muted">${formatDate(request.createdAt)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>`
    : `<p class="muted">You have not written a request for this project yet.</p>`;

  return layout(
    title(project, "Requests"),
    `${projectHeader(project, "requests")}
      ${created}
      ${notice(data.failure, "error")}
      ${action}
      <h2>My requests</h2>
      ${list}`,
    viewer,
    data.created ? [DRAFT_SCRIPT] : [],
    projectContext(project),
  );
}

export function requestFormPage(
  viewer: Viewer,
  project: Project,
  data: { rubriques: Rubrique[]; draft?: RequestDraft; missing?: string[]; error?: string },
): string {
  const draft = data.draft ?? { title: "", answers: {} };
  const missing = new Set(data.missing ?? []);
  const errors = data.missing?.length
    ? `<div class="notice error" role="alert"><p>Fill in before sending:</p><ul>${data.missing
        .map((field) => `<li>${escapeHtml(field)}</li>`)
        .join("")}</ul></div>`
    : "";

  const fields = data.rubriques
    .map((rubrique) => {
      const id = `r_${rubrique.cle}`;
      const help = rubrique.aide ? `<p class="help" id="${id}_help">${escapeHtml(rubrique.aide)}</p>` : "";
      return `<div class="field${missing.has(rubrique.titre) ? " invalid" : ""}">
          <label for="${id}">${escapeHtml(rubrique.titre)}${rubrique.obligatoire ? ` <span class="muted">(required)</span>` : ""}</label>
          ${help}
          <textarea id="${id}" name="${id}" rows="5"${rubrique.obligatoire ? " required" : ""}${
            rubrique.aide ? ` aria-describedby="${id}_help"` : ""
          }>${escapeHtml(draft.answers[rubrique.cle] ?? "")}</textarea>
        </div>`;
    })
    .join("");

  const body = data.rubriques.length
    ? `<p>Your request becomes an issue in <code>${escapeHtml(project.repo)}</code>, under your GitHub name.</p>
      ${errors}
      ${notice(data.error, "error")}
      <form method="post" action="${escapeHtml(projectUrl(project.repo))}/requests" class="request-form" data-draft-key="${escapeHtml(draftKey(project.repo))}">
        ${csrfField(viewer)}
        <div class="field${missing.has("Title") ? " invalid" : ""}">
          <label for="title">Title <span class="muted">(required)</span></label>
          <input id="title" name="title" required maxlength="200" value="${escapeHtml(draft.title)}" />
        </div>
        ${fields}
        <p class="muted" data-draft-status aria-live="polite"></p>
        <button type="submit" class="button">Send to GitHub</button>
      </form>`
    : `<p>This project does not describe a request form yet (<code>demandes.rubriques</code> in <code>.fabrique.json</code>).</p>`;

  return layout(
    title(project, "New request"),
    `${projectHeader(project, "requests", "New request")}
      ${body}`,
    viewer,
    [DRAFT_SCRIPT],
    projectContext(project),
  );
}
