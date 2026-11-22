# 0003. The engineering loop of a story: one agent session, explicit phases, typed breaks, from the epic to production

- Status: Proposed
- Date: 2026-11-21
- Deciders: serge-fantino
- Serves: epic F15 (C179, #410); C185, C186, C188, C189

## Context

Today a story reaches production through a chain of separate runs, glued together by La Fabrique:

- `claude.yml` writes the code in **one turn** ("You have one turn: the run ends as soon as you stop"), opens a pull request, and stops;
- `review.yml` reviews it afterwards, in another run, and never blocks;
- a tester's feedback comes back as a comment and a `rework` label; "Rework with Claude" is launched by hand, as a third run;
- the sprint's run (`SprintRun`, F5.8) waits for each run by webhooks, merges, and moves on.

What it costs:

- **Context is lost at every step.** Each run starts from nothing, reinstalls the dependencies, rereads the code. A review finding goes back to Claude only through another run, launched by someone.
- **The inside of the loop is invisible.** La Fabrique logs the outside (launched, pull request, merged). What Claude tried, which tests failed and why, what it doubted, is in the Actions log or in "Claude's last words".
- **Stops are not typed.** "Run failed", "no pull request", "more than 70 minutes": La Fabrique cannot tell a doubt on the spec from a decision that needs an architect, so it cannot send it to the right person.
- **The loop is cut by screens, not by the work.** Spec (card page), split (preview), sprint, To test, Production: each screen shows its own moment. Nothing shows one story, or one epic, going through the whole cycle.

Two other shapes were considered, and are kept out:

- **Route each run to the Claude subscription or to the API.** `claude.yml` already takes either secret. It is a question of cost (ADR 0004), not of how the loop works.
- **Run the agents in La Fabrique, without GitHub.** La Fabrique would hold what writes code in a project (its tokens, its secrets). It breaks principle 3 (the sensitive actions stay in the project), and would not pass in a regulated setting.

## Decision

**A story is built in one agent session, with explicit phases, in the project's runner, reporting each phase to La Fabrique.** GitHub stays the source of the code; La Fabrique orchestrates, shows and keeps the evidence.

The loop is the plan of one story in the generic mechanism of ADR 0006: its phases are capabilities, its breaks are stop points and *person* tasks, its budget is held by hooks.

### 1. One session, explicit phases

The project's `claude` workflow runs one Claude Code session per story (a job can last up to six hours), which goes through phases in order, and loops until it is green or a break stops it:

| Phase | What it does | Done when |
| --- | --- | --- |
| `plan` | Reads the story, its card's spec and the decisions it names; lists what it will change and the tests it will write | A plan, posted on the issue |
| `tests` | Writes the tests from the acceptance criteria, first (one test per criterion when it can be automated) | The new tests fail for the right reason |
| `code` | Writes the code | The project's checks pass (`typecheck`, `test`) |
| `review` | A sub-agent with a fresh context reviews the diff against the story, with the project's review settings (the `revue` block, F14) | No blocking finding |
| `fix` | Addresses the blocking findings, back to `code` | — |
| `verify` | End to end: the project's e2e suite, or the criteria played on a preview (int, a local server) | Each criterion has its evidence |
| `deliver` | Opens or updates the pull request: one line per criterion with its evidence, the loop's summary | The pull request is open |

`code → review → fix` loops at most `boucle.iterations` times (3 by default). The tester's feedback, the merge and the go stay outside the session, as today; a rework is the same loop started again on the same story, with the feedback as input.

### 2. The loop reports to La Fabrique

At each phase change, and at the end, the session reports an event to La Fabrique (`POST /api/projects/{project}/loops/{story}/events`, with the project's `FABRIQUE_TOKEN`, or the MCP tool `loop_report`): the phase, the iteration, the tests (passed, failed, new), the size of the diff, the review's findings, the tokens and the model (ADR 0004), and, when it stops, the break. La Fabrique keeps these events in its log, never the code nor the prompts. The full transcript stays with the project (ADR 0004).

### 3. Typed breaks: the loop stops, says why, and waits for someone

The session stops at a break, and La Fabrique sends it to the role that can unblock it:

| Break | Raised when | Goes to |
| --- | --- | --- |
| `decision` | The work needs a decision that would surprise the next reader: the agent writes an ADR, `Proposed` (ADR 0005), and stops | Its deciders |
| `spec` | A criterion is ambiguous, contradicts another, or the code shows the spec is wrong | The card's Product Engineer, as a question on the card (the questions Claude already asks while writing a spec) |
| `tests` | No green after `boucle.iterations`, or a test that passes and fails without change | Tech lead |
| `code` | The diff goes past `boucle.diff_max` lines, touches a protected path (`boucle.proteges`: workflows, migrations, secrets, `CLAUDE.md`), or the time or the cost goes past its limit | Tech lead |
| `review` | The review still blocks after `boucle.iterations` fixes | Tech lead |
| `quota` | The subscription's usage limit is reached (ADR 0004) | Nobody: it resumes when the window opens, or on the API if the project allows it |

The person's answer (a decision taken, a criterion rewritten, a go to continue) is recorded in La Fabrique's log, then given to the session that resumes the story. A break is never answered by the agent itself.

### 4. A dial set by the project

`.fabrique.json` > `boucle` says how far the loop goes alone, like Armagedon's "governance is a dial set by risk":

- **consumer projects** (L'épicerie, La Fabrique): a green loop without a break is merged into the integration branch by the project's merge workflow; the tester and the go stay with people;
- **regulated projects**: a person reviews every pull request, and the loop's events are kept as the evidence of the change (who launched it, which tests, which review, which decision).

### 5. One view of the cycle, from the epic to production

La Fabrique shows the cycle as one track, from the epic to production: epic → features (cards) → spec → stories → loop (its phases) → merged → on int → tested → go → in production. Each existing screen is a view on some of its stages (the card page on the spec, the sprint on the loop, To test on the test, Production on the go); the track says where each story of an epic is, what it waits for, and who. It is read from what La Fabrique already knows (`stageOf`, card progress) plus the loop's events.

### 6. Refactoring points

Refactoring is planned, not hoped for. La Fabrique proposes a refactoring card (behind the scenes, `coulisses`) when an indicator crosses its threshold: at a sprint's close, after N stories on the same component, or when a file, a function or the project's `CLAUDE.md` grows past a size the project sets. The card goes through the same loop, with one more rule: the behaviour does not change (existing tests unchanged and green, no public release note).

## Consequences

- The project's `claude` workflow changes the most: one longer session, a prompt by phase, sub-agents for the review, the events to La Fabrique. La Fabrique's own workflow is the first; L'épicerie's (with int as a safety net and its e2e suite) is the pilot.
- La Fabrique gains an endpoint (and an MCP tool) for the loop's events, a table for them, the breaks as tasks for a role, and the track view. The sprint's run waits on a loop's end rather than on a run's.
- What the loop decides alone is bounded by the dial, the breaks and the protected paths; nothing in it validates a story, gives the go, or merges into production.
- Measured against the current sprint's run on the pilot: time from ready to merged, share of stories sent back after test, breaks per story and their kind, cost per story.
- The events' vocabulary (story, phase, break, decision, validation) is the one BeExtraordinary/Armagedon-Project's software-factory pack can read as evidence later, without La Fabrique depending on it.
