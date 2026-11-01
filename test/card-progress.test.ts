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
    expect(at({ 1: "backlog", 2: "ready", 3: "backlog" })).toMatchObject({ stage: "to_prepare", done: 1, total: 3 });
    expect(at({ 1: "ready", 2: "ready", 3: "ready" })).toMatchObject({ stage: "ready", done: 3, total: 3 });
    expect(at({ 1: "ready", 2: "backlog", 3: "ready" }, { ...CARD, release: "Sprint" })).toMatchObject({ stage: "in_sprint", done: 2, total: 3 });
    expect(at({ 1: "to_validate", 2: "in_dev", 3: "ready" }, { ...CARD, release: "Sprint" })).toMatchObject({ stage: "in_dev", done: 1, total: 3 });
    const checks = new Map<number, StoryChecks>([[2, { validated: { by: "qa", at: "", version: null }, defects: [] }]]);
    expect(at({ 1: "closed", 2: "on_int", 3: "to_validate" }, CARD, checks)).toMatchObject({ stage: "to_test", done: 2, total: 3 });
    expect(at({ 1: "closed", 2: "closed", 3: "closed" })).toMatchObject({ stage: "in_production", done: 3, total: 3 });
    // Every count, for the pill's title.
    expect(at({ 1: "closed", 2: "on_int", 3: "in_dev" })?.counts).toEqual({ ready: 3, developed: 2, validated: 1, out: 1 });
    expect(at({ 1: "closed", 2: "closed", 3: "closed" }, { ...CARD, status: "dropped" })).toBeNull();
  });

  it("moves on with the stories needed, and counts every story, nice to have included; none without a story", () => {
    // The nice to have does not hold the card back, but it is counted.
    expect(progressOf(CARD, links([1, 2], [2]), stories({ 1: "closed", 2: "backlog" }), NONE, null)).toMatchObject({ stage: "in_production", done: 1, total: 2 });
    const checks = new Map<number, StoryChecks>([[1, { validated: { by: "qa", at: "", version: null }, defects: [] }], [2, { validated: { by: "qa", at: "", version: null }, defects: [] }], [3, { validated: { by: "qa", at: "", version: null }, defects: [] }]]);
    const three = progressOf(CARD, links([1, 2, 3], [2]), stories({ 1: "on_int", 2: "on_int", 3: "on_int" }), checks, null);
    expect(three).toMatchObject({ stage: "to_test", done: 3, total: 3, counts: { nice: 1 } });
    expect(progressOf(CARD, links([1], [1]), stories({ 1: "in_dev" }), NONE, null)).toMatchObject({ stage: "in_dev", done: 0, total: 1 });
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

describe("The status follows the stories once validated", () => {
  it("shows the stage as the card's status on the board and the card, refuses to move a card across it, and writes each change in the log, once", async () => {
    const id = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const board = await (await get(`/projects/${REPO}/board?by=status`, cookie)).text();
    expect(board).toContain('aria-label="In development"');
    expect(board).toContain('aria-label="Validated"');
    // One status pill: the stage and its count; no "Validated" next to it.
    expect(board).toMatch(/<span class="pill card-in_dev" title="Status from the card's stories\. 3 stories: 3 ready, 1 developed, 1 validated, 1 in production\.">In development <span class="mono">1\/3 developed<\/span><\/span>/);
    expect(board).not.toContain('<span class="pill card-validated">Validated</span>');
    expect(board).not.toContain("New card in In development");
    // The filter knows the stages.
    expect(await (await get(`/projects/${REPO}/board?by=none&status=in_dev`, cookie)).text()).toContain("Week menu");

    const logged = async () => (await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_progress_changed'").all<{ details: string }>()).results.map((row) => JSON.parse(row.details));
    expect(await logged()).toEqual([{ card: id, title: "Week menu", from: null, to: "in_dev", done: 1, total: 3 }]);
    // Seen again: nothing new to write.
    await get(`/projects/${REPO}/board?by=status`, cookie);
    expect(await logged()).toHaveLength(1);

    const move = (status: string) => post(`/projects/${REPO}/board`, { csrf, action: "move", card: String(id), set_status: status }, cookie);
    const refused = await move("in_production");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("follows the card's stories");
    expect((await move("validated")).status).toBe(409);
    // Within its lane, it moves; the feature changed: back to To validate.
    expect((await move("in_dev")).status).toBe(200);
    expect((await move("to_validate")).status).toBe(200);
    expect(await (await get(`/projects/${REPO}/board?by=status`, cookie)).text()).toContain('<span class="pill card-to_validate">To validate</span>');
    await env.DB.prepare("UPDATE cards SET status = 'validated' WHERE id = ?").bind(id).run();

    // The stories move on: the card follows.
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, { state: "closed" }), story(2, { state: "closed" }), story(3, { state: "closed" })]), REPO)
      .run();
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain('<select id="card-status" name="status" class="pill card-in_production"');
    expect(page).toContain('<option value="validated" selected>In production 3/3</option>');
    expect(page).toContain("How it went");
    expect((await logged()).map((entry) => entry.to)).toEqual(["in_dev", "in_production"]);
    const log = await (await get(`/projects/${REPO}/log`, cookie)).text();
    expect(log).toContain("go from In development to In production (3/3), from its stories");
  });
});

describe("Testing, followed on the card", () => {
  it("says which stories on int are validated, by whom, and how many criteria the others have checked", async () => {
    const id = await seed();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify({ nom: "Widget", branches: { production: "main", integration: "integration" } }), REPO),
      env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'").bind(
        JSON.stringify([
          story(1, { criteria: [{ text: "A", done: true }] }),
          story(2, { criteria: [{ text: "B", done: true }, { text: "C", done: false }] }),
          story(3, { state: "closed" }),
        ]),
        REPO,
      ),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(
        REPO,
        JSON.stringify({ production: "main", integration: "integration", integrationHead: "abc", aheadBy: 2, groups: [{ branch: "feature/1-a", title: "", mergedAt: now, commits: [], issues: [1, 2] }], workflows: [], versions: [], waiting: [], ready: true, blockers: [] }),
        now,
      ),
      env.DB.prepare("INSERT INTO activity_log (actor, action, repo, issue_number, details) VALUES ('qa', 'story_validated', ?, 1, '{}')").bind(REPO),
    ]);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toMatch(/Story 1 <span class="pill stage-on_int warn">On int<\/span> <span class="pill ok small" title="[^"]*">Validated<\/span> <span class="muted small">by @qa<\/span>/);
    expect(page).toContain('Story 2 <span class="pill stage-on_int warn">On int</span> <span class="muted small">1/2 criteria checked</span>');
    // The card: to test, 2 of the 3 validated (the third is already out).
    expect(page).toContain('<option value="validated" selected>To test 2/3 validated</option>');
  });
});
