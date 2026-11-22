-- The runs of Claude in a project's runner (ADR 0004 § 4, epic F15,
-- la-fabrique#418): its claude and revue workflows, one row per GitHub run,
-- with the usage the run reported (an annotation "Claude usage") priced at
-- the API's rates. Nothing of the run's content: its transcript stays with
-- the project's run (an artifact).
CREATE TABLE runner_runs (
  run_id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  -- claude, revue (the key in .fabrique.json > workflows)
  workflow TEXT NOT NULL,
  -- The capability of the catalogue: code, rework, update, review.
  capability TEXT NOT NULL,
  story INTEGER,
  pull INTEGER,
  status TEXT NOT NULL,
  conclusion TEXT,
  url TEXT,
  started_at TEXT,
  finished_at TEXT,
  -- subscription | api; NULL when the run reported nothing.
  auth TEXT,
  -- {"claude-sonnet-5-5": {"input": …, "output": …, "cache_read": …, "cache_write": …, "cost_usd": …}}
  models TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- At the API's rates, in millionths of a dollar: La Fabrique's prices, or
  -- Claude Code's own figure for a model it does not price.
  api_cost_micros INTEGER,
  -- What the run cost: the API's on a key; 0 on the subscription.
  real_cost_micros INTEGER,
  turns INTEGER,
  duration_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX runner_runs_repo ON runner_runs (repo, capability);
