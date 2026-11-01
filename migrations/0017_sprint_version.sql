-- A sprint gets its version when it starts (la-fabrique#174): the release it
-- will make ("0.82", "1.0"), changed while it runs, released when it closes;
-- and a name, if the person gives one.
ALTER TABLE sprints ADD COLUMN version TEXT;
ALTER TABLE sprints ADD COLUMN name TEXT;
