import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { StoryCards } from "../src/card-groups";
import type { CardStory } from "../src/card-stories";
import type { ClaudeRun } from "../src/claude";
import { advance, planRun, type Moves, type RunState, type Seen } from "../src/sprint-run";
import type { Card } from "../src/cards";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const NOW = "2026-11-01T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

function story(number: number, extra: Partial<CardStory> = {}): CardStory {
  return { number, title: `Story ${number}`, stage: "ready", closed: false, criteria: [{ text: "Works", done: false }], priority: null, missing: [], pulls: [], ...extra };
}

function run(issue: number, status: string, conclusion: string | null, at = NOW): ClaudeRun {
  return { issue, status, conclusion, url: `https://github.com/run/${issue}`, createdAt: at, updatedAt: at };
}

function card(id: number, stories: number[]) {
  return { id, title: `Card ${id}`, stories, at: 0, step: "next" as const, pull: null, since: null, runs: 0, updated: false, reason: null, note: null, link: null };
}

function state(cards: ReturnType<typeof card>[]): RunState {
  return { repo: "acme/widget", startedBy: "pe", startedAt: NOW, status: "running", cards };
}

function seen(stories: CardStory[], runs: ClaudeRun[] = [], extra: Partial<Seen> = {}): Seen {
  return { stories: new Map(stories.map((one) => [one.number, one])), runs, pulls: new Map(), merges: new Map(), cap: 2, now: NOW, ...extra };
}

// The moves, recorded instead of sent to GitHub.
function fakeMoves(refuse: Partial<Record<"launch" | "update" | "merge", string>> = {}) {
  const done: string[] = [];
  const logged: { action: string; details: Record<string, unknown> }[] = [];
  const moves: Moves = {
    async launch(number) {
      done.push(`launch #${number}`);
      return refuse.launch ? { ok: false, message: refuse.launch, wait: false } : { ok: true };
    },
    async update(number, pull) {
      done.push(`update #${number} #${pull}`);
      return refuse.update ? { ok: false, message: refuse.update, wait: false } : { ok: true };
    },
    async merge(pull) {
      done.push(`merge #${pull}`);
      return refuse.merge ? { ok: false, message: refuse.merge } : { ok: true };
    },
    async log(action, details) {
      logged.push({ action, details });
    },
  };
  return { moves, done, logged };
}

