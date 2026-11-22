# 0004. Agents are observed, counted and steered from La Fabrique: one queue, their logs, their tokens, their model

- Status: Accepted (validated by serge-fantino on 2026-11-22, by [a comment on #419](https://github.com/serge-fantino/la-fabrique/pull/419#issuecomment-7072674090))
- Date: 2026-11-21
- Deciders: serge-fantino
- Serves: epic F15 (C179, #410); C182, C183, C184, C187

## Context

Claude works for a project in two places:

- **in La Fabrique**, with La Fabrique's own API key: a card's spec, its split into stories, the review of its stories (`claude_jobs`, ADR 0001). Each call is counted in `llm_calls` (tokens, cost), per card, project and person;
- **in the project's runner**, with the project's secrets: the code of a story (`claude.yml`), a rework, an update, a review (`review.yml`), and soon the loop of ADR 0003. La Fabrique sees their runs (`claudeRuns`), their end, their pull request; not what they did, nor what they cost.

So there is no single place to see what the agents are doing across projects, what waits, what is stuck, and what it all costs. The model is set in two places (`CLAUDE_MODEL` for La Fabrique, the action's default for the workflows), the same for every task.

On cost, the owner's choice: the **Claude subscription** (`CLAUDE_CODE_OAUTH_TOKEN`) gives far more tokens for a fixed price than the API, so it stays the default for the workflows. A fixed price does not remove the need to count: the tokens say what a story, an epic or a project really takes, and what it would cost on the API.

## Decision

The objectives below are the capabilities of ADR 0006's catalogue, and a job is its request record.

### 1. Every agent task is a job of one queue, whatever its objective

La Fabrique keeps one record per agent task, of every kind, in one queue:

| Objective | Where it runs | Recorded today in |
| --- | --- | --- |
| `spec`, `split`, `stories_review` | La Fabrique (its key) | `claude_jobs` |
| `code`, `rework`, `update` (the loop, ADR 0003) | the project's runner | `claudeRuns` (read from GitHub) |
| `review` | the project's runner | the review workflow's runs |
| `refactor` | the project's runner | — (ADR 0003, § 6) |

Each job has: its objective, its project, its card or story, who launched it (or `la-fabrique` for the sprint's run), its state (`queued`, `running` with its phase, `waiting` at a break, `done`, `failed`, `cancelled`), its times, its model, its tokens and its cost. The jobs of the runner are created when La Fabrique launches the workflow, and completed by the loop's events and the `workflow_run` webhook.

### 2. A global *Agents* page

One page, for the tech leads and the super admin, across every project: the queue (what waits, and why: the project's cap, a card's lock, a quota), what runs (phase, iteration, time, tokens so far), what waits for someone (the breaks, with who), and what ended. Filters by project, objective, model, person. From it: cancel a queued job, resume a stopped one, open its log. The project's pages keep their own views (the card's job, the sprint's work in progress); they read the same records.

### 3. Logs: La Fabrique keeps the events, the project keeps the transcript

- **La Fabrique keeps** the structured events of each job (ADR 0003 § 2): phases, tests, findings, breaks, tokens. Never the code, the prompts, nor the model's text, as for `llm_calls` today.
- **The project keeps** the full transcript of each run (Claude Code's execution file, every message and tool call) as an artifact of its run, with the retention the project sets (90 days by default on GitHub; longer for a regulated project). La Fabrique reads it on demand, with the App's *Actions: read* permission, and shows it in the job's page without storing it.

So everything an agent did can be traced from La Fabrique, and the code and its context never leave the project's side (principle 3).

### 4. Tokens counted the same way everywhere, priced at the API's rates

Every job reports its usage per model: input tokens, cache writes, cache reads, output tokens (the fields of the API's `usage`, and of Claude Code's result, `modelUsage`). La Fabrique prices them with a table of the models' API rates kept in its code (updated with a release), and shows:

- the **real cost**: the API's for La Fabrique's key and for a project on the API; for the subscription, the fixed price, nothing per job;
- the **API-equivalent cost**, for every job: what it would have cost on the API. It is what lets a story, a card, an epic or a project be compared, and the subscription's worth be measured.

Totals per job, card, epic, story, project, person, model and objective, by day and by month; the cache's share (reads against input) says whether the prompts are built to be cached.

### 5. The budget, managed globally

- La Fabrique's own key keeps its limits (`CLAUDE_DAILY_CALLS`, `CLAUDE_MONTHLY_BUDGET_USD`).
- A project declares in `.fabrique.json` > `claude` its credentials' kind (`abonnement` or `api`), and a monthly budget in API-equivalent dollars; past 80 %, La Fabrique warns; past 100 %, it launches nothing new on that project without a tech lead's go.
- On the subscription, a run that meets the usage limit stops with the `quota` break (ADR 0003): the job waits and resumes when the window opens, or goes to the API when the project allows it (`claude.debordement: "api"`).
- Before relying on the subscription for unattended runs at volume, check the plan's terms and limits for that use; the API remains the route that needs no such check.

### 6. The model: a default, per objective, and rules to change it

- `.fabrique.json` > `claude.modeles` sets the model per objective, and a default; La Fabrique's own jobs keep `CLAUDE_MODEL` as their default.
- A **ladder**, from the lightest to the most capable: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-2` (the project may shorten it). Suggested defaults: Sonnet for `code`, `update` and `review`; Opus for `spec`, `split` and `plan`; Haiku for mechanical work (release notes, a conflict in a generated file).
- **Rules** move a job up or down the ladder, declared in `claude.regles` and applied by La Fabrique when it launches or resumes a job:
  - up one step after a `tests` or `review` break, or a second rework on the same story;
  - up one step for a story whose card is marked complex, or that touches a protected path;
  - down one step for an `update` with no conflict;
  - never above the project's ceiling (`claude.plafond_modele`).
- A model changes **between phases or jobs, never inside one**: the cache belongs to a model, and a change in the middle loses it. Before adding a step to the ladder, try the same model at a higher effort (`effort`), which keeps the cache.
- Each change is logged with its rule, and shown in the job.

## Consequences

- A migration: one `agent_jobs` table (and its events), into which `claude_jobs` and `llm_calls` are folded or linked; the runner's jobs created at launch.
- The project's `claude` and `review` workflows upload their execution file as an artifact and report their usage; La Fabrique's own workflows first.
- A price table of the models in La Fabrique's code, with a test that every model a project may declare has its price.
- `.fabrique.json` gains `claude.abonnement`/`api`, `claude.budget`, `claude.modeles`, `claude.regles`, `claude.plafond_modele`, `claude.debordement` (format in `docs/fabrique-json.md`, in French).
- The *Agents* page is the first place to look when something is slow or costs too much; the project's Setup shows its own share.
