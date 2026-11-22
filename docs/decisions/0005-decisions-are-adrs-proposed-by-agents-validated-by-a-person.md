# 0005. Decisions are ADRs in the project's repository, proposed by agents, validated by a person in La Fabrique

- Status: Accepted (validated by serge-fantino on 2026-11-22, by [a comment on #419](https://github.com/serge-fantino/la-fabrique/pull/419#issuecomment-7072674090))
- Date: 2026-11-21
- Deciders: serge-fantino
- Serves: epic F15 (C179, #410); C180, C181

## Context

La Fabrique and L'épicerie took decisions that change how they work (Claude in the background, the sprint without a version), written in La Fabrique's `docs/decisions/` in a format of its own, with no status and no deciders. Nothing showed them in La Fabrique, nothing linked them to the cards and stories they serve, and nothing said who validated them.

With the loop of ADR 0003, agents will meet decisions as they code. An agent must be able to propose one and stop, and a person must take it, with a trace.

BeExtraordinary/Armagedon-Project already works this way, for a regulated setting: an ADR per decision (`Status`, `Date`, `Deciders` as code host logins), an index checked in CI, a coding agent that "proposes a decision and never takes it", and a validation by a decider (its ADR 0054: a comment "I accept ADR NNNN"; its ADR 0055: an answer to a task in its console, the GitHub App carrying it out).

## Decision

1. **A decision is an ADR in the project's repository**, one Markdown file `NNNN-title.md`, with `Status`, `Date`, `Deciders` (GitHub logins) and optionally `Serves`, in the folder `.fabrique.json` > `decisions` declares (or a usual one: `docs/adr`, `docs/decisions`). The format is Armagedon's; Nygard's (`## Status` section) is read too. La Fabrique's own decisions are converted (0001, 0002), with an index checked by its tests.
2. **La Fabrique shows them** in a *Decisions* tab per project: status, date, deciders, what they serve (cards, issues), the decisions they name and those that name them. It reads them at a commit and keeps nothing but its cache, like the documentation and the components.
3. **An agent proposes, never takes.** Claude, launched from La Fabrique or not, writes an ADR `Proposed` in its pull request, and the loop stops with a `decision` break (ADR 0003). It never sets a decision `Accepted`.
4. **A decider validates in La Fabrique** (next step, as Armagedon's ADR 0055): a proposed ADR in an open pull request of the project is a task for its `Deciders`, on the decision's page and in the *Agents* page's breaks. *Accept* or *Reject*, with a note, at the commit the person read; La Fabrique checks the login is among the ADR's `Deciders` at that commit, and has a role on the project. The answer is the evidence: logged (`decision_accepted`, `decision_rejected`: who, when, which ADR, which pull request, which commit, the note), never erased.
5. **La Fabrique then carries it out through the pull request**, never on a branch directly: it commits the status and the index on the pull request's branch with the App, comments the decision in a fixed form, and the loop resumes. Merging stays the project's usual merge.
6. **The fallback is a comment** "I accept ADR NNNN" by a decider on the pull request, read by La Fabrique; the first validation recorded holds.

## Consequences

- The App writes on one more kind of branch: those of pull requests that carry an ADR (*Contents: write*, which it already has for `.fabrique.json` changes).
- A decision is linked both ways: from the ADR to its cards and stories, and from a card to the decisions that serve it.
- The same ADR format serves both factories: a project piloted by La Fabrique today can move to Armagedon's software factory without rewriting its decisions.
- This ADR, and 0003 and 0004, are themselves validated the fallback way (the owner's comment), since the validation in La Fabrique does not exist yet.
