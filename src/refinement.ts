import { isNice, type StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";
import { EDITOR_DEFAULT_BUTTON, storyBlocks, type StoryEditorData } from "./story-editor";
import { cardRef, cardUrl, statusPill } from "./card-views";
import { jobLabel, type Job } from "./jobs";
import { formatUsd, type CallsLeft } from "./llm";
import { validationOf, type ValidationState } from "./feature-validation";
import { excerpt, KIND_LABELS, type Card } from "./cards";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, layout, type Viewer } from "./views";

// The Refinement tab (la-fabrique#223): the features of Next release, each
// with its next step toward the sprint. Read from what La Fabrique already
// keeps (cards, links, the stories' snapshot): showing it calls neither
// GitHub nor Claude.

export type NextStep =
  | { step: "specify" }
  | { step: "answer"; questions: number }
  | { step: "refine" }
  | { step: "validate"; stories: number[] }
  | { step: "approve"; validation: ValidationState }
  | { step: "ready" };

// Where a feature stands, from its spec and its stories.
export function nextStep(card: Pick<Card, "title" | "body" | "data">, stories: number[], known: Map<number, CardStory>): NextStep {
  const spec = card.data.spec;
  if (!spec) return { step: "specify" };
  if (spec.questions.length) return { step: "answer", questions: spec.questions.length };
  if (!stories.length) return { step: "refine" };
  const lacking = stories.filter((number) => known.get(number)?.stage === "backlog");
  if (lacking.length) return { step: "validate", stories: lacking };
  // The last step (la-fabrique#232): a person says the feature is right.
  const validation = validationOf(card, stories);
  return validation.state === "valid" ? { step: "ready" } : { step: "approve", validation };
}

// The first lines of the text, or of the spec once there is one.
export function synopsisOf(card: Pick<Card, "body" | "data">): string {
  const spec = card.data.spec;
  const first = spec ? Object.values(spec.answers).find((text) => text.trim()) : undefined;
  return excerpt(first ?? card.body, 240);
}

export interface RefinementData {
  // The latest job of each card, with its place when it waits (la-fabrique#226).
  jobs?: Map<number, { job: Job; place: number | null }>;
  calls?: CallsLeft | null;
  features: Card[];
  others: Card[];
  // The stories Claude proposed for a feature, in the same editor as the
  // card's stories page (la-fabrique#228).
  editors?: Map<number, Omit<StoryEditorData, "repo" | "errors">>;
  links: StoryCards;
  stories: Map<number, CardStory>;
  canWrite: boolean;
  readyLabel: string | null;
  canClaude: boolean;
  priorities: string[];
  sprint?: { label: string } | null;
  notice?: string | undefined;
  failure?: string | undefined;
}

// How far Next release is prepared (la-fabrique#225).
export interface ReleaseProgress {
  features: number;
  specified: number;
  refined: number;
  ready: number;
  needed: number;
  nice: number;
  blockers: { card: Card; reason: string }[];
}

export function releaseProgress(features: Card[], links: StoryCards, known: Map<number, CardStory>): ReleaseProgress {
  const out: ReleaseProgress = { features: features.length, specified: 0, refined: 0, ready: 0, needed: 0, nice: 0, blockers: [] };
  for (const card of features) {
    const numbers = links.order.get(card.id) ?? [];
    for (const number of numbers) {
      if (isNice(links, card.id, number)) out.nice++;
      else out.needed++;
    }
    const next = nextStep(card, numbers, known);
    if (next.step !== "specify" && next.step !== "answer") out.specified++;
    if (next.step === "validate" || next.step === "approve" || next.step === "ready") out.refined++;
    if (next.step === "ready") {
      out.ready++;
      continue;
    }
    const reason =
      next.step === "specify" ? "no spec"
      : next.step === "answer" ? `${next.questions} question${next.questions === 1 ? "" : "s"} waiting`
      : next.step === "refine" ? "spec complete, no stories"
      : next.step === "approve" ? (next.validation.state === "outdated" ? `to validate again: ${next.validation.why.join(", ")}` : "not validated")
      : `${next.stories.length} stor${next.stories.length === 1 ? "y" : "ies"} not ready`;
    out.blockers.push({ card, reason });
  }
  return out;
}

