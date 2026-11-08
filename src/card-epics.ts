import { activityStatement } from "./activity-log";
import { type Card, cleanValue, dimensionValues, listCards, moveCard } from "./cards";

// A feature's epic is one of the project's epic cards (kind `epic`). The
// choice and the epic's document list are the same link: the epic card's
// `card_links` row (`feature`, the feature's id), mirrored in the feature's
// Epic value (the epic's title). A feature is in one epic at most.

export function epicCardsOf(cards: Card[]): Card[] {
  return cards.filter((card) => card.kind === "epic" && !card.archivedAt);
}

export function findEpicByTitle(cards: Card[], title: string): Card | null {
  const wanted = title.trim().toLowerCase();
  return epicCardsOf(cards).find((card) => card.title.trim().toLowerCase() === wanted) ?? null;
}

// The features attached to an epic card, in the order they were attached.
export async function epicFeatures(db: D1Database, epic: Card): Promise<Card[]> {
  const rows = await db
    .prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = 'feature' ORDER BY rowid")
    .bind(epic.id)
    .all<{ ref: string }>();
  const ids = new Set(rows.results.map((row) => Number(row.ref)));
  const cards = await listCards(db, epic.repo);
  return rows.results.map((row) => cards.find((card) => card.id === Number(row.ref))).filter((c): c is Card => Boolean(c && ids.has(c.id)));
}

// Each attached feature's epic title today (the link is by id, so it follows
// a rename).
export async function featureEpicTitles(db: D1Database, repo: string): Promise<Map<number, string>> {
  const rows = await db
    .prepare("SELECT l.ref AS ref, c.title AS title FROM card_links l JOIN cards c ON c.id = l.card_id WHERE l.kind = 'feature' AND c.repo = ? AND c.kind = 'epic'")
    .bind(repo)
    .all<{ ref: string; title: string }>();
  return new Map(rows.results.map((row) => [Number(row.ref), row.title]));
}

export type EpicChange = "set" | "created" | "removed" | "unchanged" | "not_a_feature" | "not_an_epic";

// Sets (or, with an empty name, removes) a feature's epic. A name matching
// an epic card's title picks it; any other name creates an empty draft epic.
export async function setFeatureEpic(
  db: D1Database,
  feature: Card,
  name: string | null,
  login: string,
  by: "feature" | "document" = "feature",
): Promise<{ change: EpicChange; epic: Card | null }> {
  if (feature.kind !== "feature") return { change: "not_a_feature", epic: null };
  const title = cleanValue(name);
  const cards = await listCards(db, feature.repo);
  let epic: Card | null = null;
  let created = false;
  if (title) {
    epic = findEpicByTitle(cards, title);
    if (!epic) {
      const row = await db
        .prepare(
          `INSERT INTO cards (repo, kind, status, title, body, position, author)
           VALUES (?, 'epic', 'draft', ?, '', (SELECT COALESCE(MAX(position), 0) + 1 FROM cards WHERE repo = ?), ?) RETURNING id`,
        )
        .bind(feature.repo, title, feature.repo, login)
        .first<{ id: number }>();
      const id = row?.id ?? 0;
      await db.batch([
        db
          .prepare("INSERT INTO card_revisions (card_id, rev, title, body, tags, author) VALUES (?, 1, ?, '', ?, ?)")
          .bind(id, title, JSON.stringify({ kind: "epic", status: "draft", epic: null, domain: null, segment: null, release: null }), login),
        activityStatement(db, { actor: login, action: "epic_created", repo: feature.repo, details: { card: id, title, from: feature.id } }),
      ]);
      epic = { ...feature, id, kind: "epic", status: "draft", title, body: "", rev: 1 };
      created = true;
    }
  }
  const previous = feature.epic;
  const linked = await db
    .prepare("SELECT card_id FROM card_links WHERE kind = 'feature' AND ref = ? AND card_id IN (SELECT id FROM cards WHERE repo = ?)")
    .bind(String(feature.id), feature.repo)
    .all<{ card_id: number }>();
  const already = linked.results.length === (epic ? 1 : 0) && (!epic || linked.results[0]?.card_id === epic.id);
  if (already && (epic?.title ?? null) === previous) return { change: "unchanged", epic };

  const known = await dimensionValues(db, feature.repo, await listCards(db, feature.repo));
  await moveCard(db, feature, login, { set: { epic: epic?.title ?? null }, before: null, after: null }, known);
  await db.batch([
    db
      .prepare("DELETE FROM card_links WHERE kind = 'feature' AND ref = ? AND card_id IN (SELECT id FROM cards WHERE repo = ?)")
      .bind(String(feature.id), feature.repo),
    ...(epic ? [db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, 'feature', ?)").bind(epic.id, String(feature.id))] : []),
    activityStatement(db, {
      actor: login,
      action: epic ? "feature_attached" : "feature_detached",
      repo: feature.repo,
      details: { feature: feature.id, epic: epic?.id ?? null, from: previous, by },
    }),
  ]);
  return { change: epic ? (created ? "created" : "set") : "removed", epic };
}

// After a change of the Epic value from elsewhere (the board, the edit
// form): the same link, read from both sides.
export async function syncEpicLink(db: D1Database, feature: Card, login: string): Promise<void> {
  if (feature.kind !== "feature") return;
  const cards = await listCards(db, feature.repo);
  const epic = feature.epic ? findEpicByTitle(cards, feature.epic) : null;
  const linked = await db
    .prepare("SELECT card_id FROM card_links WHERE kind = 'feature' AND ref = ?")
    .bind(String(feature.id))
    .all<{ card_id: number }>();
  const ids = linked.results.map((row) => row.card_id);
  if (ids.length === (epic ? 1 : 0) && (!epic || ids[0] === epic.id)) return;
  await db.batch([
    db.prepare("DELETE FROM card_links WHERE kind = 'feature' AND ref = ?").bind(String(feature.id)),
    ...(epic ? [db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, 'feature', ?)").bind(epic.id, String(feature.id))] : []),
    activityStatement(db, { actor: login, action: epic ? "feature_attached" : "feature_detached", repo: feature.repo, details: { feature: feature.id, epic: epic?.id ?? null, by: "board" } }),
  ]);
}
