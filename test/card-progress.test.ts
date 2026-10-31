import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StoryCards } from "../src/card-groups";
import { progressOf } from "../src/card-progress";
import type { CardStory } from "../src/card-stories";
import type { Stage } from "../src/lifecycle";
import type { StoryChecks } from "../src/validation";
import { get, grantRole, post, signIn } from "./helpers";

const REPO = "acme/widget";

function links(order: number[], nice: number[] = []): StoryCards {
  return {
    cards: new Map(),
    byStory: new Map(order.map((number) => [number, [7]])),
    order: new Map([[7, order]]),
    nice: new Set(nice.map((number) => `7:${number}`)),
  };
}

function stories(stages: Record<number, Stage | "closed">): Map<number, CardStory> {
  return new Map(
    Object.entries(stages).map(([number, stage]) => [
      Number(number),
      { number: Number(number), title: `#${number}`, stage: stage === "closed" ? "done" : stage, closed: stage === "closed", criteria: [], priority: null, missing: [], pulls: [] },
    ]),
  );
}

const CARD = { id: 7, status: "validated" as const, release: null };
const NONE = new Map<number, StoryChecks>();

describe("A card's progress, from its stories", () => {
  it("goes from stories to prepare to production, the furthest stage the whole card has reached", () => {
    const at = (stages: Record<number, Stage | "closed">, card: { id: number; status: "validated" | "dropped"; release: string | null } = CARD, checks = NONE) =>
      progressOf(card, links([1, 2, 3]), stories(stages), checks, "Sprint");
    expect(at({ 1: "backlog", 2: "ready", 3: "backlog" })).toEqual({ stage: "to_prepare", done: 1, total: 3 });
    expect(at({ 1: "ready", 2: "ready", 3: "ready" })).toEqual({ stage: "ready", done: 3, total: 3 });
    expect(at({ 1: "ready", 2: "backlog", 3: "ready" }, { ...CARD, release: "Sprint" })).toEqual({ stage: "in_sprint", done: 2, total: 3 });
    expect(at({ 1: "to_validate", 2: "in_dev", 3: "ready" }, { ...CARD, release: "Sprint" })).toEqual({ stage: "in_dev", done: 1, total: 3 });
    const checks = new Map<number, StoryChecks>([[2, { validated: { by: "qa", at: "", version: null }, defects: [] }]]);
    expect(at({ 1: "closed", 2: "on_int", 3: "to_validate" }, CARD, checks)).toEqual({ stage: "to_test", done: 2, total: 3 });
    expect(at({ 1: "closed", 2: "closed", 3: "closed" })).toEqual({ stage: "in_production", done: 3, total: 3 });
    expect(at({ 1: "closed", 2: "closed", 3: "closed" }, { ...CARD, status: "dropped" })).toBeNull();
  });

  it("counts the stories needed, not the nice to have; none without a story", () => {
    expect(progressOf(CARD, links([1, 2], [2]), stories({ 1: "closed", 2: "backlog" }), NONE, null)).toEqual({ stage: "in_production", done: 1, total: 1 });
    expect(progressOf(CARD, links([1], [1]), stories({ 1: "in_dev" }), NONE, null)).toEqual({ stage: "in_dev", done: 0, total: 1 });
    expect(progressOf(CARD, links([]), stories({}), NONE, null)).toBeNull();
  });
});

function story(number: number, extra: Record<string, unknown> = {}) {
  return {
    number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }], ...extra,
  };
}

async function seed(): Promise<number> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(1, { pullRequests: [{ number: 30, url: "x", state: "open" }] }), story(2), story(3, { state: "closed" })]),
    ),
  ]);
  const id = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 1, 'pe') RETURNING id").bind(REPO).first<{ id: number }>())?.id ?? 0;
  await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, position, author) VALUES (?, 'idea', 'draft', 'Later', '', 2, 'pe')").bind(REPO).run();
  await env.DB.batch(["1", "2", "3"].map((ref, index) => env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', ?, ?)").bind(id, ref, index + 1)));
  return id;
}

describe("Progress on the board and the card", () => {
  it("places the cards by progress, refuses to move one across it, and writes each change in the log, once", async () => {
    const id = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const board = await (await get(`/projects/${REPO}/board?by=progress`, cookie)).text();
    expect(board).toContain('<option value="progress" selected>Progress</option>');
    expect(board).toContain('aria-label="In development"');
    expect(board).toContain('aria-label="No story"');
    expect(board).toContain('<span class="pill progress-in_dev warn"');
    expect(board).toContain('In development <span class="mono">1/3 developed</span>');
    expect(board).not.toContain("New card in In development");

    const logged = async () => (await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_progress_changed'").all<{ details: string }>()).results.map((row) => JSON.parse(row.details));
    expect(await logged()).toEqual([{ card: id, title: "Week menu", from: null, to: "in_dev", done: 1, total: 3 }]);
    // Seen again: nothing new to write.
    await get(`/projects/${REPO}/board?by=progress`, cookie);
    expect(await logged()).toHaveLength(1);

    const moved = await post(`/projects/${REPO}/board`, { csrf, action: "move", card: String(id), set_progress: "in_production" }, cookie);
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as { error: string }).error).toContain("Progress follows the card's stories");

    // The stories move on: the card follows.
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, { state: "closed" }), story(2, { state: "closed" }), story(3, { state: "closed" })]), REPO)
      .run();
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain('Progress: <span class="pill progress-in_production ok"');
    expect(page).toContain("How it went");
    expect((await logged()).map((entry) => entry.to)).toEqual(["in_dev", "in_production"]);
    const log = await (await get(`/projects/${REPO}/log`, cookie)).text();
    expect(log).toContain("go from In development to In production (3/3), from its stories");
  });
});
