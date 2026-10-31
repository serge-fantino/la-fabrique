import { cardGroupHead, groupByCard, sharedWith, type StoryCards } from "./card-groups";
import { isEpic, missingForReady, priorityOf, type CycleRules, type Stage } from "./lifecycle";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Story } from "./stories";
import { stagePill } from "./stories-views";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

export interface BacklogData {
  stories: Story[];
  stages: Map<number, Stage>;
  rules: CycleRules;
  canPrioritize: boolean;
  // The Launch Claude column, for the roles that may and when the project
  // declares its Claude workflow.
  claude: { show: boolean; launches: Map<number, { by: string; at: string }>; cap: number };
  fetchedAt: string | null;
  // Grouped by priority, or by the card each story was made from.
  group: "priority" | "card";
  cards: StoryCards | null;
  notice?: string | undefined;
  failure?: string | undefined;
}

function priorityForm(viewer: Viewer, project: Project, story: Story, rules: CycleRules, current: string | null, group: string): string {
  const options = [...rules.priorities, ""]
    .map(
      (label) =>
        `<option value="${escapeHtml(label)}"${(current ?? "") === label ? " selected" : ""}>${label ? escapeHtml(label) : "None"}</option>`,
    )
    .join("");
  return `<form method="post" action="${escapeHtml(projectUrl(project.repo))}/backlog" class="priority-form">
      ${csrfField(viewer)}
      <input type="hidden" name="issue" value="${story.number}" />
      ${group === "card" ? `<input type="hidden" name="group" value="card" />` : ""}
      <select name="priority" aria-label="Priority of #${story.number}" data-autosubmit>${options}</select>
      <button type="submit" class="button quiet" data-autosubmit-button>Set</button>
    </form>`;
}

function claudeCell(viewer: Viewer, project: Project, story: Story, stage: Stage, launched: { by: string; at: string } | undefined): string {
  const last = launched
    ? `<span class="muted small">launched by @${escapeHtml(launched.by)} on ${escapeHtml(launched.at.slice(0, 10))}</span>`
    : "";
  if (stage !== "ready") return last || `<span class="muted small">not ready</span>`;
  return `<form method="post" action="${escapeHtml(projectUrl(project.repo))}/backlog/claude" class="claude-form">
      ${csrfField(viewer)}
      <input type="hidden" name="issue" value="${story.number}" />
      <button type="submit" class="button quiet claude">${launched ? "Launch again" : "Launch Claude"}</button>
    </form>${last}`;
}

// The stories not started yet, by priority; within one, the ready ones first.
export function backlogPage(viewer: Viewer, project: Project, data: BacklogData): string {
  const name = project.check?.config?.nom || project.repo;
  const byNumber = new Map(data.stories.map((story) => [story.number, story]));
  const waiting = data.stories.filter((story) => {
    const stage = data.stages.get(story.number);
    return !isEpic(story) && (stage === "backlog" || stage === "ready");
  });
  const ready = (story: Story) => (data.stages.get(story.number) === "ready" ? 0 : 1);
  const groups = [...data.rules.priorities, null].map((priority) => ({
    priority,
    items: waiting
      .filter((story) => priorityOf(story, data.rules) === priority)
      .sort((a, b) => ready(a) - ready(b) || a.number - b.number),
  }));
  const readyCount = waiting.filter((story) => data.stages.get(story.number) === "ready").length;

  const counts = groups
    .filter((group) => data.rules.priorities.length || group.priority === null)
    .map((group) => `${group.priority ? escapeHtml(group.priority) : "no priority"} <strong>${group.items.length}</strong>`)
    .join(" · ");

  const row = (story: Story, card: number | null = null) => {
    const stage = data.stages.get(story.number) ?? "backlog";
    const missing = stage === "backlog" ? missingForReady(story, data.rules) : [];
    const epic = story.parent !== null ? byNumber.get(story.parent) : undefined;
    const current = priorityOf(story, data.rules);
    return `<tr id="issue-${story.number}">
        <td class="mono number"><a href="${escapeHtml(story.url)}">#${story.number}</a></td>
        <td><a href="${escapeHtml(story.url)}">${escapeHtml(story.title)}</a>${data.group === "card" && data.cards ? sharedWith(data.cards, story.number, card) : ""}${
          epic ? `<br /><span class="muted small">#${epic.number} ${escapeHtml(epic.title)}</span>` : ""
        }</td>
        <td>${stagePill(stage)}${missing.length ? `<br /><span class="muted small">${escapeHtml(missing.join(", "))}</span>` : ""}</td>
        ${data.claude.show ? `<td>${claudeCell(viewer, project, story, stage, data.claude.launches.get(story.number))}</td>` : ""}
        ${
          data.rules.priorities.length
            ? `<td>${data.canPrioritize ? priorityForm(viewer, project, story, data.rules, current, data.group) : current ? `<span class="pill">${escapeHtml(current)}</span>` : `<span class="muted">none</span>`}</td>`
            : ""
        }
      </tr>`;
  };

  const table = (items: Story[], card: number | null = null) => `<table class="backlog">
          <thead><tr><th>#</th><th>Story</th><th>Stage</th>${data.claude.show ? '<th class="claude-col">Claude</th>' : ""}${data.rules.priorities.length ? "<th>Priority</th>" : ""}</tr></thead>
          <tbody>${items.map((story) => row(story, card)).join("")}</tbody>
        </table>`;
  // By card: each card's stories not started yet, the ready ones first.
  const sections =
    data.group === "card" && data.cards
      ? groupByCard(
          [...waiting].sort((a, b) => ready(a) - ready(b) || a.number - b.number),
          data.cards,
        )
          .map((group) => `<section>${cardGroupHead(project.repo, group.card, group.items.length)}${table(group.items, group.card?.id ?? null)}</section>`)
          .join("")
      : groups
          .filter((group) => group.items.length)
          .map(
            (group) => `<section>
        <h2>${group.priority ? escapeHtml(group.priority) : data.rules.priorities.length ? "No priority" : "Backlog"} <span class="muted mono">${group.items.length}</span></h2>
        ${table(group.items)}
      </section>`,
          )
          .join("");
  const base = `${projectUrl(project.repo)}/backlog`;
  const grouping = `<p class="group-switch">Group by
      <a href="${escapeHtml(base)}"${data.group === "priority" ? ' aria-current="true"' : ""}>Priority</a>
      <a href="${escapeHtml(base)}?group=card"${data.group === "card" ? ' aria-current="true"' : ""}>Card</a></p>`;

  return layout(
    `Backlog · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "backlog")}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      <p class="test-summary"><span><strong>${waiting.length} stor${waiting.length === 1 ? "y" : "ies"} not started</strong>, ${readyCount} ready${
        counts ? ` · ${counts}` : ""
      }.</span>${data.fetchedAt ? ` <span class="muted small">From GitHub, read ${formatDate(data.fetchedAt)}.</span>` : ""}</p>
      ${
        data.rules.priorities.length
          ? ""
          : `<p class="muted">To prioritise, declare priority labels in <code>.fabrique.json</code> (<code>cycle.priorites</code>); <a href="${escapeHtml(projectUrl(project.repo))}/setup">Setup</a> says how.</p>`
      }
      ${grouping}
      ${sections || `<p class="muted">Nothing waits: every story is started or done.</p>`}`,
    viewer,
    [],
    projectContext(project),
  );
}
