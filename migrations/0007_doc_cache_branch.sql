-- Documentation can be read on another branch than production; each branch
-- keeps its own latest commit in the cache. Rows without a branch are
-- production's.
ALTER TABLE doc_cache ADD COLUMN branch TEXT;
