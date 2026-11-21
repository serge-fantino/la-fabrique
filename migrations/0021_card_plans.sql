-- Sprints to come, planned on the Roadmap: a feature placed in a future
-- sprint by its rank among the project's sprints (the sprint after the
-- next is the number of sprints started + 2), so the plan moves along by
-- itself as sprints start. Never a version: a version is known only once
-- something ships (decision 0002); Next release stays the release lane.
CREATE TABLE card_plans (
  card_id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  sprint INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX card_plans_repo ON card_plans (repo);
