import { DurableObject } from "cloudflare:workers";
import { activityStatement } from "./activity-log";
import { isNice, storyCards, type StoryCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import { listCards, type Card } from "./cards";
import { claudeCap, claudeRuns, claudeWorkflow, isRunning, launchClaude, updateWithClaude, type ClaudeRun } from "./claude";
import type { Env } from "./env";
import { sprintLiveFor } from "./live";
import { findProject, type Project } from "./projects";
import { lastMergeAttempts, mergePull, mergeWorkflow, pullDetails } from "./sprint-pulls";
import { activeSprint } from "./sprints";
import { storiesChanged } from "./stories";
import { isDeveloped, isInDevelopment, isReadyStage } from "./lifecycle";

// The sprint runs by itself (la-fabrique#160, #161): for each card in the
// sprint's order, its stories one after another (launch Claude, wait for
// its run, merge its pull request, wait for the merge, then the next
// story), several cards at once within `claude.plafond`, one merge at a
// time. One Durable Object per project holds the run and takes GitHub's
// events one at a time; an alarm catches up what a lost webhook would
// have said. It only starts the project's own workflows (principle 3):
// it never writes code nor merges itself. A card that meets a problem
// stops and says why; the others go on.

export type CardStep = "next" | "claude" | "merging" | "updating" | "done" | "stopped";

export interface RunCard {
  id: number;
  title: string;
  stories: number[];
  // The story at work: its rank in `stories`.
  at: number;
  step: CardStep;
  // The pull request being merged, and since when the step runs.
  pull: number | null;
  since: string | null;
  // Claude runs spent on the current story, and whether it was updated once.
  runs: number;
  updated: boolean;
  // Why it stopped, or what it waits for, with a link.
  reason: string | null;
  note: string | null;
  link: string | null;
}

export interface RunState {
  repo: string;
  startedBy: string;
  startedAt: string;
  status: "running" | "paused" | "stopped" | "done" | "waiting";
  cards: RunCard[];
}

export const RUNS_PER_STORY = 2;
const STUCK_MS = 70 * 60_000;
const NOT_STARTED_MS = 15 * 60_000;
const MERGE_MS = 40 * 60_000;
export const ALARM_MS = 4 * 60_000;

// ---- The plan ----------------------------------------------------------------

export interface PlannedStory {
  number: number;
  title: string;
  nice: boolean;
  // done: merged or closed; merge: its pull request is open; launch: ready;
  // stop: the card stops there (why); after: behind a stop.
  plan: "done" | "merge" | "launch" | "stop" | "after";
  why: string | null;
}

export interface PlannedCard {
  card: Card;
  stories: PlannedStory[];
}

// Merged already, for the run: developed (src/lifecycle.ts), however its
// pull request is linked.
const merged = (story: CardStory | undefined) => isDeveloped(story);

// The stories of a card, in its order, nice to have last.
export function storiesInOrder(links: StoryCards, card: number): number[] {
  const order = links.order.get(card) ?? [];
  return [...order.filter((number) => !isNice(links, card, number)), ...order.filter((number) => isNice(links, card, number))];
}

// What a run would do, card by card, before it starts.
export function planRun(cards: Card[], links: StoryCards, stories: Map<number, CardStory>): PlannedCard[] {
  return cards.map((card) => {
    let stopped = false;
    const planned = storiesInOrder(links, card.id).map((number): PlannedStory => {
      const story = stories.get(number);
      const base = { number, title: story?.title ?? `#${number}`, nice: isNice(links, card.id, number) };
      if (merged(story)) return { ...base, plan: "done", why: null };
      if (stopped) return { ...base, plan: "after", why: null };
      if (isInDevelopment(story) && openPull(story)) return { ...base, plan: "merge", why: null };
      if (isReadyStage(story)) return { ...base, plan: "launch", why: null };
      stopped = true;
      return { ...base, plan: "stop", why: notLaunchable(story) };
    });
    return { card, stories: planned };
  });
}

// The plan in lanes (la-fabrique#188): the run works on at most `cap`
// cards at once (one Claude run each); a lane takes the next card, in the
// sprint's order, when its card is done. Each card goes to the lane with
// the least work so far (its stories to launch or merge), as the run would
// roughly do. The cards with nothing to run are left out, with why.
export interface RunLanes {
  lanes: PlannedCard[][];
  idle: { planned: PlannedCard; why: string }[];
}

const work = (planned: PlannedCard) => planned.stories.filter((story) => story.plan === "launch" || story.plan === "merge").length;

export function runLanes(plan: PlannedCard[], cap: number): RunLanes {
  const lanes: PlannedCard[][] = [];
  const load: number[] = [];
  const idle: RunLanes["idle"] = [];
  for (const planned of plan) {
    if (!planned.stories.length) continue;
    if (!work(planned)) {
      const stop = planned.stories.find((story) => story.plan === "stop");
      idle.push({ planned, why: stop ? `stops at #${stop.number}: ${stop.why ?? "not ready"}` : "every story is merged" });
      continue;
    }
    if (lanes.length < Math.max(1, cap)) {
      lanes.push([planned]);
      load.push(work(planned));
      continue;
    }
    const lightest = load.indexOf(Math.min(...load));
    lanes[lightest]?.push(planned);
    load[lightest] = (load[lightest] ?? 0) + work(planned);
  }
  return { lanes, idle };
}

export function newRun(repo: string, login: string, plan: PlannedCard[], now: string): RunState {
  return {
    repo,
    startedBy: login,
    startedAt: now,
    status: "running",
    cards: plan
      .filter((planned) => planned.stories.some((story) => story.plan !== "done"))
      .map((planned) => ({
        id: planned.card.id,
        title: planned.card.title,
        stories: planned.stories.map((story) => story.number),
        at: 0,
        step: "next",
        pull: null,
        since: null,
        runs: 0,
        updated: false,
        reason: null,
        note: null,
        link: null,
      })),
  };
}

// ---- Moving on ---------------------------------------------------------------

export interface Moves {
  launch: (story: number) => Promise<{ ok: true } | { ok: false; message: string; wait: boolean }>;
  update: (story: number, pull: number) => Promise<{ ok: true } | { ok: false; message: string; wait: boolean }>;
  merge: (pull: number) => Promise<{ ok: true } | { ok: false; message: string }>;
  log: (action: string, details: Record<string, unknown>, issue?: number) => Promise<void>;
}

export interface Seen {
  stories: Map<number, CardStory>;
  runs: ClaudeRun[];
  // The pull requests in a merge, as GitHub has them now.
  pulls: Map<number, { state: "open" | "closed" | "merged" }>;
  // The last merge run of each pull request (from the log): when and how.
  merges: Map<number, { conclusion: string | null; reason: string | null; url: string | null; at: string }>;
  cap: number;
  now: string;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : 0);

function runOf(seen: Seen, story: number, since: string | null): ClaudeRun | null {
  // Runs are newest first; one dispatched a moment before the step's time
  // is still its own (GitHub's clock and ours).
  return seen.runs.find((run) => run.issue === story && ms(run.createdAt) >= ms(since) - 120_000) ?? null;
}

function openPull(story: CardStory | undefined): number | null {
  return story?.pulls.find((pull) => pull.state === "open")?.number ?? null;
}

// Why Claude is not launched on a story, from its stage, said as it is.
function notLaunchable(story: CardStory | undefined): string {
  if (!story) return "not read on GitHub yet";
  if (story.stage === "backlog") return `not ready${story.missing.length ? `: it lacks ${story.missing.join(", ")}` : ""}`;
  if (isInDevelopment(story)) return "in development by hand (a branch without a pull request): finish it or drop the branch";
  return `at the stage ${story.stage ?? "unknown"}, not ready`;
}

// One pass over the run: each card moves as far as it can. Pure but for
// the moves (dispatches and the log), so it can be tried with fakes.
export async function advance(state: RunState, seen: Seen, moves: Moves): Promise<RunState> {
  if (state.status !== "running") return state;
  let claudeBusy = seen.runs.filter(isRunning).length;
  const merging = () => state.cards.some((card) => card.step === "merging");
  const stop = async (card: RunCard, reason: string, link: string | null = null) => {
    card.step = "stopped";
    card.reason = reason;
    card.link = link;
    card.note = null;
    await moves.log("sprint_run_card_stopped", { card: card.id, title: card.title, story: card.stories[card.at] ?? null, reason, link });
  };
  const nextStory = (card: RunCard) => {
    card.at += 1;
    card.step = "next";
    card.pull = null;
    card.since = null;
    card.runs = 0;
    card.updated = false;
    card.note = null;
    card.link = null;
  };
  const startMerge = async (card: RunCard, pull: number) => {
    if (merging()) {
      card.note = `waits for the merge in progress (one at a time) before merging #${pull}`;
      return false;
    }
    const outcome = await moves.merge(pull);
    if (!outcome.ok) {
      await stop(card, `the merge of #${pull} could not start: ${outcome.message}`);
      return true;
    }
    card.step = "merging";
    card.pull = pull;
    card.since = seen.now;
    card.note = null;
    return true;
  };

  for (const card of state.cards) {
    // A few moves per pass: a merged story goes straight to the next.
    for (let guard = 0; guard < 6; guard++) {
      if (card.step === "done" || card.step === "stopped") break;
      const number = card.stories[card.at];
      if (number === undefined) {
        card.step = "done";
        card.note = null;
        await moves.log("sprint_run_card_done", { card: card.id, title: card.title });
        break;
      }
      const story = seen.stories.get(number);

      if (card.step === "next") {
        if (merged(story)) {
          nextStory(card);
          continue;
        }
        const running = seen.runs.find((run) => run.issue === number && isRunning(run));
        if (running) {
          // Claude already works on it (launched by hand): followed.
          card.step = "claude";
          card.since = running.createdAt;
          card.note = null;
          break;
        }
        const pull = openPull(story);
        if (pull) {
          if (!(await startMerge(card, pull))) break;
          continue;
        }
        if (!isReadyStage(story)) {
          await stop(card, `#${number} is ${notLaunchable(story)}`);
          break;
        }
        if (card.runs >= RUNS_PER_STORY) {
          await stop(card, `#${number} has had ${card.runs} Claude runs without a pull request to merge`);
          break;
        }
        if (claudeBusy >= seen.cap) {
          card.note = `waits for a free Claude run (at most ${seen.cap} at once)`;
          break;
        }
        const outcome = await moves.launch(number);
        if (!outcome.ok) {
          if (outcome.wait) card.note = outcome.message;
          else await stop(card, `Claude could not be launched on #${number}: ${outcome.message}`);
          break;
        }
        claudeBusy += 1;
        card.step = "claude";
        card.since = seen.now;
        card.runs += 1;
        card.note = null;
        await moves.log("sprint_run_story_started", { card: card.id, story: number }, number);
        break;
      }

      if (card.step === "claude" || card.step === "updating") {
        const run = runOf(seen, number, card.since);
        if (!run) {
          if (ms(seen.now) - ms(card.since) > NOT_STARTED_MS) await stop(card, `the Claude workflow did not start on #${number}`);
          break;
        }
        if (isRunning(run)) {
          if (ms(seen.now) - ms(run.createdAt) > STUCK_MS) await stop(card, `Claude's run on #${number} has gone on for more than 70 minutes`, run.url);
          break;
        }
        if (run.conclusion !== "success") {
          await stop(card, `Claude's run on #${number} ${run.conclusion === "cancelled" ? "was cancelled" : "failed"}`, run.url);
          break;
        }
        if (card.step === "updating" && card.pull) {
          if (!(await startMerge(card, card.pull))) break;
          continue;
        }
        const pull = openPull(story);
        if (!pull) {
          await stop(card, `Claude's run on #${number} ended without a pull request: it may have asked a question on the issue`, run.url);
          break;
        }
        if (!(await startMerge(card, pull))) {
          card.step = "next";
          break;
        }
        continue;
      }

      if (card.step === "merging" && card.pull) {
        const pull = seen.pulls.get(card.pull);
        if (pull?.state === "merged") {
          await moves.log("sprint_run_story_merged", { card: card.id, story: number, pull: card.pull }, number);
          nextStory(card);
          continue;
        }
        if (pull?.state === "closed") {
          await stop(card, `pull request #${card.pull} was closed without being merged`);
          break;
        }
        const attempt = seen.merges.get(card.pull);
        if (attempt && ms(attempt.at) >= ms(card.since) - 60_000 && attempt.conclusion && attempt.conclusion !== "success") {
          const reason = attempt.reason ?? "the merge workflow stopped";
          if (/conflict/i.test(reason) && !card.updated && card.runs < RUNS_PER_STORY && claudeBusy < seen.cap) {
            const outcome = await moves.update(number, card.pull);
            if (outcome.ok) {
              claudeBusy += 1;
              card.step = "updating";
              card.since = seen.now;
              card.updated = true;
              card.runs += 1;
              card.note = null;
              await moves.log("sprint_run_story_updating", { card: card.id, story: number, pull: card.pull }, number);
              break;
            }
            if (!outcome.wait) await stop(card, `the merge of #${card.pull} was refused (${reason}), and Claude could not update it: ${outcome.message}`, attempt.url);
            else card.note = outcome.message;
            break;
          }
          await stop(card, `the merge of #${card.pull} was refused: ${reason}`, attempt.url);
          break;
        }
        if (ms(seen.now) - ms(card.since) > MERGE_MS) await stop(card, `the merge of #${card.pull} did not finish in 40 minutes`);
        break;
      }
      break;
    }
  }
  const active = state.cards.some((card) => card.step !== "done" && card.step !== "stopped");
  if (!active) {
    state.status = state.cards.every((card) => card.step === "done") ? "done" : "waiting";
    await moves.log(state.status === "done" ? "sprint_run_done" : "sprint_run_waiting", { stopped: state.cards.filter((card) => card.step === "stopped").map((card) => card.id) });
  }
  return state;
}

// ---- With GitHub -----------------------------------------------------------

async function seenOnGitHub(env: Env, project: Project, state: RunState, refresh: boolean): Promise<Seen> {
  if (refresh) await storiesChanged(env, project.repo);
  await env.DB.prepare("DELETE FROM snapshots WHERE repo = ? AND kind = 'claude_runs'").bind(project.repo).run();
  const numbers = [...new Set(state.cards.flatMap((card) => card.stories))];
  const merging = state.cards.filter((card) => card.step === "merging" && card.pull).map((card) => card.pull as number);
  const [stories, runs, pulls, merges] = await Promise.all([
    cardStories(env, project, numbers),
    claudeRuns(env, project),
    pullDetails(env, project, merging),
    lastMergeAttempts(env.DB, project.repo),
  ]);
  return { stories, runs, pulls, merges, cap: claudeCap(project), now: new Date().toISOString() };
}

function movesOnGitHub(env: Env, project: Project, state: RunState): Moves {
  const wait = (status: number) => status === 409;
  return {
    async launch(story) {
      const outcome = await launchClaude(env, project, state.startedBy, story);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, wait: wait(outcome.status) };
    },
    async update(story, pull) {
      const outcome = await updateWithClaude(env, project, state.startedBy, story, pull);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, wait: wait(outcome.status) };
    },
    async merge(pull) {
      const outcome = await mergePull(env, project, state.startedBy, pull);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
    },
    async log(action, details, issue) {
      await activityStatement(env.DB, { actor: "la-fabrique", action, repo: project.repo, ...(issue ? { issueNumber: issue } : {}), details: { ...details, run_by: state.startedBy } }).run();
    },
  };
}

