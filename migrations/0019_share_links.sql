-- Secret share links of the release preparation document (la-fabrique#233):
-- a frozen copy of the document, found by the hash of a secret token, that
-- expires and can be revoked; openings are counted by date only.
CREATE TABLE share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL,
  doc TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX share_links_repo ON share_links (repo);
CREATE TABLE share_link_openings (
  link_id INTEGER NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX share_link_openings_link ON share_link_openings (link_id);
