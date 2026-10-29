-- Signed-in sessions. The cookie carries a random id; only its SHA-256 is
-- stored. GitHub user tokens stay here and never leave the Worker.

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  csrf_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  access_token_expires_at TEXT,
  refresh_token TEXT,
  refresh_token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_github_login ON sessions (github_login);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