// The cards of Next release, features first (in the board's order).
export function refinementCards(cards: Card[], release: string): { features: Card[]; others: Card[] } {
  const live = cards
    .filter((card) => !card.archivedAt && card.release === release && card.status !== "dropped")
    .sort((a, b) => a.position - b.position || a.id - b.id);
  return { features: live.filter((card) => card.kind === "feature"), others: live.filter((card) => card.kind !== "feature") };
}

// The whole order of a release's cards once its features are in `wanted`
// order: they take the places the features had, the other cards keep theirs.
// Null when `wanted` is not exactly the features.
export function withFeatureOrder(all: number[], features: number[], wanted: number[]): number[] | null {
  if (wanted.length !== features.length || new Set(wanted).size !== wanted.length || !wanted.every((id) => features.includes(id))) return null;
  let next = 0;
  return all.map((id) => (features.includes(id) ? (wanted[next++] as number) : id));
}

export function refinementPage(viewer: Viewer, project: Project, data: RefinementData): string {
  const base = projectUrl(project.repo);
  const form = (url: string, fields: Record<string, string | number>, text: string, aria: string) =>
    `<form method="post" action="${escapeHtml(url)}" class="inline" data-busy="…">${csrfField(viewer)}${Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("")}<button type="submit" class="button quiet small" aria-label="${escapeHtml(aria)}">${text}</button></form>`;

  const hidden = (fields: Record<string, string | number>) =>
    Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("");

  const story = (card: Card, number: number) => {
    const known = data.stories.get(number);
    const nice = isNice(data.links, card.id, number);
    const missing = known?.stage === "backlog" ? known.missing : [];
    const fixes =
      data.canWrite && missing.includes("not labelled ready") && data.readyLabel
        ? form(`${base}/refinement`, { action: "story_ready", story: number }, "Mark ready", `Mark #${number} ready`)
        : "";
    const stage = known ? (known.closed ? "Closed" : known.stage === "backlog" ? "Not ready" : (known.stage ?? "").replace("_", " ")) : "Not read yet";
    return `<li id="story-${card.id}-${number}"><a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a> ${escapeHtml(known?.title ?? "")}${nice ? ' <span class="pill small">Nice to have</span>' : ""}
      <span class="muted small">${escapeHtml(stage)}${missing.length ? ` (${escapeHtml(missing.join(", "))})` : ""}</span> ${fixes}</li>`;
  };

  // What Claude does on a card: its place in the line, working, or why it failed.
  const jobState = (card: Card) => {
    const entry = data.jobs?.get(card.id);
    const job = entry?.job;
    const shown = job && (job.status === "waiting" || job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "cancelled") ? job : null;
    const cancellable = shown && (shown.status === "waiting" || (shown.status === "queued" && shown.attempts === 0));
    const body = shown
      ? `<span class="claude-job-dot" aria-hidden="true"></span> <strong data-job-label>${escapeHtml(jobLabel(shown, entry?.place))}</strong>${
          cancellable && data.canClaude ? " " + form(`${base}/refinement`, { action: "job_cancel", card: card.id }, "Cancel", `Cancel the job on ${cardRef(card.id)}`) : ""
        }${
          shown.status === "failed" && data.canClaude ? " " + form(`${base}/refinement`, { action: "job_retry", card: card.id }, "Try again", `Try the job again on ${cardRef(card.id)}`) : ""
        }`
      : "";
    return `<p class="job-state${shown?.status === "failed" ? " failed" : ""}" data-job-state="${card.id}" aria-live="polite"${shown ? "" : " hidden"}>${body}</p>`;
  };
  const active = (card: Card) => {
    const job = data.jobs?.get(card.id)?.job;
    return Boolean(job && (job.status === "waiting" || job.status === "queued" || job.status === "running"));
  };

  // Claude's questions, each with its own field, answered here as on the card's page.
  const questions = (card: Card) => {
    const list = card.data.spec?.questions ?? [];
    const url = cardUrl(project.repo, card.id);
    const head = `<strong>Next:</strong> ${list.length} question${list.length === 1 ? "" : "s"} waiting.`;
    if (!data.canClaude) return `${head} <a class="button quiet small" href="${escapeHtml(url)}#spec">Answer (${list.length})</a>`;
    if (active(card)) return `${head} <span class="muted small">Claude has it.</span>`;
    const fields = list
      .map(
        (question, index) => `<div class="field">
          <label for="answer-${card.id}-${index}">${escapeHtml(question)}</label>
          <input type="hidden" name="question_${index}" value="${escapeHtml(question)}" />
          <textarea id="answer-${card.id}-${index}" name="answer_${index}" rows="2" maxlength="2000" data-keep></textarea>
        </div>`,
      )
      .join("");
    return `${head}
      <form method="post" action="${escapeHtml(base)}/refinement#card-${card.id}" class="spec-questions" data-busy="Sending…">${csrfField(viewer)}${hidden({ card: card.id })}
        <h4>Claude asks</h4>
        ${fields}
        <div class="field">
          <label for="answer-${card.id}-more">Anything else? <span class="muted">(optional)</span></label>
          <textarea id="answer-${card.id}-more" name="instruction" rows="2" maxlength="4000" data-keep></textarea>
        </div>
        <div class="card-actions">
          <button type="submit" class="button claude small" name="action" value="spec_answer">Send my answers to Claude</button>
          <button type="submit" class="button quiet small" name="action" value="spec_enough" formnovalidate>Enough questions</button>
        </div>
      </form>`;
  };

  const step = (card: Card, next: NextStep) => {
    const url = cardUrl(project.repo, card.id);
    if (active(card) && (next.step === "specify" || next.step === "refine")) return `<strong>Next:</strong> ${next.step === "specify" ? "no spec" : "spec complete, no stories"}. <span class="muted small">Claude has it.</span>`;
    const claude = (action: string, text: string) =>
      data.canClaude ? form(url, { action }, text, `${text}: ${card.title}`) : `<a class="button quiet small" href="${escapeHtml(url)}">${text}</a>`;
    switch (next.step) {
      case "specify":
        return `<strong>Next:</strong> no spec. ${claude("spec_draft", "Specify")}`;
      case "answer":
        return questions(card);
      case "refine": {
        const editor = data.editors?.get(card.id);
        if (editor && data.canWrite) {
          return `<strong>Next:</strong> Claude proposed ${editor.split.stories.length} stor${editor.split.stories.length === 1 ? "y" : "ies"}: review them.
            <form method="post" action="${escapeHtml(url)}/stories" class="request-form split-form" data-busy="Sending…">${csrfField(viewer)}${EDITOR_DEFAULT_BUTTON}
              ${storyBlocks({ ...editor, repo: project.repo, errors: {}, prefix: `r${card.id}-` })}
              <div class="card-actions">
                <button type="submit" class="button" name="action" value="create">Create the checked stories on GitHub</button>
                <button type="submit" class="button quiet" name="action" value="save">Save my edits</button>
              </div>
            </form>`;
        }
        return `<strong>Next:</strong> spec complete, no stories. ${claude("spec_split", "Then refine")}`;
      }
      case "validate":
        return `<strong>Next:</strong> <a class="button quiet small" href="${escapeHtml(url)}#stories">Validate</a> <span class="muted small">${next.stories.length} stor${next.stories.length === 1 ? "y" : "ies"} not ready</span>`;
      case "approve":
        return `<strong>Next:</strong> ${next.validation.state === "outdated" ? `<span class="muted small">Validated by @${escapeHtml(next.validation.by)}, but ${escapeHtml(next.validation.why.join(" and "))}.</span> ` : ""}${
          data.canWrite ? form(url, { action: "validate_feature", back: `${base}/refinement#card-${card.id}` }, "Validate the feature", `Validate ${cardRef(card.id)}`) : `<span class="muted small">Waiting for a Product Engineer to validate it.</span>`
        }`;
      case "ready": {
        const v = validationOf(card, data.links.order.get(card.id) ?? []);
        return `<span class="pill ok">Ready for the sprint</span>${v.state === "valid" ? ` <span class="muted small">Validated by @${escapeHtml(v.by)} on <span class="mono">${escapeHtml(v.at.slice(0, 10))}</span></span>` : ""}`;
      }
    }
  };

  const progress = releaseProgress(data.features, data.links, data.stories);
  const meter = (label: string, value: number, total: number, tip: string) =>
    `<div class="release-meter" tabindex="0" role="group" aria-label="${escapeHtml(`${label}: ${value} of ${total}. ${tip}`)}" title="${escapeHtml(tip)}"><span class="muted small">${label}</span> <span class="mono">${value}/${total}</span> <span class="bar"><span style="width:${total ? Math.round((value / total) * 100) : 0}%"></span></span></div>`;
  const go = progress.features > 0 && progress.blockers.length === 0;
  const verdict = data.sprint
    ? `<p><span class="pill">Sprint running</span> ${escapeHtml(data.sprint.label)} is in progress: <a href="${escapeHtml(base)}/sprint">go to the sprint</a>.</p>`
    : go
      ? `<p><span class="pill ok">GO</span> Every feature of Next release is ready. <a class="button" href="${escapeHtml(base)}/sprint#start-sprint">Start the sprint</a></p>`
      : `<p><span class="pill alert">NO-GO</span> ${progress.features ? "What blocks:" : "No feature in Next release."}</p>
        ${progress.blockers.length ? `<ul class="plain">${progress.blockers.map((b) => `<li><a href="#card-${b.card.id}"><span class="mono">${cardRef(b.card.id)}</span> ${escapeHtml(b.card.title)}</a>: ${escapeHtml(b.reason)}</li>`).join("")}</ul>` : ""}`;
  const summary = `<section class="card release-progress" id="release-progress" aria-label="Progress of the next release">
      <h2>Next release</h2>
      ${meter("Features", progress.features, progress.features, "The features in Next release")}
      ${meter("Specified", progress.specified, progress.features, "Features whose spec is complete: no question waiting")}
      ${meter("Refined", progress.refined, progress.features, "Features specified and with stories")}
      ${meter("Ready", progress.ready, progress.features, "Features whose every needed story meets the Definition of Ready")}
      <p class="release-stories" tabindex="0" title="Stories of these features: needed ones hold the release back, nice to have ones never do"><span class="mono">${progress.needed + progress.nice}</span> stories: <span class="mono">${progress.needed}</span> needed, <span class="mono">${progress.nice}</span> nice to have</p>
      ${verdict}
      <form method="get" action="${escapeHtml(base)}/refinement/preparation" class="inline preparation-form">
        <label>Level of detail <select name="level">
          <option value="1">1 · Features and their specs</option>
          <option value="2">2 · Plus their stories</option>
          <option value="3">3 · Plus their test cases</option>
        </select></label>
        <label>Format <select name="format"><option value="html">HTML (one file)</option><option value="pdf">PDF</option></select></label>
        <button type="submit" class="button quiet">Download the preparation document</button>
      </form>
    </section>`;
  const sortUrl = `${base}/refinement`;
  const priority = (card: Card) =>
    data.priorities.length
      ? data.canWrite
        ? `<form method="post" action="${escapeHtml(sortUrl)}" class="priority-form inline">${csrfField(viewer)}${hidden({ action: "card_priority", card: card.id })}<span class="muted small">Priority, for the card and its stories</span> <select name="priority" aria-label="Priority of ${cardRef(card.id)} and its stories" data-autosubmit>${[...data.priorities, ""]
            .map((value) => `<option value="${escapeHtml(value)}"${(card.priority ?? "") === value ? " selected" : ""}>${value ? escapeHtml(value) : "No priority"}</option>`)
            .join("")}</select><button type="submit" class="button quiet small" data-autosubmit-button>Set</button></form>`
        : card.priority
          ? `<span class="pill">${escapeHtml(card.priority)}</span>`
          : ""
      : "";
  const order = (card: Card, index: number, total: number) => {
    if (!data.canWrite || total < 2) return "";
    const arrow = (action: string, text: string, label: string) =>
      `<form method="post" action="${escapeHtml(sortUrl)}" class="inline sprint-order" data-busy="…">${csrfField(viewer)}${hidden({ action, card: card.id })}<button type="submit" class="button quiet small" aria-label="${label}">${text}</button></form>`;
    return `<span class="sprint-controls">${index > 0 ? arrow("card_up", "↑", `Move ${cardRef(card.id)} up`) : ""}${index < total - 1 ? arrow("card_down", "↓", `Move ${cardRef(card.id)} down`) : ""}</span>`;
  };

  const tickable = (card: Card, next: NextStep) => data.canClaude && !active(card) && (next.step === "specify" || next.step === "refine");

  const feature = (card: Card, index: number, total: number) => {
    const numbers = data.links.order.get(card.id) ?? [];
    const next = nextStep(card, numbers, data.stories);
    const sortable = data.canWrite && total > 1;
    return `<article class="card refinement-card" id="card-${card.id}"${sortable ? ` data-sort-id="${card.id}"` : ""}>
      ${sortable ? `<button type="button" class="sort-handle" data-sort-handle aria-label="Move ${cardRef(card.id)}: drag it, or use the up and down arrow keys" title="Drag to reorder">⠿</button>` : ""}
      <h3>${tickable(card, next) ? `<input type="checkbox" form="refine-launch" name="card" value="${card.id}" data-refine-tick aria-label="Select ${cardRef(card.id)} for Claude's next step" /> ` : ""}<a href="${escapeHtml(cardUrl(project.repo, card.id))}"><span class="mono">${cardRef(card.id)}</span> ${escapeHtml(card.title)}</a> ${statusPill(card)}</h3>
      <p>${priority(card)} ${order(card, index, total)}</p>
      <p class="muted">${escapeHtml(synopsisOf(card))}</p>
      ${jobState(card)}
      ${numbers.length ? `<ul class="plain">${numbers.map((number) => story(card, number)).join("")}</ul>` : `<p class="muted small">No story yet.</p>`}
      <p>${step(card, next)}</p>
    </article>`;
  };

  const eligible = data.features.filter((card) => tickable(card, nextStep(card, data.links.order.get(card.id) ?? [], data.stories)));
  const calls = data.calls;
  const launch =
    data.canClaude && eligible.length
      ? `<form method="post" action="${escapeHtml(base)}/refinement" id="refine-launch" class="card refine-launch" data-busy="Launching…">${csrfField(viewer)}${hidden({ action: "refine_launch" })}
          <p><strong>Launch Claude on the ticked features</strong>: Specify for those without a spec, Refine for those with a complete spec and no stories. Each is one job; Claude takes ${2} at a time, the others wait their turn, in the order launched.</p>
          <p class="muted small" data-refine-count data-calls-left="${calls ? calls.left : 0}">${
            calls
              ? calls.reason
                ? escapeHtml(calls.reason)
                : `<span data-refine-selected>0 ticked</span>: one call each. You have <span class="mono">${calls.left}</span> of today's <span class="mono">${calls.daily}</span> calls left; this month's budget is <span class="mono">${escapeHtml(formatUsd(calls.budget.spent))}</span> of <span class="mono">${escapeHtml(formatUsd(calls.budget.limit))}</span>. Beyond that nothing is launched.`
              : ""
          }</p>
          <p><button type="submit" class="button claude"${calls?.reason ? " disabled data-reason" : ""}>Launch the next step</button></p>
        </form>`
      : "";
  const apart = data.others.length
    ? `<h2>Ideas and questions</h2>
      <ul class="plain">${data.others
        .map((card) => `<li><a href="${escapeHtml(cardUrl(project.repo, card.id))}"><span class="mono">${cardRef(card.id)}</span> ${escapeHtml(card.title)}</a> <span class="pill small">${KIND_LABELS[card.kind]}</span></li>`)
        .join("")}</ul>`
    : "";

  return layout(
    `Refinement · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "refinement")}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      <div data-refinement-live="${escapeHtml(base)}/refinement/live" hidden></div>
      <p class="muted">The features of <a href="${escapeHtml(base)}/board?by=release">Next release</a>, in priority order, and what each needs before the <a href="${escapeHtml(base)}/sprint">sprint</a>. Nothing is read from GitHub here: the stories are as La Fabrique last saw them.</p>
      ${summary}
      ${launch}
      ${data.features.length ? `<div class="refinement-cards"${data.canWrite && data.features.length > 1 ? ` data-sortable="card_order" data-sort-url="${escapeHtml(sortUrl)}" data-csrf="${escapeHtml(viewer.csrfToken)}"` : ""}>${data.features.map((card, index) => feature(card, index, data.features.length)).join("")}</div>` : `<p class="muted">No feature in Next release.</p>`}
      ${apart}`,
    viewer,
    [],
    projectContext(project, false),
  );
}
