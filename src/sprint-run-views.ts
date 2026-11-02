import { cardRef } from "./card-views";
import type { Project } from "./projects";
import { runLanes, type PlannedCard, type RunCard, type RunState } from "./sprint-run";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, type Viewer } from "./views";

// The sprint running by itself (la-fabrique#160): what it will do, in its
// card on the sprint page, then where each card is.

const PLAN_LABELS: Record<PlannedCard["stories"][number]["plan"], string> = {
  done: "Merged already",
  merge: "Its pull request is merged first",
  launch: "Claude, then merge",
  stop: "The card stops here",
  after: "Waits behind",
};

// What the run will do, in its card (la-fabrique#188): the cards in lanes
// (as many as Claude runs may go at once), each with its stories waiting,
// in order, and where it would stop; one button to confirm. Nothing to
// choose: the order is the sprint's, set below.
function runPlan(viewer: Viewer, project: Project, plan: PlannedCard[], cap: number, again: boolean): string {
  const base = projectUrl(project.repo);
  const { lanes, idle } = runLanes(plan, cap);
  const cardItem = (planned: PlannedCard) => {
    const waiting = planned.stories.filter((story) => story.plan !== "done");
    const merged = planned.stories.length - waiting.length;
    return `<li class="run-plan-card">
        <p><a class="mono" href="${escapeHtml(base)}/cards/${planned.card.id}">${cardRef(planned.card.id)}</a> <strong>${escapeHtml(planned.card.title)}</strong>${merged ? ` <span class="muted small">${merged} merged already</span>` : ""}</p>
        <ol class="run-plan-stories">${waiting
          .map(
            (story) =>
              `<li class="run-plan-${story.plan}"><span class="mono">#${story.number}</span> ${escapeHtml(story.title)}${story.nice ? ` <span class="pill kind small">Nice to have</span>` : ""} <span class="${story.plan === "stop" ? "alert-text" : "muted"} small">${PLAN_LABELS[story.plan]}${story.why ? `: ${escapeHtml(story.why)}` : ""}</span></li>`,
          )
          .join("")}</ol>
      </li>`;
  };
  const lanesHtml = lanes
    .map((lane, index) => `<section class="run-lane" aria-label="Lane ${index + 1}"><h4>Lane ${index + 1}</h4><ol class="run-plan">${lane.map(cardItem).join("")}</ol></section>`)
    .join("");
  const idleHtml = idle.length
    ? `<p class="muted small">Not in the run: ${idle.map(({ planned, why }) => `<a class="mono" href="${escapeHtml(base)}/cards/${planned.card.id}">${cardRef(planned.card.id)}</a> ${escapeHtml(why)}`).join(" · ")}</p>`
    : "";
  if (!lanes.length) return `<p class="muted">Nothing to run: every story is merged, or each card stops at its first story.</p>${idleHtml}`;
  return `<p class="muted small">Up to testing: in each lane, the cards one after another, and each card's stories one after another (Claude, then the merge of its pull request); ${lanes.length > 1 ? `${lanes.length} lanes side by side` : "one lane"}, at most ${cap} Claude run${cap === 1 ? "" : "s"} at once, one merge at a time. A card that meets a problem stops and says why; the others go on. Nothing is validated, released or closed by the run.</p>
    <div class="run-lanes">${lanesHtml}</div>
    ${idleHtml}
    <form method="post" action="${escapeHtml(base)}/sprint" class="actions" data-busy="Starting…">${csrfField(viewer)}
      <input type="hidden" name="action" value="run_start" />
      <button type="submit" class="button">${again ? "Run it again" : "Run the sprint"}</button>
    </form>`;
}

const STEP_LABELS: Record<RunCard["step"], string> = {
  next: "Next story",
  claude: "Claude working",
  updating: "Claude updating its pull request",
  merging: "Merging",
  done: "Done",
  stopped: "Stopped",
};

const STATUS_LABELS: Record<RunState["status"], string> = {
  running: "The sprint is running by itself",
  paused: "The run is paused: what was in progress finishes, nothing new starts",
  stopped: "The run was stopped",
  done: "The run is over: every card's stories are merged",
  waiting: "The run waits for a person: a card stopped",
};

export function runSection(viewer: Viewer, project: Project, state: RunState | null, canRun: boolean, refusal: string | null, plan: PlannedCard[] = [], cap = 1): string {
  const base = projectUrl(project.repo);
  const control = (action: string, label: string, extra: Record<string, string | number> = {}, kind = "quiet small") =>
    `<form method="post" action="${escapeHtml(base)}/sprint" class="inline" data-busy="…">${csrfField(viewer)}<input type="hidden" name="action" value="${action}" />${Object.entries(extra)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("")}<button type="submit" class="button ${kind}">${label}</button></form>`;
  const active = Boolean(state) && (state?.status === "running" || state?.status === "paused" || state?.status === "waiting");
  // Not running: what it would do, to confirm (la-fabrique#188).
  const proposal = canRun && !active ? (refusal ? `<p><span class="muted small">${escapeHtml(refusal)}</span></p>` : runPlan(viewer, project, plan, cap, Boolean(state))) : "";
  if (!state) {
    return canRun ? `<div class="sprint-run-start" id="sprint-run"><h3>Running by itself</h3>${proposal}</div>` : "";
  }
  const controls = canRun
    ? [
        state.status === "running" ? control("run_pause", "Pause") : "",
        state.status === "paused" || state.status === "waiting" ? control("run_resume", "Resume") : "",
        active ? control("run_stop", "Stop") : "",
      ].join(" ")
    : "";
  const cards = state.cards
    .map((card) => {
      const story = card.stories[card.at];
      const tone = card.step === "done" ? "ok" : card.step === "stopped" ? "alert" : "warn";
      return `<li id="run-card-${card.id}"><a class="mono" href="${escapeHtml(base)}/cards/${card.id}">${cardRef(card.id)}</a> ${escapeHtml(card.title)}
        <span class="pill ${tone} small">${STEP_LABELS[card.step]}</span>${
          story !== undefined && card.step !== "done" ? ` <a class="mono small" href="${escapeHtml(base)}/sprint/stories/${story}">#${story}</a>` : ""
        } <span class="muted small">${Math.min(card.at, card.stories.length)}/${card.stories.length} merged</span>${card.pull && card.step === "merging" ? ` <span class="small">pull request #${card.pull}</span>` : ""}${
          card.reason ? `<br /><span class="small">${escapeHtml(card.reason)}${card.link ? ` <a href="${escapeHtml(card.link)}">See it</a>` : ""}</span>` : ""
        }${card.note ? `<br /><span class="muted small">${escapeHtml(card.note)}</span>` : ""}${
          card.step === "stopped" && canRun && state.status !== "stopped" && state.status !== "done" ? ` ${control("run_resume_card", "Resume this card", { card: card.id })}` : ""
        }</li>`;
    })
    .join("");
  return `<div class="sprint-run" id="sprint-run">
      <h3>Running by itself</h3>
      <p><strong>${STATUS_LABELS[state.status]}</strong> <span class="muted small">started by @${escapeHtml(state.startedBy)} on ${escapeHtml(formatDate(state.startedAt))}</span> ${controls}</p>
      <ul class="sprint-run-cards">${cards}</ul>
      ${proposal ? `<div class="run-again"><h4>A new run</h4>${proposal}</div>` : ""}
    </div>`;
}
