-- The queue of Claude's jobs (la-fabrique#226): a job waits (status
-- 'waiting') until fewer than two run, then goes to the Cloudflare queue
-- ('queued'); a job not started can be 'cancelled'. queued_at is when it
-- left the waiting line, to tell a job whose consumer died from one that
-- only waited its turn.
ALTER TABLE claude_jobs ADD COLUMN queued_at TEXT;
