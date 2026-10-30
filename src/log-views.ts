import { LOG_GROUPS, type LogEntry, type LogFilters } from "./log";
import { projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { projectUrl } from "./urls";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? escapeHtml(String(value)) : "";
}

// One line of the log in words, its links to GitHub.
export function describe(entry: LogEntry, repo: string): string {
  const issue = (number: unknown) =>
    typeof number === "number" ? `<a href="https://github.com/${escapeHtml(repo)}/issues/${number}">#${number}</a>` : "";
  const story = issue(entry.issue);
  const card = (id: unknown) =>
    typeof id === "number" ? `<a class="mono" href="${escapeHtml(projectUrl(repo))}/cards/${id}">C${id}</a>` : "";
  const d = entry.details;
  switch (entry.action) {
    case "request_created":
      return `wrote request ${story}${d["title"] ? ` “${text(d["title"])}”` : ""}`;
    case "criterion_checked":
      return `checked a criterion of ${story}: “${text(d["text"])}”`;
    case "criterion_unchecked":
      return `unchecked a criterion of ${story}: “${text(d["text"])}”`;
    case "story_validated":
      return `validated ${story} on int${d["version"] ? ` (version <span class="mono">${text(d["version"])}</span>)` : ""}`;
    case "defect_reported":
      return `reported defect ${issue(d["defect"])}${story ? ` on ${story}` : ""}${d["release"] ? ` (version <span class="mono">${text(d["release"])}</span>)` : ""}${d["title"] ? `: “${text(d["title"])}”` : ""}`;
    case "priority_set":
      return `set the priority of ${story}: ${text(d["from"]) || "none"} → ${text(d["to"]) || "none"}`;
    case "config_change_proposed":
      return `proposed a change of <code>${text(d["key"])}</code> in .fabrique.json: <a href="https://github.com/${escapeHtml(repo)}/pull/${entry.issue ?? ""}">PR #${entry.issue ?? ""}</a>`;
    case "kit_update_proposed":
      return `proposed the report kit <span class="mono">${text(d["to"])}</span>${d["from"] ? ` (from <span class="mono">${text(d["from"])}</span>)` : ""}: <a href="https://github.com/${escapeHtml(repo)}/pull/${entry.issue ?? ""}">PR #${entry.issue ?? ""}</a>`;
    case "project_added":
      return "added the project to La Fabrique";
    case "go_given":
      return `gave the go to production${d["version"] ? ` (version <span class="mono">${text(d["version"])}</span>)` : ""}${
        d["reason"] ? `, anyway: “${text(d["reason"])}”` : ""
      }`;
    case "claude_launched":
      return `launched Claude on ${story}`;
    case "card_created":
    case "card_edited":
    case "card_archived":
    case "card_restored": {
      const verb = { card_created: "wrote", card_edited: "edited", card_archived: "archived", card_restored: "restored" }[entry.action];
      return `${verb} card ${card(d["card"])}${d["title"] ? ` “${text(d["title"])}”` : ""}`;
    }
    case "card_moved": {
      const changes = Array.isArray(d["changes"]) ? (d["changes"] as { dimension?: unknown; from?: unknown; to?: unknown }[]) : [];
      const said = changes.map((change) => `${text(change.dimension)}: ${text(change.from) || "not set"} → ${text(change.to) || "not set"}`).join(", ");
      return `moved card ${card(d["card"])}${d["title"] ? ` “${text(d["title"])}”` : ""}${said ? ` (${said})` : ""}`;
    }
    case "card_value_added":
      return `added ${text(d["dimension"])} “${text(d["value"])}” to the board`;
    default:
      return `${escapeHtml(entry.action)}${story ? ` ${story}` : ""}`;
  }
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

export function logPage(
  viewer: Viewer,
  project: Project,
  data: { entries: LogEntry[]; more: boolean; actors: string[]; filters: LogFilters },
): string {
  const name = project.check?.config?.nom || project.repo;
  const base = `${projectUrl(project.repo)}/log`;
  const { filters } = data;
  const query = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    if (filters.group) params.set("group", filters.group);
    if (filters.actor) params.set("actor", filters.actor);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    return `${base}?${params.toString()}`;
  };
  const rows = data.entries
    .map(
      (entry) => `<tr>
        <td class="mono muted nowrap">${formatDate(entry.at.includes("T") ? entry.at : entry.at.replace(" ", "T"))}</td>
        <td class="mono">@${escapeHtml(entry.actor)}</td>
        <td>${describe(entry, project.repo)}</td>
      </tr>`,
    )
    .join("");
  const last = data.entries.at(-1);
  return layout(
    `Log · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "log")}
      <p class="muted">Every decision taken in La Fabrique on this project, newest first: what GitHub does not keep. Nothing here can be changed or deleted.</p>
      <form method="get" action="${escapeHtml(base)}" class="filters">
        <label>What
          <select name="group">${option("", "Everything", !filters.group)}${LOG_GROUPS.map((group) =>
            option(group.id, group.label, filters.group === group.id),
          ).join("")}</select>
        </label>
        <label>Who
          <select name="actor">${option("", "Anyone", !filters.actor)}${data.actors
            .map((actor) => option(actor, `@${actor}`, filters.actor === actor))
            .join("")}</select>
        </label>
        <button type="submit" class="button quiet">Filter</button>
      </form>
      ${
        rows
          ? `<table class="log">
              <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : `<p class="muted">Nothing logged${filters.group || filters.actor ? " for these filters" : " yet"}.</p>`
      }
      ${data.more && last ? `<p><a class="button quiet" href="${escapeHtml(query({ before: String(last.id) }))}">Older</a></p>` : ""}`,
    viewer,
    [],
    projectContext(project),
  );
}
