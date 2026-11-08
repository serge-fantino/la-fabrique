import { activityStatement } from "./activity-log";
import { type Card, listCards } from "./cards";
import { epicCardsOf } from "./card-epics";

// One-time conversion of the Epic values typed on features into epic cards
// (la-fabrique#295). A value is pending while some feature carries it
// without being linked to an epic card of that title; once converted,
// nothing is pending, so it cannot run twice. Values differing only by
// case or spaces are one value (an epic card's title is matched that way).

export interface PendingEpic {
  key: string;
  value: string;
  features: Card[];
  existing: Card | null;
}

const keyOf = (value: string) => value.trim().toLowerCase();

export async function pendingEpics(db: D1Database, repo: string): Promise<PendingEpic[]> {
  const cards = await listCards(db, repo);
  const epics = epicCardsOf(cards);
  const links = await db
    .prepare("SELECT card_id, ref FROM card_links WHERE kind = 'feature' AND card_id IN (SELECT id FROM cards WHERE repo = ?)")
    .bind(repo)
    .all<{ card_id: number; ref: string }>();
  const titleOf = new Map(epics.map((epic) => [epic.id, keyOf(epic.title)]));
  const linkedTo = new Map<number, Set<string>>();
  for (const link of links.results) {
    const title = titleOf.get(link.card_id);
    if (!title) continue;
    const set = linkedTo.get(Number(link.ref)) ?? new Set<string>();
    set.add(title);
    linkedTo.set(Number(link.ref), set);
  }
  const groups = new Map<string, PendingEpic>();
  for (const card of cards) {
    if (card.kind !== "feature" || card.archivedAt || !card.epic?.trim()) continue;
    const key = keyOf(card.epic);
    if (linkedTo.get(card.id)?.has(key)) continue;
    const group = groups.get(key) ?? { key, value: card.epic.trim(), features: [], existing: epics.find((epic) => keyOf(epic.title) === key) ?? null };
    group.features.push(card);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.value.localeCompare(b.value));
}

export type EpicChoice = "attach" | "create";

// Converts the pending values under the choices given (default: attach to
// the card of the same title when there is one, else create a draft epic).
export async function convertEpics(
  db: D1Database,
  repo: string,
  login: string,
  choices: Map<string, EpicChoice>,
): Promise<{ created: number; attached: number }> {
  const pending = await pendingEpics(db, repo);
  let created = 0;
  let attached = 0;
  await db.batch([activityStatement(db, { actor: login, action: "epic_conversion_confirmed", repo, details: { values: pending.map((p) => p.value) } })]);
  for (const item of pending) {
    let epicId = item.existing?.id ?? 0;
    if (!item.existing || choices.get(item.key) === "create") {
      const row = await db
        .prepare(
          `INSERT INTO cards (repo, kind, status, title, body, position, author)
           VALUES (?, 'epic', 'draft', ?, '', (SELECT COALESCE(MAX(position), 0) + 1 FROM cards WHERE repo = ?), ?) RETURNING id`,
        )
        .bind(repo, item.value, repo, login)
        .first<{ id: number }>();
      epicId = row?.id ?? 0;
      await db.batch([
        db
          .prepare("INSERT INTO card_revisions (card_id, rev, title, body, tags, author) VALUES (?, 1, ?, '', ?, ?)")
          .bind(epicId, item.value, JSON.stringify({ kind: "epic", status: "draft", epic: null, domain: null, segment: null, release: null }), login),
        activityStatement(db, { actor: login, action: "epic_created", repo, details: { card: epicId, title: item.value, by: "conversion" } }),
      ]);
      created += 1;
    }
    for (const feature of item.features) {
      await db.batch([
        db.prepare("DELETE FROM card_links WHERE kind = 'feature' AND ref = ? AND card_id IN (SELECT id FROM cards WHERE repo = ?)").bind(String(feature.id), repo),
        db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, 'feature', ?)").bind(epicId, String(feature.id)),
        activityStatement(db, { actor: login, action: "feature_attached", repo, details: { feature: feature.id, epic: epicId, from: feature.epic, by: "conversion" } }),
      ]);
      attached += 1;
    }
  }
  return { created, attached };
}
