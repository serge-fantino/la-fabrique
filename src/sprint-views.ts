import { RELEASE_STATE_LABELS, type BoardRelease } from "./card-releases";
import { cardGroupHead } from "./card-groups";
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
  links: Map<number, number[]>;
  planned: BoardRelease[];
  canStart: boolean;
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
  const storyRow = (number: number, card: number) => {
    const story = data.stories.get(number);
    const others = (data.links.get(number) ?? []).filter((id) => id !== card);
    return `<tr>
        <td class="mono number"><a href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a></td>
        <td>${story ? escapeHtml(story.title) : `<span class="muted">not read yet</span>`}${others.length ? ` <span class="muted small">also in ${others.map(cardRef).join(", ")}</span>` : ""}</td>
        <td>${story?.stage ? stagePill(story.stage) : story ? `<span class="pill">${story.closed ? "Closed" : "Open"}</span>` : ""}</td>
      </tr>`;
  };
  const numbers = [...new Set(data.cards.flatMap((card) => [...data.links.entries()].filter(([, cards]) => cards.includes(card.id)).map(([number]) => number)))];
  const done = numbers.filter((number) => {
    const story = data.stories.get(number);
    return story?.stage === "done" || story?.closed;
  }).length;
  const cards = data.cards
    .map((card) => {
      const mine = [...data.links.entries()].filter(([, cards]) => cards.includes(card.id)).map(([number]) => number).sort((a, b) => a - b);
      return `<section>${cardGroupHead(project.repo, { id: card.id, title: card.title, status: card.status, release: card.release, position: card.position }, mine.length)}
        ${
          mine.length
            ? `<table><thead><tr><th>#</th><th>Story</th><th>Stage</th></tr></thead><tbody>${mine.map((number) => storyRow(number, card.id)).join("")}</tbody></table>`
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
        <p class="test-summary"><span><strong>${data.cards.length} card${data.cards.length === 1 ? "" : "s"}</strong>, ${numbers.length} stor${numbers.length === 1 ? "y" : "ies"}, ${done} in production.</span></p>
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
