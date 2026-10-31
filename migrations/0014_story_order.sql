-- The order in the sprint (la-fabrique#111): a card's stories in their
-- order, and those that are nice to have (done if there is time, they do
-- not hold the release). A planning decision, kept on the link between a
-- card and its story; the cards themselves follow the board's order.
ALTER TABLE card_links ADD COLUMN position INTEGER;
ALTER TABLE card_links ADD COLUMN nice INTEGER NOT NULL DEFAULT 0;
