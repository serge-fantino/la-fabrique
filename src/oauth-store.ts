// The OAuth library keeps clients, grants and tokens in a KV namespace;
// here they live in La Fabrique's own D1 base, in a table that answers the
// few KV calls the library makes (get, put, delete, list by prefix).
const MAX_LIST = 1000;

interface ListedRow {
  key: string;
  metadata: string | null;
  expires_at: number | null;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function d1KeyValue(db: D1Database): KVNamespace {
  const store = {
    async get(key: string, options?: string | { type?: string }): Promise<unknown> {
      const row = await db
        .prepare("SELECT value FROM oauth_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
        .bind(key, now())
        .first<{ value: string }>();
      if (!row) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(row.value) : row.value;
    },

    async put(key: string, value: string, options: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}): Promise<void> {
      const expires = options.expiration ?? (options.expirationTtl ? now() + options.expirationTtl : null);
      await db.batch([
        db.prepare("DELETE FROM oauth_kv WHERE expires_at <= ?").bind(now()),
        db
          .prepare(
            `INSERT INTO oauth_kv (key, value, metadata, expires_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at`,
          )
          .bind(key, value, options.metadata === undefined ? null : JSON.stringify(options.metadata), expires),
      ]);
    },

    async delete(key: string): Promise<void> {
      await db.prepare("DELETE FROM oauth_kv WHERE key = ?").bind(key).run();
    },

    // Keys in order; the cursor is the last key of the page.
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const prefix = options.prefix ?? "";
      const limit = Math.max(1, Math.min(options.limit ?? MAX_LIST, MAX_LIST));
      const { results } = await db
        .prepare(
          `SELECT key, metadata, expires_at FROM oauth_kv
           WHERE substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY key LIMIT ?`,
        )
        .bind(prefix.length, prefix, options.cursor ?? "", now(), limit + 1)
        .all<ListedRow>();
      const page = results.slice(0, limit);
      const complete = results.length <= limit;
      return {
        keys: page.map((row) => ({
          name: row.key,
          ...(row.expires_at ? { expiration: row.expires_at } : {}),
          ...(row.metadata ? { metadata: JSON.parse(row.metadata) as unknown } : {}),
        })),
        list_complete: complete,
        ...(complete ? {} : { cursor: page[page.length - 1]?.key ?? "" }),
        cacheStatus: null,
      };
    },
  };
  return store as unknown as KVNamespace;
}
