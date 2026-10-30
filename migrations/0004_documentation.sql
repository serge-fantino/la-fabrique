-- Documentation pages published by a project, listed when its .fabrique.json
-- is checked, and the commit date shown above each page.
ALTER TABLE project_configs ADD COLUMN doc_pages TEXT;
ALTER TABLE project_configs ADD COLUMN committed_at TEXT;

-- Markdown read from GitHub, one row per file and commit. Only the commit
-- currently in production is kept for each project.
CREATE TABLE doc_cache (
  repo TEXT NOT NULL COLLATE NOCASE,
  commit_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  markdown TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo, commit_sha, path)
);
