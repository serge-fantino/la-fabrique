import { compareVersions } from "./card-releases";
import { cardPills, cardRef, cardUrl } from "./card-views";
import type { CardStatus } from "./cards";
import { escapeHtml } from "./views";

// The stories grouped by the card they were made from (F5.2): a card is
// not an epic (an epic groups cards), but its stories belong together.
export interface CardHead {
  id: number;
  title: string;
  status: CardStatus;
  release: string | null;
  position: number;
}

export interface StoryCards {
  cards: Map<number, CardHead>;
  // A story's cards; a story made from two cards is under both.
  byStory: Map<number, number[]>;
}

export async function storyCards(db: D1Database, repo: string): Promise<StoryCards> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.title, c.status, c.release, c.position, l.ref FROM card_links l JOIN cards c ON c.id = l.card_id
       WHERE c.repo = ? AND l.kind = 'story' AND c.archived_at IS NULL ORDER BY c.position, c.id`,
    )
    .bind(repo)
    .all<CardHead & { ref: string }>();
  const cards = new Map<number, CardHead>();
  const byStory = new Map<number, number[]>();
  for (const row of results) {
    cards.set(row.id, { id: row.id, title: row.title, status: row.status, release: row.release, position: row.position });
    const number = Number(row.ref);
    byStory.set(number, [...(byStory.get(number) ?? []), row.id]);
  }
  return { cards, byStory };
}

export interface CardGroup<T> {
  card: CardHead | null;
  items: T[];
}

// One group per card that has stories among `items`: the newest release
// first (a card without one before), then the board's order; the stories
// from no card last.
export function groupByCard<T extends { number: number }>(items: T[], links: StoryCards): CardGroup<T>[] {
  const cards = [...links.cards.values()].sort(
    (a, b) => (a.release === b.release ? 0 : a.release === null ? -1 : b.release === null ? 1 : compareVersions(a.release, b.release)) || a.position - b.position,
  );
  const groups: CardGroup<T>[] = cards
    .map((card) => ({ card, items: items.filter((item) => links.byStory.get(item.number)?.includes(card.id)) }))
    .filter((group) => group.items.length);
  const loose = items.filter((item) => !links.byStory.has(item.number));
  return loose.length ? [...groups, { card: null, items: loose }] : groups;
}

// A card group's heading: the card, its status and its release.
export function cardGroupHead(repo: string, card: CardHead | null, count: number): string {
  if (!card) return `<div class="group-head"><h2>No card <span class="muted mono">${count}</span></h2></div>`;
  return `<div class="group-head">
      <h2><a class="mono" href="${escapeHtml(cardUrl(repo, card.id))}">${cardRef(card.id)}</a> ${escapeHtml(card.title)} <span class="muted mono">${count}</span></h2>
      <span class="fiche-tags">${cardPills({ status: card.status, release: card.release })}</span>
    </div>`;
}

// The other cards a shared story belongs to.
export function sharedWith(links: StoryCards, number: number, card: number | null): string {
  const others = (links.byStory.get(number) ?? []).filter((id) => id !== card);
  return others.length ? ` <span class="muted small">also in ${others.map(cardRef).join(", ")}</span>` : "";
}
