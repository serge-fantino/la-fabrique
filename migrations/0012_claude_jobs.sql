-- Claude works in the background (docs/decisions/0001-claude-in-the-background.md):
-- a request is saved as a job at once, with the person's answers, then a
-- queue consumer runs it, detached from the browser. Its log is what the
-- card's page shows as it goes.
CREATE TABLE claude_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL COLLATE NOCASE,
  card_id INTEGER NOT NULL,
  -- spec_draft, spec_revise, spec_answer
  kind TEXT NOT NULL,
  -- queued, running, done, failed
  status TEXT NOT NULL,
  -- What was asked: {instruction, answers: [{question, answer}]}
  request TEXT NOT NULL,
  login TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  call_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX claude_jobs_by_card ON claude_jobs (card_id, id);
CREATE INDEX claude_jobs_by_status ON claude_jobs (status);

-- What a job did, line by line.
CREATE TABLE claude_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  text TEXT NOT NULL
);

CREATE INDEX claude_job_events_by_job ON claude_job_events (job_id, id);
