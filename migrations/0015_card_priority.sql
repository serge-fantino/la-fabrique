-- A card's priority (la-fabrique#111): one of the project's priority labels
-- (`cycle.priorites`); its stories take it when they are made, one level
-- lower for those that are nice to have.
ALTER TABLE cards ADD COLUMN priority TEXT;
