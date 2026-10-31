-- A card's progress, worked out from its stories and the sprint (la-fabrique#113):
-- the stage last seen, to place the card on the board and to notice a change,
-- which the log dates (card_progress_changed). Never typed.
ALTER TABLE cards ADD COLUMN progress TEXT;
