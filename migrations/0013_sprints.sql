-- The sprint (la-fabrique#109): a release of the project, started in La
-- Fabrique; one at a time per project. It ends when the project's release
-- notes date the release (shipped), or when it is stopped by hand.
CREATE TABLE sprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL COLLATE NOCASE,
  release TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_by TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  -- stopped, shipped
  end_reason TEXT
);

CREATE INDEX sprints_by_repo ON sprints (repo, id);
