export interface Snapshot<T> {
  data: T;
  fetchedAt: string;
}

export async function readSnapshot<T>(db: D1Database, repo: string, kind: string): Promise<Snapshot<T> | null> {
  const row = await db
    .prepare("SELECT data, fetched_at FROM snapshots WHERE repo = ? AND kind = ?")
    .bind(repo, kind)
    .first<{ data: string; fetched_at: string }>();
  return row ? { data: JSON.parse(row.data) as T, fetchedAt: row.fetched_at } : null;
}

export async function writeSnapshot(db: D1Database, repo: string, kind: string, data: unknown, fetchedAt?: string): Promise<string> {
  const at = fetchedAt ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo, kind) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    )
    .bind(repo, kind, JSON.stringify(data), at)
    .run();
  return at;
}

// Keeps the data but makes the next reader fetch again.
export async function markStale(db: D1Database, repo: string, kind: string): Promise<void> {
  await db
    .prepare("UPDATE snapshots SET fetched_at = '1970-01-01T00:00:00.000Z' WHERE repo = ? AND kind = ?")
    .bind(repo, kind)
    .run();
}

export function isFresh(snapshot: Snapshot<unknown> | null, maxAgeMs: number, now = Date.now()): boolean {
  return snapshot !== null && now - Date.parse(snapshot.fetchedAt) < maxAgeMs;
}
