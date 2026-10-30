-- La Fabrique as an OAuth provider for a project's own app (#65).
--
-- The OAuth library keeps its clients, grants and tokens in a key-value
-- store; here they live in this base, one row per key. Secrets and tokens
-- are stored hashed, and what a grant carries is encrypted by the library.
CREATE TABLE oauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  metadata TEXT,
  -- Seconds since 1970; null for keys that do not expire.
  expires_at INTEGER
);

CREATE INDEX idx_oauth_kv_expires_at ON oauth_kv (expires_at);

-- The project each registered app reports to.
CREATE TABLE oauth_apps (
  client_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
