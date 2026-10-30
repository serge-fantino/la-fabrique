# 0001 · Claude works in the background

October 30, 2026 · decided by the owner · epic #74

## Context

On a card, Claude writes and revises the functional spec (La Fabrique's own Anthropic API key, `src/llm.ts`, `src/specs.ts`). A call takes 20 to 60 seconds.

Until 0.47 the call ran inside the browser's request: the Worker waited for Anthropic, then answered the page. Waiting costs almost no CPU, so Cloudflare's limits (10 ms of CPU on the free plan, 30 s by default on the paid one) were never the problem; the connection was. When the person left the page, Cloudflare ended the request, and Claude's call with it: no spec, the person's answers lost, the call perhaps billed anyway. `ctx.waitUntil` only adds about 30 seconds after the response. Nothing showed what Claude was doing meanwhile.

We wanted:

- nothing lost when the page is left or closed;
- what Claude is doing, as it goes (a widget, its log);
- that progress pushed to the page, not asked for every few seconds;
- tries again when Anthropic is busy, without the person sending again.

## Options

| | Survives leaving the page | Live progress | To set up | Tests |
|---|---|---|---|---|
| A. As before, a timer on the page | no | no | nothing | nothing |
| B. Stream Claude's answer to the page | no | yes | nothing | simple |
| C. Cloudflare Workflows | yes | through a store | a binding, created on deploy | needs a newer test pool |
| D. Cloudflare Queues | yes | through a store | a queue, created once | supported |

And to push the progress: polling the job (rejected: a request every two seconds per open page), Server-Sent Events from the Worker (it would itself have to poll the store), or a Durable Object per card holding the pages' WebSockets, told by the job at each step.

## Decision

- **Cloudflare Queues** (D). Our jobs are one call to Claude each (write, revise, later split into stories); Workflows' remembered steps add nothing yet. Creating the GitHub issues stays in the request: it follows a preview, takes a second or two, and needs no background.
- **A Durable Object per card** (`CardLive`) holds the WebSockets of the pages open on the card, asleep between two events (hibernation: an open page costs nothing while it waits). The job tells it each step; it pushes it to the pages.

## How it works

1. **Asking** (`POST /cards/{id}`): the request and the person's answers are saved as a job (`claude_jobs`, `queued`) and its id is put on the queue `la-fabrique-claude`. The page comes back at once. One job at a time per card; the rights and quotas are checked before.
2. **Running** (`queue()` in `src/index.ts`, `runJob` in `src/jobs.ts`): the consumer marks the job `running`, calls Claude in streaming mode, and writes its log in `claude_job_events` (what it reads, summaries of its thinking every few seconds at most, each section as it starts, the questions, the cost). Each line is also pushed to the card's `CardLive`. At the end the spec is saved as a new version of the card, and the job is `done`.
3. **Failing**: when Anthropic is busy or unreachable, the job goes back to `queued` and the message is retried 30 seconds later, three attempts in all; then the job is `failed`, with the reason. A refusal or a wrong key fails at once. The request stays with the job: **Try again** sends it again. A job still running after 15 minutes is taken as stopped.
4. **Seeing** (`/fabrique.js`): the card's page shows the job as it was when read (label, sent answers, log). With the script it opens `wss://…/cards/{id}/live` (same session checks as the page), updates the label and the log, counts the time itself, and reloads when the job ends. The board marks the cards where Claude is working.

Settings: `max_batch_size` 1, `max_concurrency` 2 (at most two calls at once, whatever the number of people), `max_retries` 3, `retry_delay` 30 s.

## Consequences

- The deploy workflow creates the queue when missing; the Cloudflare token needs *Queues → Edit* (`docs/owner-setup.md`). The Durable Object is created by the deploy (migration `v1` in `wrangler.jsonc`).
- A message can be delivered twice: `runJob` does nothing for a job already `done` or `failed`.
- Tests run the consumer themselves (`worker.queue` with `createMessageBatch`); the queue delivers nothing on its own during a test (`vitest.config.ts`).
- Later: a page of all jobs, and notifications when a job ends elsewhere (Web Push, as in L'épicerie): another story.
