import { shownStatus, shownStatusLabel, type Card } from "./cards";
import { escapeHtml } from "./views";

// A warning, never a block (la-fabrique#299): a feature that goes ahead
// before what it depends on. A feature is available when it is In
// production with its mandatory stories (the shown status ignores the nice
// to have ones); an epic when all its features that are not dropped are.

// The kinds of card_links of card-dependencies.ts, repeated to keep imports one way.
const DEPENDS = "depends";
const DEPENDS_EPIC = "depends_epic";
const cardRef = (id: number) => `C${id}`;

export interface DependencyWarning {
  // "C74" or "epic Payments".
  name: string;
  card?: number;
  state: string;
}

export interface DependencyLink {
  card_id: number;
  kind: string;
  ref: string;
}

export const isAvailable = (card: Card): boolean => shownStatus(card) === "in_production";

// The warnings of one feature. With `sameRelease`, a dependency planned in
// the same release as the feature is not warned about (Refinement).
export function dependencyWarnings(card: Card, cards: Card[], links: DependencyLink[], options: { sameRelease?: boolean } = {}): DependencyWarning[] {
  const byId = new Map(cards.map((candidate) => [candidate.id, candidate]));
  const inRelease = (other: Card) => Boolean(options.sameRelease && card.release && other.release === card.release);
  const out: DependencyWarning[] = [];
  for (const link of links) {
    if (link.card_id !== card.id) continue;
    if (link.kind === DEPENDS) {
      const other = byId.get(Number(link.ref));
      if (other && !other.archivedAt && !isAvailable(other) && !inRelease(other)) out.push({ name: cardRef(other.id), card: other.id, state: shownStatusLabel(shownStatus(other)) });
    } else if (link.kind === DEPENDS_EPIC) {
      const features = cards.filter((other) => other.epic === link.ref && !other.archivedAt && other.status !== "dropped");
      const missing = features.filter((other) => !isAvailable(other) && !inRelease(other));
      if (missing.length) {
        const done = features.filter(isAvailable).length;
        out.push({ name: `epic ${link.ref}`, state: `${done} of ${features.length} features in production` });
      }
    }
  }
  return out;
}

export function warningsHtml(warnings: DependencyWarning[], href?: (w: DependencyWarning) => string | null): string {
  if (!warnings.length) return "";
  return `<ul class="plain dependency-warnings">${warnings
    .map((w) => {
      const to = href?.(w);
      const name = to ? `<a href="${escapeHtml(to)}">${escapeHtml(w.name)}</a>` : escapeHtml(w.name);
      return `<li><span class="pill warn">Warning</span> Depends on ${name}, not available yet: ${escapeHtml(w.state)}.</li>`;
    })
    .join("")}</ul>`;
}