describe("The sprint's run, card by card", () => {
  it("plans each card's stories in order, nice to have last, and says where a card would stop", () => {
    const links: StoryCards = { cards: new Map(), byStory: new Map(), order: new Map([[1, [10, 11, 12, 13, 14]]]), nice: new Set(["1:10"]) };
    const plan = planRun([{ id: 1, title: "Menu" } as Card], links, new Map([
      [10, story(10)],
      [11, story(11, { stage: "to_validate", pulls: [{ number: 30, url: "x", state: "merged" }] })],
      [12, story(12, { pulls: [{ number: 31, url: "x", state: "open" }], stage: "in_dev" })],
      [13, story(13, { stage: "backlog", missing: ["acceptance criteria"] })],
      [14, story(14)],
    ]));
    // A story merged through a pull request linked by its text only (as
    // "Refs #159"), to validate or on int: merged for the run.
    const guessed = planRun([{ id: 2, title: "Run" } as Card], { ...links, order: new Map([[2, [20, 21, 22]]]), nice: new Set() }, new Map([
      [20, story(20, { stage: "to_validate", pulls: [{ number: 40, url: "x", state: "merged", guessed: true }] })],
      [21, story(21, { stage: "on_int" })],
      [22, story(22)],
    ]));
    expect(guessed[0]?.stories.map((one) => one.plan)).toEqual(["done", "done", "launch"]);
    expect(plan[0]?.stories.map((one) => [one.number, one.plan, one.why])).toEqual([
      [11, "done", null],
      [12, "merge", null],
      [13, "stop", "not ready: acceptance criteria"],
      [14, "after", null],
      [10, "after", null],
    ]);
  });

  it("runs a card's stories one after another and the cards side by side, within the cap, one merge at a time", async () => {
    const run1 = state([card(1, [12, 13]), card(2, [14]), card(3, [15])]);
    const { moves, done } = fakeMoves();
    // Two Claude runs at most: the first story of cards 1 and 2; card 3 waits.
    await advance(run1, seen([story(12), story(13), story(14), story(15)]), moves);
    expect(done).toEqual(["launch #12", "launch #14"]);
    expect(run1.cards.map((one) => one.step)).toEqual(["claude", "claude", "next"]);
    expect(run1.cards[2]?.note).toContain("waits for a free Claude run");

    // Both runs end with a pull request: one merge at a time.
    const prs = [story(12, { pulls: [{ number: 30, url: "x", state: "open" }] }), story(13), story(14, { pulls: [{ number: 31, url: "x", state: "open" }] }), story(15)];
    await advance(run1, seen(prs, [run(14, "completed", "success"), run(12, "completed", "success")], { now: later(20) }), moves);
    expect(done.slice(2)).toEqual(["merge #30", "launch #15"]);
    expect(run1.cards.map((one) => one.step)).toEqual(["merging", "next", "claude"]);
    expect(run1.cards[1]?.note).toContain("waits for the merge in progress");

    // #30 merged: card 1 goes on with #13, card 2 merges #31.
    await advance(run1, seen(prs, [run(15, "in_progress", null, later(20)), run(14, "completed", "success"), run(12, "completed", "success")], { now: later(30), pulls: new Map([[30, { state: "merged" }]]) }), moves);
    expect(done.slice(4)).toEqual(["launch #13", "merge #31"]);
    expect(run1.cards.map((one) => [one.step, one.at])).toEqual([["claude", 1], ["merging", 0], ["claude", 0]]);
  });

  it("stops a card and says why, while the others go on", async () => {
    const run1 = state([card(1, [12]), card(2, [14]), card(3, [16]), card(4, [18])]);
    const { moves, logged } = fakeMoves();
    run1.cards.forEach((one, index) => Object.assign(one, { step: index === 3 ? "next" : "claude", since: NOW, runs: 1 }));
    await advance(
      run1,
      seen(
        [story(12), story(14), story(16), story(18, { stage: "backlog", missing: ["a priority"] })],
        [run(12, "completed", "failure"), run(14, "completed", "success"), run(16, "in_progress", null)],
        { now: later(75) },
      ),
      moves,
    );
    expect(run1.cards.map((one) => one.reason)).toEqual([
      "Claude's run on #12 failed",
      "Claude's run on #14 ended without a pull request: it may have asked a question on the issue",
      "Claude's run on #16 has gone on for more than 70 minutes",
      "#18 is not ready: it lacks a priority",
    ]);
    expect(run1.cards[0]?.link).toBe("https://github.com/run/12");
    expect(run1.status).toBe("waiting");
    expect(logged.filter((entry) => entry.action === "sprint_run_card_stopped")).toHaveLength(4);
  });

  it("has Claude update a pull request in conflict once, merges again, then stops if refused again", async () => {
    const run1 = state([card(1, [12])]);
    Object.assign(run1.cards[0] ?? {}, { step: "merging", pull: 30, since: NOW, runs: 1 });
    const { moves, done } = fakeMoves();
    const conflict = (at: string) => new Map([[30, { conclusion: "failure", reason: "The pull request conflicts with main: docs/release-notes.json", url: "https://github.com/merge/1", at }]]);
    await advance(run1, seen([story(12)], [], { now: later(5), merges: conflict(later(4)) }), moves);
    expect(done).toEqual(["update #12 #30"]);
    expect(run1.cards[0]?.step).toBe("updating");

    await advance(run1, seen([story(12)], [run(12, "completed", "success", later(6))], { now: later(15), merges: conflict(later(4)) }), moves);
    expect(done).toEqual(["update #12 #30", "merge #30"]);
    expect(run1.cards[0]?.step).toBe("merging");

    await advance(run1, seen([story(12)], [], { now: later(25), merges: conflict(later(24)) }), moves);
    expect(run1.cards[0]?.step).toBe("stopped");
    expect(run1.cards[0]?.reason).toBe("the merge of #30 was refused: The pull request conflicts with main: docs/release-notes.json");
    expect(run1.cards[0]?.link).toBe("https://github.com/merge/1");
  });

  it("follows a story already launched by hand, ignores an event seen twice, and is done when every card is", async () => {
    const run1 = state([card(1, [12])]);
    const { moves, done, logged } = fakeMoves();
    await advance(run1, seen([story(12)], [run(12, "in_progress", null)]), moves);
    expect(done).toEqual([]);
    expect(run1.cards[0]?.step).toBe("claude");
    const finished = seen([story(12, { pulls: [{ number: 30, url: "x", state: "open" }] })], [run(12, "completed", "success")], { now: later(10) });
    await advance(run1, finished, moves);
    await advance(run1, finished, moves);
    expect(done).toEqual(["merge #30"]);
    await advance(run1, seen([story(12, { pulls: [{ number: 30, url: "x", state: "merged" }] })], [], { now: later(20), pulls: new Map([[30, { state: "merged" }]]) }), moves);
    expect(run1.status).toBe("done");
    expect(logged.map((entry) => entry.action)).toEqual(["sprint_run_story_merged", "sprint_run_card_done", "sprint_run_done"]);
    // Paused, nothing moves.
    const paused = { ...state([card(2, [14])]), status: "paused" as const };
    await advance(paused, seen([story(14)]), moves);
    expect(done).toEqual(["merge #30"]);
  });
});

