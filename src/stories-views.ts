import { notice, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Story, StoryFilters, StoryGroup } from "./stories";
import { projectUrl } from "./urls";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

function statePill(story: Story): string {
  return story.state === "open" ? `<span class="pill ok">Open</span>` : `<span class="pill">Closed</span>`;
}

function labelChips(story: Story, circuit: Set<string>): string {
  return story.labels
    .map((label) => `<span class="chip${circuit.has(label) ? " circuit" : ""}">${escapeHtml(label)}</span>`)
    .join("");
}

function links(story: Story): string {
  const pulls = story.pullRequests.map(
    (pull) => `<span class="link-item"><a href="${escapeHtml(pull.url)}">PR #${pull.number}</a> <span class="muted">${pull.state}</span></span>`,
  );
  const branches = story.branches.map((branch) => `<span class="link-item"><code>${escapeHtml(branch)}</code></span>`);
  return [...pulls, ...branches].join(" ");
}

function storyRow(story: Story, circuit: Set<string>): string {
  return `<tr>
      <td class="mono number"><a href="${escapeHtml(story.url)}">#${story.number}</a></td>
      <td><a href="${escapeHtml(story.url)}">${escapeHtml(story.title)}</a><br />${labelChips(story, circuit)}</td>
      <td>${statePill(story)}</td>
      <td class="links-cell">${links(story)}</td>
    </tr>`;
}

function groupSection(group: StoryGroup, circuit: Set<string>): string {
  const epic = group.epic;
  const head = epic
    ? `<div class="group-head">
        <h2><a href="${escapeHtml(epic.url)}">#${epic.number}</a> ${escapeHtml(epic.title)}</h2>
        ${statePill(epic)}
        <span class="mono muted">${epic.subCompleted}/${epic.subTotal} done</span>
        <progress max="${epic.subTotal}" value="${epic.subCompleted}">${epic.subCompleted}/${epic.subTotal}</progress>
      </div>`
    : `<div class="group-head"><h2>Not in an epic</h2></div>`;
  const body = group.items.length
    ? `<table>
        <thead><tr><th>#</th><th>Story</th><th>State</th><th>Pull requests and branches</th></tr></thead>
        <tbody>${group.items.map((story) => storyRow(story, circuit)).join("")}</tbody>
      </table>`
    : `<p class="muted">No story matches these filters.</p>`;
  return `<section>${head}${body}</section>`;
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

export function storiesPage(
  viewer: Viewer,
  project: Project,
  data: {
    stories: Story[];
    groups: StoryGroup[];
    filters: StoryFilters;
    fetchedAt: string | null;
    failure?: string | undefined;
  },
): string {
  const etiquettes = Object.values(project.check?.config?.demandes?.etiquettes ?? {});
  const circuit = new Set(etiquettes);
  const labels = [...new Set([...data.stories.flatMap((story) => story.labels), ...etiquettes])].sort((a, b) =>
    a.localeCompare(b),
  );
  const epics = data.stories.filter((story) => story.subTotal > 0).sort((a, b) => a.number - b.number);
  const { filters } = data;

  const form = `<form method="get" action="${escapeHtml(projectUrl(project.repo))}/stories" class="filters">
      <label>Epic
        <select name="epic">${option("", "All epics", filters.epic === null)}${epics
          .map((epic) => option(String(epic.number), `#${epic.number} ${epic.title}`, filters.epic === epic.number))
          .join("")}</select>
      </label>
      <label>Label
        <select name="label">${option("", "Any label", filters.label === null)}${labels
          .map((label) => option(label, label, filters.label === label))
          .join("")}</select>
      </label>
      <label>State
        <select name="state">${option("all", "Open and closed", filters.state === "all")}${option(
          "open",
          "Open",
          filters.state === "open",
        )}${option("closed", "Closed", filters.state === "closed")}</select>
      </label>
      <label class="check"><input type="checkbox" name="mine" value="1"${filters.mine ? " checked" : ""} /> Opened by me</label>
      <button type="submit" class="button quiet">Filter</button>
    </form>`;

  const meta = data.fetchedAt
    ? `<p class="muted">From GitHub, read <span class="mono">${formatDate(data.fetchedAt)}</span>; changes arrive through the webhook.</p>`
    : "";

  return layout(
    `Stories · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "stories")}
      ${notice(data.failure, "error")}
      ${form}
      ${meta}
      ${data.groups.length ? data.groups.map((group) => groupSection(group, circuit)).join("") : `<p>No story matches these filters.</p>`}`,
    viewer,
  );
}
