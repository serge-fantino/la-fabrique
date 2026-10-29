-- `projects.added_by` referenced `accounts`, but super admins from the
-- SUPER_ADMINS variable have no row there, so D1 refused their inserts.
-- The table was still empty, so it is recreated without that key.
DROP TABLE IF EXISTS projects;

CREATE TABLE projects (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  installation_id INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  added_by TEXT NOT NULL
);

-- One row per checked commit of a project's .fabrique.json: a commit never
-- changes, so a check is never redone for the same sha.
CREATE TABLE project_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL COLLATE NOCASE,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  config TEXT,
  errors TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repo, commit_sha)
);

CREATE INDEX idx_project_configs_repo ON project_configs (repo, checked_at);