// Why the sprint cannot run by itself on this project, or null.
export function runRefusal(project: Project): string | null {
  if (!claudeWorkflow(project)) return "The project declares no Claude workflow (workflows.claude).";
  if (!mergeWorkflow(project)) return "The project declares no merge workflow (workflows.fusionner): the run merges each story through it.";
  return null;
}

export async function loadPlan(env: Env, project: Project): Promise<{ plan: PlannedCard[]; running: boolean }> {
  const sprint = await activeSprint(env.DB, project.repo);
  if (!sprint) return { plan: [], running: false };
  const [cards, links] = await Promise.all([listCards(env.DB, project.repo), storyCards(env.DB, project.repo)]);
  const inSprint = cards.filter((card) => card.release === sprint.release && !card.archivedAt).sort((a, b) => a.position - b.position || a.id - b.id);
  const stories = await cardStories(env, project, [...new Set(inSprint.flatMap((card) => links.order.get(card.id) ?? []))]);
  return { plan: planRun(inSprint, links, stories), running: true };
}

// ---- The object --------------------------------------------------------------

const KEY = "run";

export class SprintRun extends DurableObject<Env> {
  // GitHub's events may come together: one pass at a time.
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async state(): Promise<RunState | null> {
    return (await this.ctx.storage.get<RunState>(KEY)) ?? null;
  }

