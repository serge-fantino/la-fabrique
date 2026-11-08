import { shownStatus, shownStatusLabel, type Card } from "./cards";
import { epicFeatures } from "./epic-progress";
import { isAvailable, type DependencyLink } from "./dependency-warnings";
import { cardRef, cardUrl } from "./card-views";
import { escapeHtml } from "./views";

// An epic's dependencies (la-fabrique#300), read from its features' own:
// each feature with what it depends on and the status of it, features of
// other epics included; and the epics the epic depends on, from both kinds
// of link (a feature on a feature of another epic, a feature on a whole epic).

const DEPENDS = "depends";
const DEPENDS_EPIC = "depends_epic";

export interface FeatureDependency {
  // "C74" or "epic Payments".
  name: string;
  title?: string;
  card?: Card;
  // The epic of a feature dependency when it is another one, or the epic itself.
  epic: string | null;
  state: string;
  available: boolean;
}

export interface EpicDependencies {
  features: { feature: Card; dependsOn: FeatureDependency[] }[];
  // Titles of the other epics this one depends on, sorted.
  epics: string[];
}

const same = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export function epicDependencies(epic: Pick<Card, "id" | "title">, cards: Card[], links: DependencyLink[]): EpicDependencies {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const features = epicFeatures(epic, cards).filter((card) => !card.archivedAt && card.status !== "dropped");
  const epics = new Set<string>();
  const rows = features.map((feature) => {
    const dependsOn: FeatureDependency[] = [];
    for (const link of links) {
      if (link.card_id !== feature.id) continue;
      if (link.kind === DEPENDS) {
        const other = byId.get(Number(link.ref));
        if (!other || other.archivedAt) continue;
        const otherEpic = other.epic?.trim() || null;
        dependsOn.push({ name: cardRef(other.id), title: other.title, card: other, epic: otherEpic, state: shownStatusLabel(shownStatus(other)), available: isAvailable(other) });
        if (otherEpic && !same(otherEpic, epic.title)) epics.add(otherEpic);
      } else if (link.kind === DEPENDS_EPIC) {
        const members = cards.filter((other) => same(other.epic, link.ref) && !other.archivedAt && other.status !== "dropped");
        const done = members.filter(isAvailable).length;
        dependsOn.push({ name: `epic ${link.ref}`, epic: link.ref, state: `${done} of ${members.length} features in production`, available: done === members.length });
        if (!same(link.ref, epic.title)) epics.add(link.ref);
      }
    }
    return { feature, dependsOn };
  });
  return { features: rows, epics: [...epics].sort((a, b) => a.localeCompare(b)) };
}

export function epicDependenciesSection(deps: EpicDependencies, epicHref: (title: string) => string | null): string {
  const named = (dep: FeatureDependency): string => {
    if (dep.card) {
      const away = dep.epic ? ` <span class="muted small">(epic ${escapeHtml(dep.epic)})</span>` : "";
      return `<a href="${escapeHtml(cardUrl(dep.card.repo, dep.card.id))}"><span class="mono">${escapeHtml(dep.name)}</span> ${escapeHtml(dep.title ?? "")}</a>${away}`;
    }
    const to = dep.epic ? epicHref(dep.epic) : null;
    return to ? `<a href="${escapeHtml(to)}">${escapeHtml(dep.name)}</a>` : escapeHtml(dep.name);
  };
  const rows = deps.features
    .map(({ feature, dependsOn }) => {
      const list = dependsOn.length
        ? `<ul class="plain">${dependsOn.map((dep) => `<li>${named(dep)} <span class="pill small${dep.available ? "" : " warn"}">${escapeHtml(dep.state)}</span></li>`).join("")}</ul>`
        : `<p class="muted small">Depends on nothing.</p>`;
      return `<li><a href="${escapeHtml(cardUrl(feature.repo, feature.id))}"><span class="mono">${cardRef(feature.id)}</span> ${escapeHtml(feature.title)}</a>${list}</li>`;
    })
    .join("");
  if (!rows) return "";
  const epics = deps.epics.length
    ? `<p>Depends on epics: ${deps.epics.map((title) => { const to = epicHref(title); return to ? `<a href="${escapeHtml(to)}">${escapeHtml(title)}</a>` : escapeHtml(title); }).join(", ")}.</p>`
    : `<p class="muted">Depends on no other epic.</p>`;
  return `<section id="epic-dependencies"><h2>Dependencies</h2>${epics}<ul class="card-stories">${rows}</ul></section>`;
}
