-- Initial schema for La Fabrique.
--
-- Three tables, append-only log, English identifiers (team convention).
-- Roles map to La Fabrique's four roles: super_admin, product_engineer,
-- tech_lead, tester. "Sans role" is simply the absence of a row.

CREATE TABLE IF NOT EXISTS accounts (
  github_login TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (
    role IN ('super_admin', 'product_engineer', 'tech_lead', 'tester')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  repo TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  added_by TEXT NOT NULL REFERENCES accounts (github_login)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  repo TEXT,
  issue_number INTEGER,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_log_occurred_at
  ON activity_log (occurred_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_repo
  ON activity_log (repo);
