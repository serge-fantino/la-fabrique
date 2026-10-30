-- Screenshots sent with a defect from a project's app (#65). Only from an
-- environment declared with `signalement: true` (never production): int
-- holds no real customer data. Linked from the issue by an address that
-- cannot be guessed; stored in parts, as D1 limits a value to 2 MB.
CREATE TABLE screenshots (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  reporter TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE screenshot_parts (
  screenshot_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (screenshot_id, part)
);
