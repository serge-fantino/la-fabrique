import { shownStatus, shownStatusLabel, SHOWN_STATUSES, type Card, type ShownStatus } from "./cards";
import { cardRef, cardUrl } from "./card-views";
import { escapeHtml } from "./views";

// An epic's progress (la-fabrique#303): read from its own features, never
// typed, counted in features only (no story), with the words of a feature's
// status. A feature belongs to the epic through its `epic` tag, which names
// the epic card's title. Dropped features do not count; archived ones are
// listed apart.

export type EpicStatus = "draft" | "ready" | "in_production";
export const EPIC_STATUS_LABELS: Record<EpicStatus, string> = { draft: "Draft", ready: "Ready", in_production: "In production" };

export interface EpicProgress {
  features: Card[];
  archived: Card[];
  // One part per status present, in the features' order.
  parts: { status: ShownStatus; label: string; count: number }[];
  inProduction: number;
  status: EpicStatus | null;
}

const SPEC_STATUSES: readonly ShownStatus[] = ["draft", "shaping", "to_validate", "validated"];

export function epicFeatures(epic: Pick<Card, "id" | "title">, cards: Card[]): Card[] {
  const name = epic.title.trim().toLowerCase();
  return cards.filter((card) => card.id !== epic.id && card.kind === "feature" && (card.epic ?? "").trim().toLowerCase() === name);
}

export function epicProgress(epic: Pick<Card, "id" | "title">, cards: Card[]): EpicProgress {
  const own = epicFeatures(epic, cards).filter((card) => card.status !== "dropped");
  const features = own.filter((card) => !card.archivedAt);
  const archived = own.filter((card) => card.archivedAt);
  const parts = SHOWN_STATUSES.map((status) => ({ status, label: shownStatusLabel(status), count: features.filter((card) => shownStatus(card) === status).length })).filter(
    (part) => part.count > 0,
  );
  const inProduction = features.filter((card) => shownStatus(card) === "in_production").length;
  let status: EpicStatus | null = null;
  if (features.length) {
    if (features.some((card) => SPEC_STATUSES.includes(shownStatus(card)))) status = "draft";
    else status = inProduction === features.length ? "in_production" : "ready";
  }
  return { features, archived, parts, inProduction, status };
}

const featureLine = (card: Card) =>
  `<li><a href="${escapeHtml(cardUrl(card.repo, card.id))}"><span class="mono">${cardRef(card.id)}</span> ${escapeHtml(card.title)}</a> <span class="pill small">${escapeHtml(shownStatusLabel(shownStatus(card)))}</span></li>`;

export function epicProgressSection(progress: EpicProgress): string {
  const total = progress.features.length;
  if (!total) {
    return `<section class="epic-progress" id="epic-progress"><h2>Progress</h2><p class="muted">No features yet</p>${archivedList(progress)}</section>`;
  }
  const bar = progress.parts
    .map((part) => {
      const tip = `${part.label}: ${part.count} ${part.count === 1 ? "feature" : "features"}`;
      return `<span class="epic-part" tabindex="0" role="img" style="flex:${part.count}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">${part.label} <span class="mono">${part.count}</span></span>`;
    })
    .join("");
  return `<section class="epic-progress" id="epic-progress"><h2>Progress</h2>
    <p>Epic status: <span class="pill">${EPIC_STATUS_LABELS[progress.status ?? "draft"]}</span> · <span class="mono">${progress.inProduction}/${total}</span> features in production</p>
    <div class="epic-bar">${bar}</div>
    <ul class="plain">${progress.features.map(featureLine).join("")}</ul>${archivedList(progress)}</section>`;
}

function archivedList(progress: EpicProgress): string {
  return progress.archived.length ? `<h3>Archives</h3><ul class="plain">${progress.archived.map(featureLine).join("")}</ul>` : "";
}
