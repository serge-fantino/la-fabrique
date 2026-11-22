-- The loop of a story (ADR 0003 § 2, epic F15, la-fabrique#424): each phase
-- of Claude's run on a story, reported by the project's claude workflow and
-- signed by GitHub (its OIDC token). Phases, numbers and short summaries
-- only; never the code nor the prompts.
CREATE TABLE loop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL COLLATE NOCASE,
  story INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  -- plan, tests, code, review, fix, verify, deliver, break
  phase TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  -- {"passed": 12, "failed": 1, "new": 3}
  tests TEXT,
  -- {"files": 4, "lines": 120}
  diff TEXT,
  -- {"blocking": 0, "advice": 2}
  findings TEXT,
  -- For a break: decision, spec, tests, code, review, quota.
  break_kind TEXT,
  break_reason TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX loop_events_story ON loop_events (repo, story, id);
CREATE INDEX loop_events_run ON loop_events (run_id, id);
