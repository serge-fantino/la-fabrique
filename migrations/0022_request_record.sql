-- One record for every agent request (ADR 0006, epic F15, la-fabrique#415):
-- the capability of the catalogue it asks for (src/capabilities.ts), the
-- target's state when asked, and a person's decision on what it proposed.
-- La Fabrique's own requests are its background jobs (claude_jobs).
ALTER TABLE claude_jobs ADD COLUMN capability TEXT;
-- The card's state when asked: {"rev": 12, "spec_at": "…"}.
ALTER TABLE claude_jobs ADD COLUMN target TEXT;
-- For a capability that waits for a decision: kept, partly, rejected, or
-- replaced (a newer proposal took its place); NULL while it waits.
-- unrecorded: decided before decisions were recorded.
ALTER TABLE claude_jobs ADD COLUMN decision TEXT;
ALTER TABLE claude_jobs ADD COLUMN decided_by TEXT;
ALTER TABLE claude_jobs ADD COLUMN decided_at TEXT;
-- {"kept": 2, "of": 3, "reason": "…", "outdated": true}
ALTER TABLE claude_jobs ADD COLUMN decision_details TEXT;

UPDATE claude_jobs SET capability = CASE kind
  WHEN 'spec_split' THEN 'stories'
  WHEN 'spec_tests' THEN 'test_cases'
  WHEN 'epic_features' THEN 'epic_features'
  WHEN 'epic_review' THEN 'epic_review'
  ELSE CASE WHEN (SELECT kind FROM cards WHERE cards.id = claude_jobs.card_id) = 'epic' THEN 'epic_document' ELSE 'spec' END
END;
UPDATE claude_jobs SET decision = 'unrecorded' WHERE status = 'done' AND capability IN ('stories', 'epic_features', 'epic_review');

CREATE INDEX claude_jobs_capability ON claude_jobs (card_id, capability, id);
