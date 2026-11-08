import { shownStatus, shownStatusLabel, SHOWN_STATUSES, type Card, type ShownStatus } from "./cards";
import { compareVersions } from "./card-releases";
import type { Progress } from "./progress-stages";
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
  // Once part of it has shipped (la-fabrique#304): the versions that shipped
  // its features, oldest first, and the features not yet in production.
  shipped?: { versions: string[]; left: Card[] };
}

const SPEC_STATUSES: readonly ShownStatus[] = ["draft", "shaping", "to_validate", "validated"];

export function epicFeatures(epic: Pick<Card, "id" | "title">, cards: Card[]): Card[] {
  const name = epic.title.trim().toLowerCase();
  return cards.filter((card) => card.id !== epic.id && card.kind === "feature" && (card.epic ?? "").trim().toLowerCase() === name);
}

export function epicProgress(epic: Pick<Card, "id" | "title">, cards: Card[], progresses?: Map<number, Progress>): EpicProgress {
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
  const out = features.filter((card) => progresses?.get(card.id)?.shipped);
  const shipped = out.length
    ? {
        versions: [...new Set(out.flatMap((card) => progresses?.get(card.id)?.shipped?.versions ?? []))].sort((a, b) => compareVersions(b, a)),
        left: features.filter((card) => shownStatus(card) !== "in_production"),
      }
    : undefined;
  return { features, archived, parts, inProduction, status, ...(shipped ? { shipped } : {}) };
}

const featureLine = (card: Card) =>
  `<li><a href="${escapeHtml(cardUrl(card.repo, card.id))}"><span class="mono">${cardRef(card.id)}</span> ${escapeHtml(card.title)}</a> <span class="pill small">${escapeHtml(shownStatusLabel(shownStatus(card)))}</span></li>`;

export function epicProgressSection(progress: EpicProgress): string {
  const total = progress.features.length;
  if (!total) {
    return `<section class="epic-progress" id="epic-progress"><h2>Progress</h2><p class="muted">No features yet</p>${archivedList(progress)}</section>`;
  }
  return `<section class="epic-progress" id="epic-progress"><h2>Progress</h2>
    ${epicProgressSummary(progress)}
    <ul class="plain">${progress.features.map(featureLine).join("")}</ul>${shippedBlock(progress)}${archivedList(progress)}</section>`;
}

// The bar, the counts and the status, the same on the epic's page, in its row
// of the Epics tab and in its lane header on the board (la-fabrique#305).
export function epicProgressSummary(progress: EpicProgress, compact = false): string {
  const total = progress.features.length;
  if (!total) return `<span class="muted small">No features yet</span>`;
  const bar = progress.parts
    .map((part) => {
      const tip = `${part.label}: ${part.count} ${part.count === 1 ? "feature" : "features"}`;
      return `<span class="epic-part" tabindex="0" role="img" style="flex:${part.count}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">${part.label} <span class="mono">${part.count}</span></span>`;
    })
    .join("");
  const line = `<${compact ? "span" : "p"} class="epic-line">Epic status: <span class="pill">${EPIC_STATUS_LABELS[progress.status ?? "draft"]}</span> · <span class="mono">${progress.inProduction}/${total}</span> features in production</${compact ? "span" : "p"}>`;
  return `${line}<div class="epic-bar${compact ? " compact" : ""}">${bar}</div>`;
}

function archivedList(progress: EpicProgress): string {
  return progress.archived.length ? `<h3>Archives</h3><ul class="plain">${progress.archived.map(featureLine).join("")}</ul>` : "";
}

function shippedBlock(progress: EpicProgress): string {
  const shipped = progress.shipped;
  if (!shipped) return "";
  const versions = shipped.versions.length
    ? `Shipped in ${shipped.versions.map((version) => `<span class="mono">${escapeHtml(version)}</span>`).join(", ")}`
    : "Part of it is in production";
  const left = shipped.left.length
    ? `<h3>Still to come</h3><ul class="plain">${shipped.left.map(featureLine).join("")}</ul>`
    : `<p class="muted">Nothing left: every feature is in production.</p>`;
  return `<p class="epic-shipped">${versions}</p>${left}`;
}
