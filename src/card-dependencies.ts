import { activityStatement } from "./activity-log";
import { dimensionValues, listCards, type Card } from "./cards";

// A feature depends on other features of its project, or on a whole epic
// of it (all the features written with that epic): upstream dependencies,
// kept as card links (`depends`: a card number, `depends_epic`: an epic
// name). Stories keep GitHub's "blocked by" for technical dependencies.
export const DEPENDS = "depends";
export const DEPENDS_EPIC = "depends_epic";

export type Target = { card: number } | { epic: string };

export interface Dependencies {
  // What the card depends on: features, and epics with their features.
  dependsOn: Card[];
  dependsOnEpics: { epic: string; cards: Card[] }[];
  // Who needs it, directly or through its epic.
  neededBy: { card: Card; viaEpic: string | null }[];
}

interface LinkRow {
  card_id: number;
  kind: string;
  ref: string;
}

export async function projectLinks(db: D1Database, repo: string): Promise<LinkRow[]> {
  const { results } = await db
    .prepare("SELECT l.card_id, l.kind, l.ref FROM card_links l JOIN cards c ON c.id = l.card_id WHERE c.repo = ? AND l.kind IN (?, ?)")
    .bind(repo, DEPENDS, DEPENDS_EPIC)
    .all<LinkRow>();
  return results;
}

export async function dependenciesOf(db: D1Database, repo: string, id: number): Promise<Dependencies> {
  const [cards, links] = await Promise.all([listCards(db, repo), projectLinks(db, repo)]);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const mine = byId.get(id);
  const dependsOn: Card[] = [];
  const dependsOnEpics: Dependencies["dependsOnEpics"] = [];
  const neededBy: Dependencies["neededBy"] = [];
  for (const link of links) {
    if (link.card_id === id) {
      if (link.kind === DEPENDS) {
        const card = byId.get(Number(link.ref));
        if (card) dependsOn.push(card);
      } else {
        dependsOnEpics.push({ epic: link.ref, cards: cards.filter((card) => card.epic === link.ref && !card.archivedAt) });
      }
      continue;
    }
    const owner = byId.get(link.card_id);
    if (!owner || owner.archivedAt) continue;
    if (link.kind === DEPENDS && Number(link.ref) === id) neededBy.push({ card: owner, viaEpic: null });
    if (link.kind === DEPENDS_EPIC && mine?.epic && link.ref === mine.epic) neededBy.push({ card: owner, viaEpic: link.ref });
  }
  return { dependsOn, dependsOnEpics, neededBy };
}

// The features that would make a loop if `card` depended on `target`:
// the path from the target back to the card, or null.
export function loopThrough(cards: Card[], links: LinkRow[], card: number, target: Target): number[] | null {
  const byId = new Map(cards.map((candidate) => [candidate.id, candidate]));
  const next = (id: number): number[] => {
    const out: number[] = [];
    for (const link of links) {
      if (link.card_id !== id) continue;
      if (link.kind === DEPENDS) out.push(Number(link.ref));
      else for (const member of cards) if (member.epic === link.ref && !member.archivedAt) out.push(member.id);
    }
    return out;
  };
  const starts = "card" in target ? [target.card] : cards.filter((member) => member.epic === target.epic && !member.archivedAt).map((member) => member.id);
  // Breadth-first from the target's features, remembering the way.
  const parent = new Map<number, number | null>();
  const queue: number[] = [];
  for (const start of starts) {
    if (!parent.has(start)) {
      parent.set(start, null);
      queue.push(start);
    }
  }
  while (queue.length) {
    const current = queue.shift() as number;
    if (current === card) {
      const path: number[] = [];
      for (let at: number | null | undefined = current; at !== null && at !== undefined; at = parent.get(at)) path.unshift(at);
      return [card, ...path];
    }
    for (const following of next(current)) {
      if (byId.has(following) && !parent.has(following)) {
        parent.set(following, current);
        queue.push(following);
      }
    }
  }
  return null;
}

export type DependencyOutcome = { ok: true } | { ok: false; reason: string; loop?: number[] };

export async function addDependency(db: D1Database, repo: string, card: Card, target: Target, login: string): Promise<DependencyOutcome> {
  if (card.archivedAt) return { ok: false, reason: "An archived card cannot get a dependency." };
  const [cards, links] = await Promise.all([listCards(db, repo), projectLinks(db, repo)]);
  let kind = DEPENDS;
  let ref: string;
  let label: string;
  if ("card" in target) {
    const other = cards.find((candidate) => candidate.id === target.card);
    if (!other || other.archivedAt) return { ok: false, reason: "That feature is not in this project." };
    if (other.id === card.id) return { ok: false, reason: "A feature cannot depend on itself.", loop: [card.id, card.id] };
    ref = String(other.id);
    label = `C${other.id}`;
  } else {
    const known = (await dimensionValues(db, repo, cards)).epic;
    if (!known.includes(target.epic)) return { ok: false, reason: "That epic is not in this project." };
    kind = DEPENDS_EPIC;
    ref = target.epic;
    label = `epic ${target.epic}`;
  }
  if (links.some((link) => link.card_id === card.id && link.kind === kind && link.ref === ref)) return { ok: false, reason: `Already depends on ${label}.` };
  const loop = loopThrough(cards, links, card.id, target);
  if (loop) {
    const named = loop.map((id) => `C${id}`).join(" → ");
    return { ok: false, reason: `That would make a loop: ${named}.`, loop };
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, ?, ?)").bind(card.id, kind, ref),
    activityStatement(db, { actor: login, action: "card_dependency_added", repo, details: { card: card.id, title: card.title, on: "card" in target ? target.card : null, epic: "epic" in target ? target.epic : null } }),
  ]);
  return { ok: true };
}

export async function removeDependency(db: D1Database, repo: string, card: Card, target: Target, login: string): Promise<boolean> {
  const kind = "card" in target ? DEPENDS : DEPENDS_EPIC;
  const ref = "card" in target ? String(target.card) : target.epic;
  const done = await db.prepare("DELETE FROM card_links WHERE card_id = ? AND kind = ? AND ref = ?").bind(card.id, kind, ref).run();
  if (!done.meta.changes) return false;
  await activityStatement(db, { actor: login, action: "card_dependency_removed", repo, details: { card: card.id, title: card.title, on: "card" in target ? target.card : null, epic: "epic" in target ? target.epic : null } }).run();
  return true;
}

// What can be chosen: the project's other features and its epics.
export async function dependencyChoices(db: D1Database, repo: string, card: Card): Promise<{ cards: Card[]; epics: string[] }> {
  const cards = await listCards(db, repo);
  const epics = (await dimensionValues(db, repo, cards)).epic;
  return { cards: cards.filter((other) => other.id !== card.id && !other.archivedAt), epics };
}

// Who added or removed a dependency of the card, or one on it, and when.
export async function dependencyHistory(db: D1Database, repo: string, id: number): Promise<{ actor: string; action: string; at: string; card: number; on: number | null; epic: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT actor, action, occurred_at, details FROM activity_log WHERE repo = ? AND action IN ('card_dependency_added', 'card_dependency_removed')
       AND (json_extract(details, '$.card') = ? OR json_extract(details, '$.on') = ?) ORDER BY id DESC LIMIT 50`,
    )
    .bind(repo, id, id)
    .all<{ actor: string; action: string; occurred_at: string; details: string }>();
  return results.map((row) => {
    const d = JSON.parse(row.details) as { card: number; on: number | null; epic: string | null };
    return { actor: row.actor, action: row.action, at: row.occurred_at, card: d.card, on: d.on ?? null, epic: d.epic ?? null };
  });
}
