# 0002 · Next release, and a sprint without a version

October 31, 2026 · decided by the owner · epic #108

## Context

From the board, a release could be planned by number (0.57) and cards placed in it. On La Fabrique, which has no integration branch, every pull request merged into `main` adds a release-notes entry: the next unrelated merge shipped 0.57, and the card planned in it (C7) was shown as shipped in a release that did not carry it. A sprint started on a planned version had the same flaw: whatever shipped that number ended the sprint.

A version is known only once something ships. Planning needs a place before that.

## Decision

- **Next release**: a lane of the release dimension, with no version, always shown first after *Not set*. It is where the next sprint is prepared. *Plan a release* (by number) is gone from the board.
- **The sprint has no version while it runs.** *Start the sprint* (Sprint tab) takes the cards of Next release; they move to the **Sprint** lane. One sprint at a time.
- **It closes by itself** when every needed story of its cards (nice to have aside, F5.3) is in production or closed; or by hand (*Close the sprint*). Each card done then takes the version that shipped it: the newest shipped release whose notes declare one of its stories, else the newest shipped release. What is not done goes back to Next release. *Stop the sprint* sends every card back.
- Every move of a card is a card move (a version of the card, logged with its reason: sprint started, shipped in 0.61, not done when the sprint closed, sprint stopped).

## Consequences

- The release dimension carries two fixed values, `Next release` and `Sprint`, next to versions.
- A sprint started on a version before this decision still works: it ends when its version ships.
- On a project with an integration branch, the release in progress there is shown on the Sprint tab when no sprint runs (read-only); the sprint itself does not depend on it.
- Closing happens when the board or the Sprint tab is read: a release dated in the notes and a story closed are seen there.
