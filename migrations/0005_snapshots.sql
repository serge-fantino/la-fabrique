-- Snapshots of what La Fabrique extraordinaire reads from GitHub for a
-- project (issues, production status, activity), one JSON document per kind.
-- They save API quota; GitHub stays the source.
CREATE TABLE snapshots (
  repo TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo, kind)
);
