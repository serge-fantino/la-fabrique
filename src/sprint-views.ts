import { RELEASE_STATE_LABELS, type BoardRelease } from "./card-releases";
import { cardGroupHead, isNice, type StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";
import { cardRef } from "./card-views";
import { isRunning, type ClaudeRun } from "./claude";
import type { PullDetail } from "./sprint-pulls";
import type { Card } from "./cards";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Sprint } from "./sprints";
import { stagePill } from "./stories-views";
import type { Progress } from "./progress-stages";
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
  keptCards: Card[];
  // Without a sprint: the release in progress on the integration branch.
  integration: BoardRelease | null;
  integrationCards: Card[];
  stories: Map<number, CardStory>;
  links: StoryCards;
  // Start, close, order, mark nice to have (Product Engineer and above).
  canOrder: boolean;
  // The sprint stories' pull requests, as GitHub has them, and who can be
  // asked to review one.
  pulls: Map<number, PullDetail>;
  // The last merge run of each pull request: refused, and why.
  merges?: Map<number, { conclusion: string | null; reason: string | null; url: string | null; at: string }>;
  // Each card's progress, from its stories.
  progress?: Map<number, Progress>;
  // Merging through the project's workflow (workflows.fusionner), and who may.
  merge?: { workflow: string | null; can: (base: string | null) => boolean };
  reviewers: string[];
  // The project's priorities (highest first) and whether its Definition of
  // Ready asks for the ready label (then "Mark ready" sets it).
  priorities: string[];
  readyLabel: string | null;
  // Launching Claude Code (la-fabrique#113): tech lead and above, through
  // the project's own workflow; null when the project declares none.
  claude: {
    canLaunch: boolean;
    workflow: string | null;
    cap: number;
    launches: Map<number, { by: string; at: string }>;
    next: number | null;
    // The workflow's runs, newest first, and its page on GitHub.
    runs: ClaudeRun[];
    runsUrl: string | null;
  };
  notice?: string | undefined;
  failure?: string | undefined;
}

