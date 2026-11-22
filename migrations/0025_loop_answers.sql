-- The breaks of the loop as tasks for a person (ADR 0003 § 3, epic F15,
-- C186): who answered a break and when. The answer itself is a comment on
-- the story's issue and an entry of the log (loop_break_answered).
ALTER TABLE loop_events ADD COLUMN answered_by TEXT;
ALTER TABLE loop_events ADD COLUMN answered_at TEXT;
