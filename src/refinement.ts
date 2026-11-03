import { isNice, type StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";
import { cardRef, cardUrl, statusPill } from "./card-views";
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
  features: Card[];
  others: Card[];
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

  const step = (card: Card, next: NextStep) => {
    const url = cardUrl(project.repo, card.id);
    const claude = (action: string, text: string) =>
      data.canClaude ? form(url, { action }, text, `${text}: ${card.title}`) : `<a class="button quiet small" href="${escapeHtml(url)}">${text}</a>`;
    switch (next.step) {
      case "specify":
        return `<strong>Next:</strong> no spec. ${claude("spec_draft", "Specify")}`;
      case "answer":
        return `<strong>Next:</strong> ${next.questions} question${next.questions === 1 ? "" : "s"} waiting. <a class="button quiet small" href="${escapeHtml(url)}#spec">Answer (${next.questions})</a>`;
      case "refine":
        return `<strong>Next:</strong> spec complete, no stories. ${claude("spec_split", "Refine")}`;
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
    </section>`;
  const sortUrl = `${base}/refinement`;
  const hidden = (fields: Record<string, string | number>) =>
    Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}" />`)
      .join("");
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

  const feature = (card: Card, index: number, total: number) => {
    const numbers = data.links.order.get(card.id) ?? [];
    const next = nextStep(card, numbers, data.stories);
    const sortable = data.canWrite && total > 1;
    return `<article class="card refinement-card" id="card-${card.id}"${sortable ? ` data-sort-id="${card.id}"` : ""}>
      ${sortable ? `<button type="button" class="sort-handle" data-sort-handle aria-label="Move ${cardRef(card.id)}: drag it, or use the up and down arrow keys" title="Drag to reorder">⠿</button>` : ""}
      <h3><a href="${escapeHtml(cardUrl(project.repo, card.id))}"><span class="mono">${cardRef(card.id)}</span> ${escapeHtml(card.title)}</a> ${statusPill(card)}</h3>
      <p>${priority(card)} ${order(card, index, total)}</p>
      <p class="muted">${escapeHtml(synopsisOf(card))}</p>
      ${numbers.length ? `<ul class="plain">${numbers.map((number) => story(card, number)).join("")}</ul>` : `<p class="muted small">No story yet.</p>`}
      <p>${step(card, next)}</p>
    </article>`;
  };

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
      <p class="muted">The features of <a href="${escapeHtml(base)}/board?by=release">Next release</a>, in priority order, and what each needs before the <a href="${escapeHtml(base)}/sprint">sprint</a>. Nothing is read from GitHub here: the stories are as La Fabrique last saw them.</p>
      ${summary}
      ${data.features.length ? `<div class="refinement-cards"${data.canWrite && data.features.length > 1 ? ` data-sortable="card_order" data-sort-url="${escapeHtml(sortUrl)}" data-csrf="${escapeHtml(viewer.csrfToken)}"` : ""}>${data.features.map((card, index) => feature(card, index, data.features.length)).join("")}</div>` : `<p class="muted">No feature in Next release.</p>`}
      ${apart}`,
    viewer,
    [],
    projectContext(project, false),
  );
}