  private async save(state: RunState): Promise<void> {
    await this.ctx.storage.put(KEY, state);
    if (state.status === "running") await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  private async pass(state: RunState, refresh: boolean): Promise<RunState> {
    const project = await findProject(this.env.DB, state.repo);
    if (!project) return state;
    const seen = await seenOnGitHub(this.env, project, state, refresh);
    const moved = await advance(state, seen, movesOnGitHub(this.env, project, state));
    await this.save(moved);
    await sprintLiveFor(this.env, state.repo)?.notify({ kind: "pull_request", issue: null, status: "run", conclusion: null, url: "", at: new Date().toISOString() });
    return moved;
  }

  async start(state: RunState): Promise<RunState> {
    return this.serial(async () => {
      const current = await this.state();
      if (current && (current.status === "running" || current.status === "paused")) return current;
      await activityStatement(this.env.DB, { actor: state.startedBy, action: "sprint_run_started", repo: state.repo, details: { cards: state.cards.map((card) => card.id) } }).run();
      return this.pass(state, false);
    });
  }

  // A webhook (a run or a merge ended, a pull request moved): move on.
  async poke(): Promise<void> {
    await this.serial(async () => {
      const state = await this.state();
      if (state?.status === "running") await this.pass(state, false);
    });
  }

  override async alarm(): Promise<void> {
    await this.serial(async () => {
      const state = await this.state();
      if (state?.status === "running") await this.pass(state, true);
    });
  }

  async control(login: string, what: "pause" | "resume" | "stop" | "resume_card", card?: number): Promise<RunState | null> {
    return this.serial(async () => {
      const state = await this.state();
      if (!state) return null;
      if (what === "pause" && state.status === "running") state.status = "paused";
      else if (what === "stop" && state.status !== "stopped" && state.status !== "done") state.status = "stopped";
      else if (what === "resume" && (state.status === "paused" || state.status === "waiting")) state.status = "running";
      else if (what === "resume_card") {
        const found = state.cards.find((candidate) => candidate.id === card && candidate.step === "stopped");
        if (!found || state.status === "stopped" || state.status === "done") return state;
        Object.assign(found, { step: "next", reason: null, link: null, note: null, runs: 0, updated: false, pull: null, since: null });
        if (state.status === "waiting") state.status = "running";
      } else return state;
      await activityStatement(this.env.DB, {
        actor: login,
        action: what === "resume_card" ? "sprint_run_card_resumed" : `sprint_run_${what === "pause" ? "paused" : what === "stop" ? "stopped" : "resumed"}`,
        repo: state.repo,
        details: what === "resume_card" ? { card } : {},
      }).run();
      if (state.status === "running") return this.pass(state, true);
      await this.save(state);
      await sprintLiveFor(this.env, state.repo)?.notify({ kind: "pull_request", issue: null, status: "run", conclusion: null, url: "", at: new Date().toISOString() });
      return state;
    });
  }

  // A new sprint, or a run over: forgotten.
  async clear(): Promise<void> {
    await this.serial(async () => {
      await this.ctx.storage.deleteAll();
    });
  }
}

export function sprintRunFor(env: Env, repo: string): DurableObjectStub<SprintRun> | null {
  return env.SPRINT_RUN ? env.SPRINT_RUN.get(env.SPRINT_RUN.idFromName(`run:${repo.toLowerCase()}`)) : null;
}