// A run's state: queued, working (since when), done, failed; its link.
function runPill(run: ClaudeRun): string {
  const [label, tone] =
    run.status !== "completed"
      ? [run.status === "in_progress" ? "Claude working" : "Claude queued", "warn"]
      : run.conclusion === "success"
        ? ["Claude done", "ok"]
        : run.conclusion === "cancelled"
          ? ["Claude cancelled", ""]
          : ["Claude failed", "alert"];
  return `<a class="pill ${tone} small" href="${escapeHtml(run.url)}" title="Started ${escapeHtml(run.createdAt.slice(0, 16).replace("T", " "))} UTC">${label}</a>`;
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
    const run = data.claude.runs.find((candidate) => candidate.issue === number);
    const last = `${run ? runPill(run) : ""}${launched ? `<span class="muted small">launched by @${escapeHtml(launched.by)} on ${escapeHtml(launched.at.slice(0, 10))}</span>` : ""}`;
    if (!data.claude.canLaunch || !data.claude.workflow || story?.stage !== "ready" || (run && isRunning(run))) return last;
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
    return `<br /><span class="muted small">Not ready: ${escapeHtml(story.missing.join(", "))} (<a href="${escapeHtml(base)}/setup#lifecycle">Definition of Ready</a>)</span>${fixes ? ` <span class="sprint-fixes">${fixes}</span>` : ""}`;
  };
  // A story's pull requests: open first; what each waits for; a review to ask.
  const pullsOf = (number: number, controls: boolean) => {
    const pulls = [...(data.stories.get(number)?.pulls ?? [])].sort((a, b) => (a.state === "open" ? -1 : 0) - (b.state === "open" ? -1 : 0) || b.number - a.number);
    return pulls
      .map((pull) => {
        const detail = data.pulls.get(pull.number);
        const state = detail?.draft && pull.state === "open" ? "draft" : pull.state;
        const tone = state === "merged" ? "ok" : state === "open" ? "warn" : "";
        const waiting = detail?.reviewers.length
          ? ` <span class="muted small">review asked from ${detail.reviewers.map((login) => `@${escapeHtml(login)}`).join(", ")}</span>`
          : pull.state === "open"
            ? ` <span class="muted small">no review asked</span>`
            : "";
        const ask =
          controls && pull.state === "open" && data.reviewers.length
            ? `<form method="post" action="${escapeHtml(action)}" class="inline sprint-review">${csrfField(viewer)}
                <input type="hidden" name="action" value="review" />
                <input type="hidden" name="pull" value="${pull.number}" />
                <label class="visually-hidden" for="reviewer-${pull.number}">Reviewer of pull request #${pull.number}</label>
                <select id="reviewer-${pull.number}" name="reviewer">${data.reviewers
                  .filter((login) => login !== detail?.author && !detail?.reviewers.includes(login))
                  .map((login) => `<option value="${escapeHtml(login)}">@${escapeHtml(login)}</option>`)
                  .join("")}</select>
                <button type="submit" class="button quiet small">Ask for a review</button>
              </form>`
            : "";
        // Behind or in conflict with its base: Claude can bring it up to date.
        const stale = pull.state === "open" && (detail?.mergeable === "dirty" || detail?.mergeable === "behind");
        const against = detail?.base ? ` <code>${escapeHtml(detail.base)}</code>` : " its base";
        const mergeState = stale
          ? ` <span class="pill ${detail?.mergeable === "dirty" ? "alert" : "warn"} small">${detail?.mergeable === "dirty" ? `In conflict with${against}` : `Behind${against}`}</span>`
          : "";
        const running = data.claude.runs.some((run) => run.issue === number && isRunning(run));
        const update =
          stale && controls && data.claude.canLaunch && data.claude.workflow && !running
            ? button({ action: "update", story: number, pull: pull.number }, `Bring pull request #${pull.number} up to date with Claude`, "Update with Claude", "quiet small claude")
            : "";
        const mergeable = pull.state === "open" && !detail?.draft && detail && detail.mergeable !== "dirty" && !running;
        const merge =
          mergeable && controls && data.merge?.workflow && data.merge.can(detail.base)
            ? button({ action: "merge", pull: pull.number }, `Merge pull request #${pull.number}`, "Merge", "small")
            : "";
        const attempt = pull.state === "open" ? data.merges?.get(pull.number) : undefined;
        const refused =
          attempt && attempt.conclusion !== "success"
            ? ` <span class="sprint-merge-refused"><span class="pill alert small">Merge refused</span> <span class="small">${escapeHtml(attempt.reason ?? "The merge workflow stopped.")}</span>${
                attempt.url?.startsWith("https://github.com/") ? ` <a class="small" href="${escapeHtml(attempt.url)}">the run</a>` : ""
              }</span>`
            : "";
        const guessed = pull.guessed
          ? ` <span class="muted small" title="Only the pull request's text names this story: no linked branch, no closing reference, not its branch name.">guessed from its text</span>`
          : "";
        return `<span class="sprint-pull"><a class="pill ${tone} small" href="${escapeHtml(pull.url)}">PR #${pull.number} ${state}</a>${mergeState}${update}${merge}${refused}${guessed}${waiting}${ask}</span>`;
      })
      .join("");
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
        <td>${story ? escapeHtml(story.title) : `<span class="muted">not read yet</span>`}${nice ? ` <span class="pill kind small">Nice to have</span>` : ""}${others.length ? ` <span class="muted small">also in ${others.map(cardRef).join(", ")}</span>` : ""}${
          story?.pulls.length ? `<br />${pullsOf(number, controls)}` : ""
        }</td>
        <td>${story?.stage ? stagePill(story.stage) : story ? `<span class="pill">${story.closed ? "Closed" : "Open"}</span>` : ""}${
          story?.stage === "to_validate" ? ` <a class="small" href="${escapeHtml(base)}/to-test#story-${number}">Validate in To test</a>` : ""
        }${readiness(number, controls)}</td>
        ${
          data.priorities.length
            ? `<td>${controls ? prioritySelect({ action: "story_priority", card, story: number }, story?.priority ?? null, `Priority of #${number}`) : story?.priority ? `<span class="pill">${escapeHtml(story.priority)}</span>` : ""}</td>`
            : ""
        }
        ${launchable ? `<td class="sprint-claude">${claudeCell(number)}</td>` : ""}
        ${cell}
      </tr>`;
  };

  // A card kept from a closed sprint: its stories already in production are
  // done, folded under it, not work to do.
  const shown = (_mine: number[], number: number, foldDone: boolean) => !(foldDone && isDone(number));
  const foldedDone = (card: number, foldDone: boolean) => {
    const done = foldDone ? storiesOf(card).filter(isDone) : [];
    return done.length
      ? `<details class="sprint-done"><summary class="muted small">${done.length} stor${done.length === 1 ? "y" : "ies"} already in production</summary><ul>${done
          .map((number) => `<li><a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a> ${escapeHtml(data.stories.get(number)?.title ?? "")}</li>`)
          .join("")}</ul></details>`
      : "";
  };

  // Cards with their stories; with controls, in an order one can change.
  // Claude is launched from the sprint only.
  const cardsSection = (cards: Card[], controls: boolean, claude = false, foldDone = false) => {
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
          { id: card.id, title: card.title, status: card.status, release: card.release, position: card.position, progress: card.progress },
          mine.length,
          data.progress?.get(card.id),
        )}${priority}${order}</div>
          ${foldedDone(card.id, foldDone)}
          ${
            mine.length
              ? `<table><thead><tr><th>#</th><th>Story</th><th>Stage</th>${data.priorities.length ? "<th>Priority</th>" : ""}${launchable && controls ? '<th class="claude-col">Claude</th>' : ""}${controls ? '<th><span class="visually-hidden">Order</span></th>' : ""}</tr></thead><tbody>${mine
                  .map((number, at) => (shown(mine, number, foldDone) ? storyRow(number, card.id, at, mine.length, controls, launchable) : ""))
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
  // Claude's runs on GitHub: those in progress, and where to see them all.
  const running = data.claude.runs.filter(isRunning);
  // With the script, the page follows Claude's runs as GitHub reports them.
  const runsLine = data.claude.workflow
    ? `<p class="sprint-runs" data-sprint-live="${escapeHtml(action)}/live">${
        running.length
          ? `Claude is working: ${running.map((run) => `${runPill(run)}${run.issue ? ` <span class="mono">#${run.issue}</span>` : ""}`).join(" · ")}`
          : `<span class="muted">Claude is not working now.</span>`
      }${data.claude.runsUrl ? ` <a class="small" href="${escapeHtml(data.claude.runsUrl)}">Every Claude run on GitHub</a>` : ""} <a class="small" href="${escapeHtml(action)}">Refresh</a></p>`
    : "";
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
        : `<p class="muted">No story ready for Claude: a story is ready once it meets the project's <a href="${escapeHtml(base)}/setup#lifecycle">Definition of Ready</a>; each story below says what it lacks.</p>`;

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
            : "It stays open until someone closes it: each finished card then takes the version that shipped it, and a card not finished stays in the sprint for the next one."
        }</p>
        ${
          data.canOrder
            ? `<div class="card-actions">${data.legacy ? "" : button({ action: "close" }, "Close the sprint", "Close the sprint")}</div>`
            : ""
        }
        ${summary(data.sprintCards)}
        ${runsLine}
        ${claudeNext}
      </section>
      ${cardsSection(data.sprintCards, data.canOrder, true, true) || `<p class="muted">No card in the sprint.</p>`}`
    : `<section class="sprint-head">
        <h2>No sprint in progress</h2>
        <p>${lastLine} ${
          data.nextCards.length || data.keptCards.length
            ? `The next sprint takes the ${data.keptCards.length ? `${data.keptCards.length} unfinished card${data.keptCards.length === 1 ? "" : "s"} of the last one and the ` : ""}${data.nextCards.length} card${data.nextCards.length === 1 ? "" : "s"} of Next release, below.`
            : `Place the cards of the next sprint in <strong>Next release</strong> on <a href="${escapeHtml(base)}/board?by=release">the board</a>.`
        }</p>
        ${data.canOrder && (data.nextCards.length || data.keptCards.length) ? button({ action: "start" }, "Start the sprint", "Start the sprint", "") : ""}
      </section>`;

  const kept = data.keptCards.length
    ? `<h2 id="kept">Kept in the sprint <span class="muted mono">${data.keptCards.length}</span></h2>
      <p class="muted">Not finished when the last sprint closed: they stay with their feature, their stories already in production folded.</p>${cardsSection(data.keptCards, data.canOrder, false, true)}`
    : "";
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
      ${kept}
      ${next}
      ${integration}`,
    viewer,
    [],
    projectContext(project),
  );
}
