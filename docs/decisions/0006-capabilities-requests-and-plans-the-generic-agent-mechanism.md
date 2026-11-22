# 0006. Capabilities, requests and plans: one generic mechanism for every agent task, taken from LimaLibri

- Status: Accepted (validated by serge-fantino on 2026-11-22, by [a comment on #419](https://github.com/serge-fantino/la-fabrique/pull/419#issuecomment-7072674090))
- Date: 2026-11-21
- Deciders: serge-fantino
- Serves: epic F15 (C179, #410); C190

## Context

ADR 0003 (the loop of a story) and ADR 0004 (agents observed, counted, steered) each describe a piece: phases, breaks, a queue, tokens, a model per objective. Each existing agent task in La Fabrique is still built on its own: the spec of a card, its split into stories, the review of its stories, the code of a story, a rework, an update, a review of a pull request. Each has its own record, its own way to end, its own screen to decide.

serge-fantino/limalibri (a book-writing workshop where Claude proposes and the author keeps) solved this with one mechanism that every kind of request goes through:

- **a catalogue of capabilities** (`capacites.py`): everything one can ask, each with its label, what it does, typed parameters checked against the work (a chapter, a card), a *genre* that sets its budget and model, **how it ends**, and the **artefacts** it writes, at the answer and at the decision. A work (a book) declares capabilities of its own, as configuration that composes the tool's primitives (`capacites.yaml`), not code;
- **one request record** (`reecriture.py`): the target and its state when asked (so a decision on something that changed since is refused), the **exact context** the model received, its **proposals** (a structured output, by a schema), and the **decision** (the proposal kept, or none, with the reason; rejections are kept: they say what the author does not want);
- **four ways to end**: *decision* (proposals wait for the author), *pose* (written into the work at once, the previous version archived and restorable), *lecture* (a report), *auteur* (a task only a person can do, which the plan waits on);
- **a budget per genre**, held by a hook before each tool (turns, web searches, pages read): past it, the tool is refused and the model is told to conclude with what it has;
- **one queue** (`file.py`): a number at once, in order, waiting for the author's go or chained on its own; *lots* (a plan's phase, a series) that chain as a block; the context compiled when the request starts, not when it is queued; it survives a restart;
- **filiation** (`filiation.py`): a request born of another carries its origin and generation; caps on depth and children keep agents from growing an endless tree of work;
- **plans with stop points** (`cadrage.py`, `pilotage.py`): an objective (criteria, budget) → Claude proposes a plan in phases made only of catalogue capabilities, with their parameters, why, and dependencies, and a stop point per phase; a harness checks it (known capabilities, valid parameters, no cycle, estimated cost against the budget, every criterion covered); the author keeps it; then it runs, action by action, stopping where the author must decide;
- **gates** (`harnais.py`): what a version must pass before it is validated; each gate says ok or not, its findings and where; validating past a blocking gate needs a reason;
- **one consumption log** (`consommation.jsonl`): one line per execution, never rewritten, tokens per model (input, output, cache writes, cache reads), cost at the API's rate.

It is the generic mechanism La Fabrique needs, and the one BeExtraordinary/Armagedon-Project will generalise further (a capability as a command, a plan as a process, a decision as a task, the log as events).

## Decision

**Every agent task in La Fabrique is a request for a capability of one catalogue, recorded the same way, ending one of four ways, run through one queue, and composed into plans with stop points.**

1. **The catalogue.** La Fabrique declares its capabilities in code, each with: an id, a label, what it does, its parameters (typed: card, story, epic, pull request, decision, text; checked against the project), its genre (budget and model, ADR 0004 § 6), where it runs (La Fabrique, or the project's runner), how it ends, its artefacts (what it writes, at the answer and at the decision), and who may launch it (a right of `src/rights.ts`). First entries: `spec`, `split`, `stories_review` (in La Fabrique); `story_loop`, `rework`, `update`, `review`, `refactor` (in the runner); `decision` and `person` (a person's task). The catalogue is a page of La Fabrique (what can be asked, what it costs on this project) and the only vocabulary of plans and of the MCP's launches.
2. **Project capabilities.** A project declares its own in `.fabrique.json` > `capacites`, composing La Fabrique's primitives (a workflow of the project with its inputs, a prompt added to a primitive, a budget); an error in them is said and the capability left out, never breaking the rest.
3. **The request record** (the `agent_jobs` of ADR 0004, made general): the capability and its parameters; the target and its state when asked (a card's revision, a pull request's head commit); the context sent (for La Fabrique's own calls: kept as it is now for `llm_calls`, a digest and the parts La Fabrique compiled, never a project's code; for the runner: in the run's transcript, ADR 0004 § 3); the proposals, by the capability's schema; the decision (kept, rejected, partly kept), by whom, when, with the reason. A decision on a target that changed since is refused ("the card changed since the request"), or, where La Fabrique already lets a person go on after a warning (the stories and features previews say the spec changed since the proposal), recorded as decided on a changed target (`outdated`). Rejections are kept, and given to the next request of the same capability on the same target.
4. **Four ways to end**, the same everywhere: *decision* (proposals wait for a person: a split, a story review, a proposed ADR), *pose* (written at once: a pull request opened, a spec version; git or the card's revisions are the archive), *report* (a review, a reading), *person* (a task a person marks done: answer a break, give the go). The *Agents* page (ADR 0004 § 2) lists what waits for whom by these four.
5. **Budgets held by hooks.** Each genre has its budget (turns, time, tokens, tool calls), set per project; in La Fabrique's own calls and in the runner's Claude Code, a hook before each tool refuses past the budget and tells Claude to conclude. Reaching it is the `code` break of ADR 0003, with what was done.
6. **One queue** (ADR 0004 § 1): per project, a number at once (`claude.plafond`), in order; chained on its own or waiting for a go, by capability; *lots* (a plan's phase, the sprint's run) chain as a block; the context is compiled when the request starts.
7. **Filiation.** A request born of another (the stories a split proposes, the refactoring a loop proposes, the decision a loop needs) carries its origin and generation; `claude.filiation` caps depth (2) and children (4); what a person launches starts again at generation 0.
8. **Plans with stop points.** An epic (or any objective with criteria) can be framed by Claude into a plan: phases of catalogue capabilities with parameters, why and dependencies, a stop point per phase, an estimated cost. La Fabrique checks the plan (capabilities known, parameters valid, no cycle, cost against the project's budget, each criterion covered) before showing it; a person keeps it, then it runs (the sprint's run, F5.8, becomes one plan among others). The loop of a story (ADR 0003) is the plan of one story: its phases are this mechanism's.
9. **Gates.** A story's *Definition of Done* is a list of gates (checks green, each criterion with its evidence, review without a blocking finding, release note, decisions accepted); each says ok or not and where; validating past a blocking gate needs a reason, logged.

## Consequences

- One table, one log, one way to decide: the card's spec, the split preview, the stories review and the loop's breaks become four screens of the same record, and the *Agents* page reads them all.
- A new kind of agent task is an entry in the catalogue (or a project's `capacites`), not a new mechanism.
- The record and the consumption lines use LimaLibri's fields (tokens per model: input, output, cache writes, cache reads; cost at the API's rate), so the three tools speak the same language.
- Built in order: the catalogue and the record (with spec, split and stories review moved onto it), the queue and budgets, the four endings in the *Agents* page, then plans; project capabilities last, once two projects need one (Armagedon's rule: extract when two consumers need it).
- Armagedon generalises it: a capability is a command, a plan a process with its stop points as user tasks, a decision a task's answer, the log its event store; La Fabrique stays the light version, without an ontology.
