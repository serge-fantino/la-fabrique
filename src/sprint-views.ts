import { RELEASE_STATE_LABELS, type BoardRelease } from "./card-releases";
import { cardGroupHead, isNice, type StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";
import { cardRef } from "./card-views";
import type { Card } from "./cards";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Sprint } from "./sprints";
import { stagePill } from "./stories-views";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

export interface SprintData {
  // The sprint running, if any; `legacy` when it was started on a version.
  sprint: Sprint | null;
  legacy: boolean;
  // The last sprint, once ended.
  last: Sprint | null;
  sprintCards: Card[];
  nextCards: Card[];
  // Without a sprint: the release in progress on the integration branch.
  integration: BoardRelease | null;
  integrationCards: Card[];
  stories: Map<number, CardStory>;
  links: StoryCards;
  // Start, close, order, mark nice to have (Product Engineer and above).
  canOrder: boolean;
  // The project's priorities (highest first) and whether its Definition of
  // Ready asks for the ready label (then "Mark ready" sets it).
  priorities: string[];
  readyLabel: string | null;
  // Launching Claude Code (la-fabrique#113): tech lead and above, through
  // the project's own workflow; null when the project declares none.
  claude: { canLaunch: boolean; workflow: string | null; cap: number; launches: Map<number, { by: string; at: string }>; next: number | null };
  notice?: string | undefined;
  failure?: string | undefined;
}