// ---- On the sprint page --------------------------------------------------------

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seedSprint(): Promise<number> {
  const stories = [12, 13].map((number) => ({
    number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: NOW, updatedAt: NOW, closedAt: null, pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }],
  }));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", workflows: { claude: "claude.yml", fusionner: "merge.yml" }, claude: { plafond: 2 } }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify(stories)),
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO),
  ]);
  const id = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 'Sprint', 1, 'pe') RETURNING id").bind(REPO).first<{ id: number }>())?.id ?? 0;
  await env.DB.batch([12, 13].map((number, index) => env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', ?, ?)").bind(id, String(number), index + 1)));
  return id;
}

describe("Running the sprint from its page", () => {
  it("shows what will run to a Product Engineer, not to a tech lead, then runs it, pauses and stops it", async () => {
    const id = await seedSprint();
    await grantRole("lead", "tech_lead");
    expect((await get(`/projects/${REPO}/sprint/run`, (await signIn("lead")).cookie)).status).toBe(403);
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const preview = await (await get(`/projects/${REPO}/sprint/run`, cookie)).text();
    expect(preview).toContain("<h1>Run the sprint</h1>");
    expect(preview).toMatch(/#12<\/span> Story 12 — <span class="muted small">Claude, then merge/);
    expect(preview).toContain('name="action" value="run_start"');

    // Started: #12 launched (the cap leaves room, #13 waits behind it).
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(3);
    github.intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS).times(2);
    let dispatched: unknown = null;
    github.intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` }).reply(204, (options) => {
      dispatched = JSON.parse(String(options.body));
      return "";
    });
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` }).reply(201, "{}", JSON_HEADERS);
    const started = await post(`/projects/${REPO}/sprint`, { csrf, action: "run_start" }, cookie);
    expect(started.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=run_started`);
    expect(dispatched).toEqual({ ref: "main", inputs: { issue: "12", par: "pe" } });
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["sprint_run_started", "claude_launched", "sprint_run_story_started"]));

    // Paused, then stopped: said on the page, nothing new starts.
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "run_pause" }, cookie)).status).toBe(303);
    github.intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain("The run is paused");
    expect(page).toMatch(new RegExp(`id="run-card-${id}".*Claude working`, "s"));
    expect(page).toContain('value="run_resume"');
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "run_stop" }, cookie)).status).toBe(303);
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["sprint_run_paused", "sprint_run_stopped"]));
    // A tech lead cannot start it.
    expect((await post(`/projects/${REPO}/sprint`, { csrf: (await signIn("lead")).csrf, action: "run_start" }, (await signIn("lead")).cookie)).status).toBe(403);
  });
});
