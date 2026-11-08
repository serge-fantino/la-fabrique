import type { Card } from "./cards";
import { epicProgressSummary, type EpicProgress } from "./epic-progress";
import { cardRef, cardUrl } from "./card-views";
import { EPIC_STATUS_LABELS, EPIC_STATUS_TONES, epicChoices, type EpicHistoryEntry, type EpicState } from "./epic-status";
import { projectContext, projectHeader, notice } from "./project-views";
import type { Project } from "./projects";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

export function epicStatusPill(state: EpicState): string {
  return `<span class="pill ${EPIC_STATUS_TONES[state.status]}" title="${escapeHtml(state.reason)}">${EPIC_STATUS_LABELS[state.status]}</span>`;
}

// Drop / Archive / Unarchive, only when the epic's status allows it.
export function epicActions(viewer: Viewer, url: string, epic: Card, state: EpicState, back: "epics" | null): string {
  const choices = epicChoices(epic, state);
  const button = (action: string, label: string): string =>
    `<form method="post" action="${escapeHtml(url)}" class="inline" data-busy>${csrfField(viewer)}
      <input type="hidden" name="action" value="${action}" />${back ? `<input type="hidden" name="back" value="${back}" />` : ""}
      <button type="submit" class="button quiet small">${label}</button></form>`;
  return [choices.drop ? button("epic_drop", "Drop") : "", choices.archive ? button("epic_archive", "Archive") : "", choices.unarchive ? button("epic_unarchive", "Unarchive") : ""].join(" ");
}

export function epicHistoryHtml(history: EpicHistoryEntry[]): string {
  if (!history.length) return "";
  const rows = history
    .map((entry) => {
      const what =
        entry.action === "epic_created" || entry.action === "card_created" ? "created" : entry.action === "epic_issue_linked" ? "linked to its GitHub issue" : entry.action === "epic_issue_created" ? "GitHub issue created" : entry.action === "epic_archived" ? "archived" : entry.action === "epic_unarchived" ? "unarchived" : `${entry.from ? EPIC_STATUS_LABELS[entry.from as keyof typeof EPIC_STATUS_LABELS] ?? entry.from : "—"} → ${EPIC_STATUS_LABELS[entry.to as keyof typeof EPIC_STATUS_LABELS] ?? entry.to}`;
      return `<li><span class="mono muted">${formatDate(entry.at)} · ${entry.actor === "la-fabrique" ? "La Fabrique" : `@${escapeHtml(entry.actor)}`}</span> ${escapeHtml(what)}${entry.reason ? ` <span class="muted">(${escapeHtml(entry.reason)})</span>` : ""}</li>`;
    })
    .join("");
  return `<section id="status-history"><h2>Status history</h2><ul class="card-history">${rows}</ul></section>`;
}

export interface EpicsData {
  epics: { epic: Card; state: EpicState; progress?: EpicProgress }[];
  archived: boolean;
  canWrite: boolean;
  notice?: string | undefined;
}

export function epicsPage(viewer: Viewer, project: Project, data: EpicsData): string {
  const base = projectUrl(project.repo);
  const rows = data.epics
    .map(
      ({ epic, state, progress }) => `<tr>
        <td><a href="${escapeHtml(cardUrl(project.repo, epic.id))}"><span class="mono">${cardRef(epic.id)}</span> ${escapeHtml(epic.title)}</a>${epic.archivedAt ? ` <span class="pill alert small">Archived</span>` : ""}</td>
        <td>${epicStatusPill(state)}</td>
        <td class="mono">${state.features}</td>
        <td>${progress ? epicProgressSummary(progress, true) : ""}</td>
        <td>${data.canWrite ? epicActions(viewer, cardUrl(project.repo, epic.id), epic, state, "epics") : ""}</td>
      </tr>`,
    )
    .join("");
  const toggle = data.archived
    ? `<a href="${escapeHtml(base)}/epics">Hide archived epics</a>`
    : `<a href="${escapeHtml(base)}/epics?archived=1">Show archived epics</a>`;
  return layout(
    `Epics · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "epics")}
      ${notice(data.notice, "ok")}
      <h1>Epics</h1>
      <p class="muted">The status follows the features: Ideation (none), Open, Active (one is in the sprint), Done (all shipped or dropped). ${toggle}</p>
      ${
        rows
          ? `<table class="table"><thead><tr><th>Epic</th><th>Status</th><th>Features</th><th>Progress</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">${data.archived ? "No epic." : "No epic yet."}</p>`
      }`,
    viewer,
    [],
    projectContext(project, false),
  );
}
