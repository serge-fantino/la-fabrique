# Decisions

The decisions that would surprise the next reader, one file each (an ADR: architecture decision record). La Fabrique shows them in its *Decisions* tab (`.fabrique.json` > `decisions`).

Start from [`0000-template.md`](0000-template.md); number in sequence; add the file to this index in the same pull request (the tests check it).

A coding agent (Claude, launched from La Fabrique or not) proposes a decision and never takes it: it writes the ADR with `Status: Proposed`. One of its `Deciders` validates it; until then, nothing is accepted. How the validation is recorded is the subject of [ADR 0005](0005-decisions-are-adrs-proposed-by-agents-validated-by-a-person.md).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-claude-in-the-background.md) | Claude works in the background | Accepted |
| [0002](0002-next-release-and-the-sprint.md) | Next release, and a sprint without a version | Accepted |
| [0003](0003-the-engineering-loop-of-a-story.md) | The engineering loop of a story: one agent session, explicit phases, typed breaks, from the epic to production | Accepted |
| [0004](0004-agents-observed-counted-and-steered-from-la-fabrique.md) | Agents are observed, counted and steered from La Fabrique: one queue, their logs, their tokens, their model | Accepted |
| [0005](0005-decisions-are-adrs-proposed-by-agents-validated-by-a-person.md) | Decisions are ADRs in the project's repository, proposed by agents, validated by a person in La Fabrique | Accepted |
| [0006](0006-capabilities-requests-and-plans-the-generic-agent-mechanism.md) | Capabilities, requests and plans: one generic mechanism for every agent task, taken from LimaLibri | Accepted |
