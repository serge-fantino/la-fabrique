-- A feature behind the scenes ("coulisses", la-fabrique#366): its changes
-- go in the release notes' `coulisses`, for the team, never in the public
-- What's new; its stories carry the project's backstage label.
ALTER TABLE cards ADD COLUMN backstage INTEGER NOT NULL DEFAULT 0;
