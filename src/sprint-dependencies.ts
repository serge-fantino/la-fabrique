import type { Card } from "./cards";
import type { DependencyLink } from "./dependency-warnings";

// Dependency first in the sprint (la-fabrique#301): a feature's dependency
// that is in the sprint too is launched first when a launch slot is free;
// the feature never waits for it (both are developed side by side), and the
// manual order is never changed (only the order of launching).

const DEPENDS = "depends";
const DEPENDS_EPIC = "depends_epic";

// The cards of `cards` that `card` depends on (a feature, or the features
// of an epic), outside the card itself.
export function dependenciesIn(card: Card, cards: Card[], links: DependencyLink[]): Card[] {
  const out = new Set<Card>();
  for (const link of links) {
    if (link.card_id !== card.id) continue;
    for (const other of cards) {
      if (other.id === card.id || other.archivedAt) continue;
      if (link.kind === DEPENDS ? other.id === Number(link.ref) : link.kind === DEPENDS_EPIC && other.epic === link.ref) out.add(other);
    }
  }
  return [...out];
}

// The cards in launching order: the manual order, except that a card comes
// after the cards it depends on (stable; a loop is left as it is).
export function dependencyFirst(cards: Card[], links: DependencyLink[]): Card[] {
  const out: Card[] = [];
  const state = new Map<number, "doing" | "done">();
  const visit = (card: Card) => {
    if (state.has(card.id)) return;
    state.set(card.id, "doing");
    for (const dependency of dependenciesIn(card, cards, links)) visit(dependency);
    state.set(card.id, "done");
    out.push(card);
  };
  for (const card of cards) visit(card);
  return out;
}

export interface DependencyNote {
  // The dependencies in the sprint: "After C74".
  after: number[];
  // Those among them that stopped on a problem: "C74 stopped".
  stopped: number[];
  // Those placed below the card in the manual order: a warning.
  below: number[];
}

export function dependencyNotes(cards: Card[], links: DependencyLink[], stopped: Set<number>): Map<number, DependencyNote> {
  const notes = new Map<number, DependencyNote>();
  cards.forEach((card, index) => {
    const dependencies = dependenciesIn(card, cards, links);
    if (!dependencies.length) return;
    notes.set(card.id, {
      after: dependencies.map((other) => other.id),
      stopped: dependencies.filter((other) => stopped.has(other.id)).map((other) => other.id),
      below: dependencies.filter((other) => cards.indexOf(other) > index).map((other) => other.id),
    });
  });
  return notes;
}
