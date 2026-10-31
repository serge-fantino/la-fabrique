import { activityStatement } from "./activity-log";

// The sprints of a project (la-fabrique#109): a release, started in La
// Fabrique, one at a time; ended when it ships or is stopped. Every start
// and end is logged.
export interface Sprint {
  id: number;
  repo: string;
  release: string;
  startedAt: string;
  startedBy: string;
  endedAt: string | null;
  endedBy: string | null;
  endReason: "stopped" | "shipped" | null;
}

interface SprintRow {
  id: number;
  repo: string;
  release: string;
  started_at: string;
  started_by: string;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
}

function toSprint(row: SprintRow): Sprint {
  return {
    id: row.id,
    repo: row.repo,
    release: row.release,
    startedAt: row.started_at,
    startedBy: row.started_by,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endReason: row.end_reason === "stopped" || row.end_reason === "shipped" ? row.end_reason : null,
  };
}

// The newest sprint of a project, running or ended.
export async function latestSprint(db: D1Database, repo: string): Promise<Sprint | null> {
  const row = await db.prepare("SELECT * FROM sprints WHERE repo = ? ORDER BY id DESC LIMIT 1").bind(repo).first<SprintRow>();
  return row ? toSprint(row) : null;
}

export async function activeSprint(db: D1Database, repo: string): Promise<Sprint | null> {
  const sprint = await latestSprint(db, repo);
  return sprint && !sprint.endedAt ? sprint : null;
}

export async function startSprint(db: D1Database, repo: string, release: string, login: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const running = await activeSprint(db, repo);
  if (running) return { ok: false, message: `The sprint ${running.release} is in progress: stop it first.` };
  await db.batch([
    db.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, ?, ?)").bind(repo, release, login),
    activityStatement(db, { actor: login, action: "sprint_started", repo, details: { release } }),
  ]);
  return { ok: true };
}

export async function endSprint(db: D1Database, sprint: Sprint, login: string, reason: "stopped" | "shipped"): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE sprints SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_by = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
      .bind(login, reason, sprint.id),
    activityStatement(db, { actor: login, action: reason === "shipped" ? "sprint_shipped" : "sprint_stopped", repo: sprint.repo, details: { release: sprint.release } }),
  ]);
}

// ---- The order in the sprint (la-fabrique#111) ----------------------------

function moved<T>(items: T[], item: T, direction: "up" | "down"): T[] | null {
  const at = items.indexOf(item);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= items.length) return null;
  const copy = [...items];
  [copy[at], copy[to]] = [copy[to] as T, copy[at] as T];
  return copy;
}

// A card one place up or down among its release's cards: the board's order.
export async function moveCardInRelease(db: D1Database, repo: string, release: string, card: number, direction: "up" | "down", login: string): Promise<boolean> {
  const { results } = await db
    .prepare("SELECT id, position FROM cards WHERE repo = ? AND release = ? AND archived_at IS NULL ORDER BY position, id")
    .bind(repo, release)
    .all<{ id: number; position: number }>();
  const order = moved(
    results.map((row) => row.id),
    card,
    direction,
  );
  if (!order) return false;
  // The same places, taken in the new order; distinct, so the order holds.
  const places = results.map((row) => row.position).sort((a, b) => a - b);
  for (let index = 1; index < places.length; index++) if ((places[index] ?? 0) <= (places[index - 1] ?? 0)) places[index] = (places[index - 1] ?? 0) + 1;
  await db.batch([
    ...order.map((id, index) => db.prepare("UPDATE cards SET position = ? WHERE id = ?").bind(places[index] ?? index, id)),
    activityStatement(db, { actor: login, action: "sprint_card_moved", repo, details: { card: card, release, direction } }),
  ]);
  return true;
}

// A card's story one place up or down among the card's stories.
export async function moveStoryInCard(db: D1Database, repo: string, card: number, story: number, direction: "up" | "down", login: string): Promise<boolean> {
  const { results } = await db
    .prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = 'story' ORDER BY position IS NULL, position, CAST(ref AS INTEGER)")
    .bind(card)
    .all<{ ref: string }>();
  const order = moved(
    results.map((row) => Number(row.ref)),
    story,
    direction,
  );
  if (!order) return false;
  await db.batch([
    ...order.map((number, index) =>
      db.prepare("UPDATE card_links SET position = ? WHERE card_id = ? AND kind = 'story' AND ref = ?").bind(index + 1, card, String(number)),
    ),
    activityStatement(db, { actor: login, action: "sprint_story_moved", repo, issueNumber: story, details: { card, direction } }),
  ]);
  return true;
}

// Nice to have: done if there is time; it does not hold the release.
export async function setNice(db: D1Database, repo: string, card: number, story: number, nice: boolean, login: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE card_links SET nice = ? WHERE card_id = ? AND kind = 'story' AND ref = ? AND nice != ?")
    .bind(nice ? 1 : 0, card, String(story), nice ? 1 : 0)
    .run();
  if (!result.meta.changes) return false;
  await activityStatement(db, { actor: login, action: "story_nice_set", repo, issueNumber: story, details: { card, nice } }).run();
  return true;
}
