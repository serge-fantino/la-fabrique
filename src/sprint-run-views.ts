import { cardRef } from "./card-views";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { PlannedCard, RunCard, RunState } from "./sprint-run";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

// The sprint running by itself (la-fabrique#160): what it will do, then
// where each card is.

const PLAN_LABELS: Record<PlannedCard["stories"][number]["plan"], string> = {
  done: "Merged already",
  merge: "Its pull request is merged first",
  launch: "Claude, then merge",
  stop: "The card stops here",
  after: "Waits behind",
};

export function runPreviewPage(viewer: Viewer, project: Project, plan: PlannedCard[], refusal: string | null): string {
  const base = projectUrl(project.repo);
  const cards = plan.filter((planned) => planned.stories.length);
  const rows = cards
    .map(
      (planned) => `<li class="run-plan-card">
        <p><a class="mono" href="${escapeHtml(base)}/cards/${planned.card.id}">${cardRef(planned.card.id)}</a> <strong>${escapeHtml(planned.card.title)}</strong></p>
        <ol>${planned.stories
          .map(
            (story) =>
              `<li class="run-plan-${story.plan}"><span class="mono">#${story.number}</span> ${escapeHtml(story.title)}${story.nice ? ` <span class="pill kind small">Nice to have</span>` : ""} — <span class="${story.plan === "stop" ? "alert-text" : "muted"} small">${PLAN_LABELS[story.plan]}${story.why ? `: ${escapeHtml(story.why)}` : ""}</span></li>`,
          )
          .join("")}</ol>
      </li>`,
    )
    .join("");
  const startable = !refusal && cards.some((planned) => planned.stories.some((story) => story.plan === "launch" || story.plan === "merge"));
  return layout(
    `Run the sprint · La Fabrique extraordinaire`,
    `${projectHeader(project, "sprint", "Run the sprint")}
      <p class="crumbs"><a href="${escapeHtml(base)}/sprint">Sprint</a> <span aria-hidden="true">›</span> Run</p>
      <p class="lead">The sprint runs by itself, up to testing: each card's stories one after another (Claude, then the merge of its pull request), the cards side by side, never more Claude runs than the project allows, one merge at a time. A card that meets a problem stops and says why; the others go on. Nothing is validated, released or closed by the run.</p>
      ${refusal ? notice(refusal, "error") : ""}
      ${cards.length ? `<ol class="run-plan">${rows}</ol>` : `<p class="muted">No card in the sprint.</p>`}
      ${
        startable
          ? `<form method="post" action="${escapeHtml(base)}/sprint" class="actions" data-busy="Starting…">${csrfField(viewer)}
          <input type="hidden" name="action" value="run_start" />
          <button type="submit" class="button">Run the sprint</button>
          <a class="button quiet" href="${escapeHtml(base)}/sprint">Back</a>
        </form>`
          : `<p class="muted">Nothing to run${refusal ? "" : ": every story is merged, or each card stops at its first story"}.</p>`
      }`,
    viewer,
    [],
    projectContext(project, false),
  );
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

export function runSection(viewer: Viewer, project: Project, state: RunState | null, canRun: boolean, refusal: string | null): string {
  const base = projectUrl(project.repo);
  const control = (action: string, label: string, extra: Record<string, string | number> = {}, kind = "quiet small") =>
    `<form method="post" action="${escapeHtml(base)}/sprint" class="inline" data-busy="…">${csrfField(viewer)}<input type="hidden" name="action" value="${action}" />${Object.entries(extra)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("")}<button type="submit" class="button ${kind}">${label}</button></form>`;
  const startLink = canRun && !refusal ? ` <a class="button small" href="${escapeHtml(base)}/sprint/run">${state ? "Run it again" : "Run the sprint"}</a>` : "";
  if (!state) {
    return canRun ? `<div class="sprint-run-start"><h3>Running by itself</h3><p>${refusal ? `<span class="muted small">${escapeHtml(refusal)}</span>` : `The sprint can run by itself, up to testing.${startLink}`}</p></div>` : "";
  }
  const active = state.status === "running" || state.status === "paused" || state.status === "waiting";
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
  return `<div class="sprint-run">
      <h3>Running by itself</h3>
      <p><strong>${STATUS_LABELS[state.status]}</strong> <span class="muted small">started by @${escapeHtml(state.startedBy)} on ${escapeHtml(formatDate(state.startedAt))}</span> ${controls}${active ? "" : startLink}</p>
      <ul class="sprint-run-cards">${cards}</ul>
    </div>`;
}
