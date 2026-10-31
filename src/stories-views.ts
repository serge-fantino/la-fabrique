import { cardGroupHead, nicePill, sharedWith, type StoryCards } from "./card-groups";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Story, StoryFilters, StoryGroup } from "./stories";
import { missingForReady, STAGES, type CycleRules, type Stage } from "./lifecycle";
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
    (pull) =>
      `<span class="link-item"><a href="${escapeHtml(pull.url)}">PR #${pull.number}</a> <span class="muted">${pull.state}${pull.guessed ? ", guessed from its text" : ""}</span></span>`,
  );
  const branches = story.branches.map((branch) => `<span class="link-item"><code>${escapeHtml(branch)}</code></span>`);
  return [...pulls, ...branches].join(" ");
}

const STAGE_TONES: Record<Stage, string> = { backlog: "", ready: "ok", in_dev: "warn", on_int: "warn", to_validate: "warn", done: "ok" };

export function stagePill(stage: Stage): string {
  const label = STAGES.find((candidate) => candidate.id === stage)?.label ?? stage;
  return `<span class="pill stage-${stage}${STAGE_TONES[stage] ? ` ${STAGE_TONES[stage]}` : ""}">${label}</span>`;
}

interface StageInfo {
  stages: Map<number, Stage>;
  rules: CycleRules;
}

function stageCell(story: Story, info: StageInfo): string {
  const stage = info.stages.get(story.number);
  if (!stage) return statePill(story);
  const missing = stage === "backlog" ? missingForReady(story, info.rules) : [];
  return `${stagePill(stage)}${missing.length ? `<br /><span class="muted small">${escapeHtml(missing.join(", "))}</span>` : ""}`;
}

function storyRow(story: Story, circuit: Set<string>, info: StageInfo, shared = ""): string {
  return `<tr>
      <td class="mono number"><a href="${escapeHtml(story.url)}">#${story.number}</a></td>
      <td><a href="${escapeHtml(story.url)}">${escapeHtml(story.title)}</a>${shared}<br />${labelChips(story, circuit)}</td>
      <td>${stageCell(story, info)}</td>
      <td class="links-cell">${links(story)}</td>
    </tr>`;
}

function groupSection(group: StoryGroup, circuit: Set<string>, info: StageInfo, repo: string, cards: StoryCards | null): string {
  const epic = group.epic;
  const byCard = group.card !== undefined && cards;
  const head = byCard
    ? cardGroupHead(repo, group.card ?? null, group.items.length)
    : epic
    ? `<div class="group-head">
        <h2><a href="${escapeHtml(epic.url)}">#${epic.number}</a> ${escapeHtml(epic.title)}</h2>
        ${statePill(epic)}
        <span class="mono muted">${epic.subCompleted}/${epic.subTotal} done</span>
        <progress max="${epic.subTotal}" value="${epic.subCompleted}">${epic.subCompleted}/${epic.subTotal}</progress>
      </div>`
    : `<div class="group-head"><h2>Not in an epic</h2></div>`;
  const body = group.items.length
    ? `<table>
        <thead><tr><th>#</th><th>Story</th><th>Stage</th><th>Pull requests and branches</th></tr></thead>
        <tbody>${group.items.map((story) => storyRow(story, circuit, info, byCard ? nicePill(cards, group.card?.id ?? null, story.number) + sharedWith(cards, story.number, group.card?.id ?? null) : "")).join("")}</tbody>
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
    stages: Map<number, Stage>;
    rules: CycleRules;
    groups: StoryGroup[];
    filters: StoryFilters;
    cards: StoryCards | null;
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
      <label>Group by
        <select name="group">${option("epic", "Epic", filters.group !== "card")}${option("card", "Card", filters.group === "card")}</select>
      </label>
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
      <label>Stage
        <select name="stage">${option("", "Any stage", !filters.stage)}${STAGES.map((stage) =>
          option(stage.id, stage.label, filters.stage === stage.id),
        ).join("")}</select>
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
      ${data.groups.length ? data.groups.map((group) => groupSection(group, circuit, { stages: data.stages, rules: data.rules }, project.repo, data.cards)).join("") : `<p>No story matches these filters.</p>`}`,
    viewer,
    [],
    projectContext(project),
  );
}
