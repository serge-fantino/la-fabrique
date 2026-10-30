-- Claude in La Fabrique (la-fabrique#74): every call to the Anthropic API,
-- who made it, for which card, what it cost. Never its content. The
-- totals give the quotas (calls per person and day, budget per month)
-- and the cost of each card, end to end.
CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  login TEXT NOT NULL,
  repo TEXT COLLATE NOCASE,
  card_id INTEGER,
  purpose TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- In millionths of a US dollar; NULL when the model's price is unknown.
  cost_micros INTEGER,
  outcome TEXT NOT NULL,
  error TEXT
);

CREATE INDEX llm_calls_by_at ON llm_calls (at);
CREATE INDEX llm_calls_by_login ON llm_calls (login, at);
CREATE INDEX llm_calls_by_card ON llm_calls (card_id);

-- A card's versions now keep its free fields too (its spec).
ALTER TABLE card_revisions ADD COLUMN data TEXT;
