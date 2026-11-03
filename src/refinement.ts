import { isNice, type StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";
import { cardRef, cardUrl, statusPill } from "./card-views";
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
  | { step: "ready" };

// Where a feature stands, from its spec and its stories.
export function nextStep(card: Pick<Card, "data">, stories: number[], known: Map<number, CardStory>): NextStep {
  const spec = card.data.spec;
  if (!spec) return { step: "specify" };
  if (spec.questions.length) return { step: "answer", questions: spec.questions.length };
  if (!stories.length) return { step: "refine" };
  const lacking = stories.filter((number) => known.get(number)?.stage === "backlog");
  return lacking.length ? { step: "validate", stories: lacking } : { step: "ready" };
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
  notice?: string | undefined;
  failure?: string | undefined;
}

// The cards of Next release, features first (in the board's order).
export function refinementCards(cards: Card[], release: string): { features: Card[]; others: Card[] } {
  const live = cards
    .filter((card) => !card.archivedAt && card.release === release && card.status !== "dropped")
    .sort((a, b) => a.position - b.position || a.id - b.id);
  return { features: live.filter((card) => card.kind === "feature"), others: live.filter((card) => card.kind !== "feature") };
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
      case "ready":
        return `<span class="pill ok">Ready for the sprint</span>`;
    }
  };

  const feature = (card: Card) => {
    const numbers = data.links.order.get(card.id) ?? [];
    const next = nextStep(card, numbers, data.stories);
    return `<article class="card refinement-card" id="card-${card.id}">
      <h3><a href="${escapeHtml(cardUrl(project.repo, card.id))}"><span class="mono">${cardRef(card.id)}</span> ${escapeHtml(card.title)}</a> ${statusPill(card)}</h3>
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
      ${data.features.length ? data.features.map(feature).join("") : `<p class="muted">No feature in Next release.</p>`}
      ${apart}`,
    viewer,
    [],
    projectContext(project, false),
  );
}
