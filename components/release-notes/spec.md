# Release notes and What's new — spec

## Need

- A pull request that changes something visible says it, in the language of its users, in the release-notes file, and names the stories it ships.
- Two pull requests never fight over a version number: the number and the time are given when the change ships.
- The users see what changed, newest first; a story of a version leads to its issue.

## Acceptance criteria

- [ ] When a pull request changes something visible, it adds an entry on top with `"version": "next"`, the date, no time, its changes and its stories.
- [ ] When the pull request is merged by the merge workflow, its entries are numbered after the newest on the production branch, with the time of the merge.
- [ ] When a sprint is released, the `next` entries that declare a done story become one version; an entry with a story not done is marked partial.
- [ ] When an entry has no `stories`, or the production branch has a `next` entry, the checks fail.
- [ ] When I open « What's new », I see the versions newest first, each change and each story linked to its issue.
