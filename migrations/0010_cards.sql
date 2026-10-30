-- The upstream of dev (epic F4, la-fabrique#74): cards written in La
-- Fabrique, attached to a project, before they become stories (if ever).
-- Loosely structured: the substance is the Markdown text; only what
-- filters or places a card on the board is a column. `data` holds free
-- fields as JSON.
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  epic TEXT,
  domain TEXT,
  segment TEXT,
  release TEXT,
  position REAL NOT NULL,
  data TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT
);

CREATE INDEX cards_by_repo ON cards (repo, position);

-- Every version of a card, never deleted: its title, text and tags.
CREATE TABLE card_revisions (
  card_id INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (card_id, rev)
);

-- What a card's text points to (an issue, a person, a glossary term),
-- read from it each time it is saved; later its stories and releases.
CREATE TABLE card_links (
  card_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (card_id, kind, ref)
);

-- Values of a project's free dimensions (epic, domain, segment, release)
-- created from the board before any card uses them, in their order.
CREATE TABLE card_values (
  repo TEXT NOT NULL COLLATE NOCASE,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  position REAL NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo, dimension, value)
);

-- The perspective each person last chose (F4.1): what they see, not what
-- they may do.
CREATE TABLE perspective_choices (
  github_login TEXT PRIMARY KEY,
  perspective TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
