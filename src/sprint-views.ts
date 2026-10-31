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
  // The release worked on: the sprint started in La Fabrique, or else the
  // one in progress on the project's integration branch.
  current: BoardRelease | null;
  sprint: Sprint | null;
  // The last sprint, when it ended by shipping.
  shipped: Sprint | null;
  cards: Card[];
  stories: Map<number, CardStory>;
  links: StoryCards;
  planned: BoardRelease[];
  canStart: boolean;
  // Order the cards and stories, mark nice to have (Product Engineer and above).
  canOrder: boolean;
  notice?: string | undefined;
  failure?: string | undefined;
}

const STATE_TONES: Record<BoardRelease["state"], string> = { shipped: "ok", in_progress: "warn", planned: "kind" };

function releasePill(release: BoardRelease): string {
  return `<span class="pill ${STATE_TONES[release.state]}">${RELEASE_STATE_LABELS[release.state]}</span>`;
}

export function sprintPage(viewer: Viewer, project: Project, data: SprintData): string {
  const base = projectUrl(project.repo);
  const action = `${base}/sprint`;
  const { current, sprint } = data;
  // A small form: one button, the action and what it acts on.
  const button = (fields: Record<string, string | number>, label: string, text: string, quiet = true) =>
    `<form method="post" action="${escapeHtml(action)}" class="inline sprint-order">${csrfField(viewer)}${Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("")}<button type="submit" class="button${quiet ? " quiet" : ""} small" aria-label="${escapeHtml(label)}">${text}</button></form>`;
  const isDone = (number: number) => {
    const story = data.stories.get(number);
    return story?.stage === "done" || Boolean(story?.closed);
  };
  const storyRow = (number: number, card: number, index: number, count: number) => {
    const story = data.stories.get(number);
    const others = (data.links.byStory.get(number) ?? []).filter((id) => id !== card);
    const nice = isNice(data.links, card, number);
    const controls = data.canOrder
      ? `<td class="sprint-controls">${index > 0 ? button({ action: "story_up", card, story: number }, `Move #${number} up`, "↑") : ""}${
          index < count - 1 ? button({ action: "story_down", card, story: number }, `Move #${number} down`, "↓") : ""
        }${button({ action: "nice", card, story: number, nice: nice ? "0" : "1" }, nice ? `#${number} is needed` : `#${number} is nice to have`, nice ? "Needed" : "Nice to have")}</td>`
      : "";
    return `<tr id="story-${card}-${number}"${nice ? ' class="nice"' : ""}>
        <td class="mono number"><a href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a></td>
        <td>${story ? escapeHtml(story.title) : `<span class="muted">not read yet</span>`}${nice ? ` <span class="pill kind small">Nice to have</span>` : ""}${others.length ? ` <span class="muted small">also in ${others.map(cardRef).join(", ")}</span>` : ""}</td>
        <td>${story?.stage ? stagePill(story.stage) : story ? `<span class="pill">${story.closed ? "Closed" : "Open"}</span>` : ""}</td>
        ${controls}
      </tr>`;
  };
  const storiesOf = (card: number) => data.links.order.get(card) ?? [];
  const numbers = [...new Set(data.cards.flatMap((card) => storiesOf(card.id)))];
  const done = numbers.filter(isDone).length;
  // What is left before the release: the needed stories not done yet (a
  // story needed by one card is needed).
  const left = numbers.filter((number) => !isDone(number) && data.cards.some((card) => storiesOf(card.id).includes(number) && !isNice(data.links, card.id, number))).length;
  const cards = data.cards
    .map((card, index) => {
      const mine = storiesOf(card.id);
      const order = data.canOrder
        ? `<span class="sprint-controls">${index > 0 ? button({ action: "card_up", card: card.id }, `Move ${cardRef(card.id)} up`, "↑") : ""}${
            index < data.cards.length - 1 ? button({ action: "card_down", card: card.id }, `Move ${cardRef(card.id)} down`, "↓") : ""
          }</span>`
        : "";
      return `<section id="card-${card.id}" class="sprint-card"><div class="sprint-card-head">${cardGroupHead(project.repo, { id: card.id, title: card.title, status: card.status, release: card.release, position: card.position }, mine.length)}${order}</div>
        ${
          mine.length
            ? `<table><thead><tr><th>#</th><th>Story</th><th>Stage</th>${data.canOrder ? "<th><span class=\"visually-hidden\">Order</span></th>" : ""}</tr></thead><tbody>${mine.map((number, at) => storyRow(number, card.id, at, mine.length)).join("")}</tbody></table>`
            : `<p class="muted">No story yet: <a href="${escapeHtml(base)}/cards/${card.id}#spec">make them from the card</a>.</p>`
        }
      </section>`;
    })
    .join("");
  // What the release notes say the release brings, made from no card here.
  const declared = (current?.stories ?? []).filter((number) => !numbers.includes(number));

  const head = current
    ? `<div class="sprint-head">
        <h2><span class="mono">${escapeHtml(current.version)}</span>${current.title ? ` ${escapeHtml(current.title)}` : ""} ${releasePill(current)}</h2>
        <p class="muted">${
          sprint
            ? `Started by <span class="mono">@${escapeHtml(sprint.startedBy)}</span> on <span class="mono">${formatDate(sprint.startedAt)}</span>. It ends when the release notes date ${escapeHtml(sprint.release)}.`
            : "In progress on the project's integration branch (its release notes)."
        }</p>
        ${
          sprint && data.canStart
            ? `<form method="post" action="${escapeHtml(action)}" class="inline" data-busy="Stopping…">${csrfField(viewer)}
                <input type="hidden" name="action" value="stop" />
                <button type="submit" class="button quiet">Stop the sprint</button>
              </form>`
            : ""
        }
        <p class="test-summary"><span><strong>${left} stor${left === 1 ? "y" : "ies"} left before the release</strong> · ${data.cards.length} card${data.cards.length === 1 ? "" : "s"}, ${numbers.length} stor${numbers.length === 1 ? "y" : "ies"}, ${done} in production.</span></p>
      </div>
      ${cards || `<p class="muted">No card in ${escapeHtml(current.version)} yet: place cards in it on <a href="${escapeHtml(base)}/board?by=release">the board</a>.</p>`}
      ${
        declared.length
          ? `<section><div class="group-head"><h2>In the release notes, from no card <span class="muted mono">${declared.length}</span></h2></div>
              <ul class="card-stories">${declared.map((number) => `<li><a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a> ${escapeHtml(data.stories.get(number)?.title ?? "")} ${data.stories.get(number)?.stage ? stagePill(data.stories.get(number)?.stage ?? "backlog") : ""}</li>`).join("")}</ul></section>`
          : ""
      }`
    : `<p>No sprint in progress.${data.shipped ? ` The last one, <span class="mono">${escapeHtml(data.shipped.release)}</span>, is out.` : ""} Start one from a planned release below.</p>`;

  const planned = data.planned.length
    ? `<h2>Planned releases</h2>
      <ul class="sprint-planned">${data.planned
        .map(
          (release) => `<li><span class="mono">${escapeHtml(release.version)}</span> ${releasePill(release)}
            ${
              data.canStart && !sprint
                ? `<form method="post" action="${escapeHtml(action)}" class="inline" data-busy="Starting…">${csrfField(viewer)}
                    <input type="hidden" name="action" value="start" />
                    <input type="hidden" name="release" value="${escapeHtml(release.version)}" />
                    <button type="submit" class="button quiet">Start the sprint</button>
                  </form>`
                : ""
            }</li>`,
        )
        .join("")}</ul>
      ${sprint ? `<p class="muted small">One sprint at a time: stop ${escapeHtml(sprint.release)} to start another.</p>` : ""}`
    : `<p class="muted">No planned release: plan one on <a href="${escapeHtml(base)}/board?by=release">the board</a> (Plan a release).</p>`;

  return layout(
    `Sprint · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "sprint")}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      ${head}
      ${planned}`,
    viewer,
    [],
    projectContext(project),
  );
}