export function sprintPage(viewer: Viewer, project: Project, data: SprintData): string {
  const base = projectUrl(project.repo);
  const action = `${base}/sprint`;
  const { sprint } = data;
  // A small form: one button, the action and what it acts on.
  const button = (fields: Record<string, string | number>, label: string, text: string, kind = "quiet small") =>
    `<form method="post" action="${escapeHtml(action)}" class="inline sprint-order" data-busy="…">${csrfField(viewer)}${Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("")}<button type="submit" class="button ${kind}" aria-label="${escapeHtml(label)}">${text}</button></form>`;
  const isDone = (number: number) => {
    const story = data.stories.get(number);
    return story?.stage === "done" || Boolean(story?.closed);
  };
  const storiesOf = (card: number) => data.links.order.get(card) ?? [];

  const claudeCell = (number: number) => {
    const story = data.stories.get(number);
    const launched = data.claude.launches.get(number);
    const last = launched ? `<span class="muted small">Claude launched by @${escapeHtml(launched.by)} on ${escapeHtml(launched.at.slice(0, 10))}</span>` : "";
    if (!data.claude.canLaunch || !data.claude.workflow || story?.stage !== "ready") return last;
    return `${button({ action: "launch", story: number }, `Launch Claude on #${number}`, launched ? "Launch again" : "Launch Claude", "quiet small claude")}${last}`;
  };
  // A priority chosen from a list, sent at once (the button without script).
  const prioritySelect = (fields: Record<string, string | number>, current: string | null, label: string) =>
    `<form method="post" action="${escapeHtml(action)}" class="priority-form inline">${csrfField(viewer)}${Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("")}<select name="priority" aria-label="${escapeHtml(label)}" data-autosubmit>${[...data.priorities, ""]
      .map((value) => `<option value="${escapeHtml(value)}"${(current ?? "") === value ? " selected" : ""}>${value ? escapeHtml(value) : "No priority"}</option>`)
      .join("")}</select><button type="submit" class="button quiet small" data-autosubmit-button>Set</button></form>`;
  // Why a story is not ready, and what fixes it here.
  const readiness = (number: number, controls: boolean) => {
    const story = data.stories.get(number);
    if (!story || story.stage !== "backlog") return "";
    const fixes = controls
      ? [
          story.missing.includes("not labelled ready") && data.readyLabel ? button({ action: "story_ready", story: number }, `Mark #${number} ready`, "Mark ready") : "",
          story.missing.includes("no acceptance criteria")
            ? `<a class="small" href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">Add its criteria on GitHub</a>`
            : "",
        ].join("")
      : "";
    return `<br /><span class="muted small">Not ready: ${escapeHtml(story.missing.join(", "))}</span>${fixes ? ` <span class="sprint-fixes">${fixes}</span>` : ""}`;
  };
  const storyRow = (number: number, card: number, index: number, count: number, controls: boolean, launchable: boolean) => {
    const story = data.stories.get(number);
    const others = (data.links.byStory.get(number) ?? []).filter((id) => id !== card);
    const nice = isNice(data.links, card, number);
    const cell = controls
      ? `<td class="sprint-controls">${index > 0 ? button({ action: "story_up", card, story: number }, `Move #${number} up`, "↑") : ""}${
          index < count - 1 ? button({ action: "story_down", card, story: number }, `Move #${number} down`, "↓") : ""
        }${button({ action: "nice", card, story: number, nice: nice ? "0" : "1" }, nice ? `#${number} is needed` : `#${number} is nice to have`, nice ? "Needed" : "Nice to have")}</td>`
      : "";
    return `<tr id="story-${card}-${number}"${nice ? ' class="nice"' : ""}>
        <td class="mono number"><a href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a></td>
        <td>${story ? escapeHtml(story.title) : `<span class="muted">not read yet</span>`}${nice ? ` <span class="pill kind small">Nice to have</span>` : ""}${others.length ? ` <span class="muted small">also in ${others.map(cardRef).join(", ")}</span>` : ""}</td>
        <td>${story?.stage ? stagePill(story.stage) : story ? `<span class="pill">${story.closed ? "Closed" : "Open"}</span>` : ""}${readiness(number, controls)}</td>
        ${
          data.priorities.length
            ? `<td>${controls ? prioritySelect({ action: "story_priority", card, story: number }, story?.priority ?? null, `Priority of #${number}`) : story?.priority ? `<span class="pill">${escapeHtml(story.priority)}</span>` : ""}</td>`
            : ""
        }
        ${launchable ? `<td class="sprint-claude">${claudeCell(number)}</td>` : ""}
        ${cell}
      </tr>`;
  };

  // Cards with their stories; with controls, in an order one can change.
  // Claude is launched from the sprint only.
  const cardsSection = (cards: Card[], controls: boolean, claude = false) => {
    const launchable = claude && Boolean(data.claude.workflow);
    return cards
      .map((card, index) => {
        const mine = storiesOf(card.id);
        // The card's priority: its stories take it (one level lower when
        // nice to have).
        const priority = data.priorities.length
          ? controls
            ? `<span class="sprint-card-priority"><span class="muted small">Priority, for the card and its stories</span> ${prioritySelect({ action: "card_priority", card: card.id }, card.priority, `Priority of ${cardRef(card.id)} and its stories`)}</span>`
            : card.priority
              ? `<span class="pill">${escapeHtml(card.priority)}</span>`
              : ""
          : "";
        const order = controls
          ? `<span class="sprint-controls">${index > 0 ? button({ action: "card_up", card: card.id }, `Move ${cardRef(card.id)} up`, "↑") : ""}${
              index < cards.length - 1 ? button({ action: "card_down", card: card.id }, `Move ${cardRef(card.id)} down`, "↓") : ""
            }</span>`
          : "";
        return `<section id="card-${card.id}" class="sprint-card"><div class="sprint-card-head">${cardGroupHead(
          project.repo,
          { id: card.id, title: card.title, status: card.status, release: card.release, position: card.position },
          mine.length,
        )}${priority}${order}</div>
          ${
            mine.length
              ? `<table><thead><tr><th>#</th><th>Story</th><th>Stage</th>${data.priorities.length ? "<th>Priority</th>" : ""}${launchable && controls ? '<th class="claude-col">Claude</th>' : ""}${controls ? '<th><span class="visually-hidden">Order</span></th>' : ""}</tr></thead><tbody>${mine
                  .map((number, at) => storyRow(number, card.id, at, mine.length, controls, launchable))
                  .join("")}</tbody></table>`
              : `<p class="muted">No story yet: <a href="${escapeHtml(base)}/cards/${card.id}#spec">make them from the card</a>.</p>`
          }
        </section>`;
      })
      .join("");
  };

  // What is left: the needed stories not done yet (a story needed by one
  // card is needed).
  const summary = (cards: Card[]) => {
    const numbers = [...new Set(cards.flatMap((card) => storiesOf(card.id)))];
    const done = numbers.filter(isDone).length;
    const left = numbers.filter((number) => !isDone(number) && cards.some((card) => storiesOf(card.id).includes(number) && !isNice(data.links, card.id, number))).length;
    return `<p class="test-summary"><span><strong>${left} stor${left === 1 ? "y" : "ies"} left</strong> · ${cards.length} card${cards.length === 1 ? "" : "s"}, ${numbers.length} stor${numbers.length === 1 ? "y" : "ies"}, ${done} in production.</span></p>`;
  };

  // Claude Code takes the stories in the sprint's order: the next one is the
  // first ready story not launched yet.
  const nextStory = data.claude.next !== null ? data.stories.get(data.claude.next) : undefined;
  const claudeNext = !data.claude.canLaunch
    ? ""
    : !data.claude.workflow
      ? `<p class="muted">To launch Claude Code from the sprint, the project declares its Claude workflow (<code>workflows.claude</code> in <code>.fabrique.json</code>): <a href="${escapeHtml(base)}/setup">Setup</a> says how.</p>`
      : data.claude.next !== null
        ? `<div class="sprint-next"><p>Next for Claude: <a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${data.claude.next}">#${data.claude.next}</a> ${escapeHtml(nextStory?.title ?? "")}</p>${button(
            { action: "launch", story: data.claude.next },
            `Launch Claude on #${data.claude.next}`,
            "Launch the next story",
            "claude",
          )}<p class="muted small">At most ${data.claude.cap} Claude run${data.claude.cap === 1 ? "" : "s"} at once on this project.</p></div>`
        : `<p class="muted">No story ready for Claude: a story is ready once it meets the project's Definition of Ready (<a href="${escapeHtml(base)}/backlog?group=card">Backlog</a> says what is missing).</p>`;

  const lastLine = data.last
    ? data.last.endReason === "stopped"
      ? `The last sprint was stopped on <span class="mono">${formatDate(data.last.endedAt ?? "")}</span>.`
      : `The last sprint ended on <span class="mono">${formatDate(data.last.endedAt ?? "")}</span>${data.last.release && data.last.release !== "Sprint" ? `, shipped in <span class="mono">${escapeHtml(data.last.release)}</span>` : ""}.`
    : "";

  const current = sprint
    ? `<section class="sprint-head">
        <h2>${data.legacy ? `<span class="mono">${escapeHtml(sprint.release)}</span>` : "Sprint"} <span class="pill warn">${RELEASE_STATE_LABELS.in_progress}</span></h2>
        <p class="muted">Started by <span class="mono">@${escapeHtml(sprint.startedBy)}</span> on <span class="mono">${formatDate(sprint.startedAt)}</span>. ${
          data.legacy
            ? `It ends when the release notes date ${escapeHtml(sprint.release)}.`
            : "It closes by itself once every needed story is in production: each card then takes the version that shipped it, and what is not done goes back to Next release."
        }</p>
        ${
          data.canOrder
            ? `<div class="card-actions">${data.legacy ? "" : button({ action: "close" }, "Close the sprint now", "Close the sprint")}${button({ action: "stop" }, "Stop the sprint", "Stop the sprint")}</div>`
            : ""
        }
        ${summary(data.sprintCards)}
        ${claudeNext}
      </section>
      ${cardsSection(data.sprintCards, data.canOrder, true) || `<p class="muted">No card in the sprint.</p>`}`
    : `<section class="sprint-head">
        <h2>No sprint in progress</h2>
        <p>${lastLine} ${
          data.nextCards.length
            ? `The next sprint takes the ${data.nextCards.length} card${data.nextCards.length === 1 ? "" : "s"} of Next release, below.`
            : `Place the cards of the next sprint in <strong>Next release</strong> on <a href="${escapeHtml(base)}/board?by=release">the board</a>.`
        }</p>
        ${data.canOrder && data.nextCards.length ? button({ action: "start" }, "Start the sprint", "Start the sprint", "") : ""}
      </section>`;

  const next = `<h2 id="next">Next release <span class="muted mono">${data.nextCards.length}</span></h2>
      ${
        data.nextCards.length
          ? `<p class="muted">What the next sprint takes, in this order.</p>${cardsSection(data.nextCards, data.canOrder)}`
          : `<p class="muted">No card yet: drag cards into the Next release lane of <a href="${escapeHtml(base)}/board?by=release">the board</a>.</p>`
      }`;

  // The release in progress on the integration branch (its release notes),
  // read-only.
  const integration =
    !sprint && data.integration
      ? `<h2>On integration: <span class="mono">${escapeHtml(data.integration.version)}</span>${data.integration.title ? ` ${escapeHtml(data.integration.title)}` : ""} <span class="pill warn">${RELEASE_STATE_LABELS.in_progress}</span></h2>
        ${data.integrationCards.length ? `${summary(data.integrationCards)}${cardsSection(data.integrationCards, false)}` : `<p class="muted">No card in ${escapeHtml(data.integration.version)}.</p>`}`
      : "";

  return layout(
    `Sprint · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "sprint")}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      ${current}
      ${next}
      ${integration}`,
    viewer,
    [],
    projectContext(project),
  );
}
