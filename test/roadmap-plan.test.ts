import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Card } from "../src/cards";
import { epicLevels, featureWaves, LATER, sprintPlan } from "../src/roadmap-plan";
import { get, grantRole, logActions, post, signIn } from "./helpers";

// The Roadmap: the sprints to come, proposed from priorities and
// dependencies, planned by hand; the dependency tree.
const REPO = "acme/widget";

function card(id: number, extra: Partial<Card> = {}): Card {
  return {
    id, repo: REPO, kind: "feature", status: "draft", title: `Feature ${id}`, body: "", epic: null, domain: null, segment: null, release: null,
    position: id, rev: 1, author: "pe", createdAt: "", updatedAt: "", archivedAt: null, data: {}, priority: null, backstage: false, progress: null, ...extra,
  };
}
const depends = (from: number, on: number) => ({ card_id: from, kind: "depends", ref: String(on) });
const shape = (columns: ReturnType<typeof sprintPlan>) => columns.map((column) => [column.label, column.cards.map((one) => one.card.id)]);

describe("The plan of the sprints to come", () => {
  it("proposes the features not placed, by priority, each after what it depends on, so many per sprint", () => {
    const cards = [
      card(1, { release: "Sprint" }),
      card(2, { release: "Next release" }),
      card(3),
      card(4, { priority: "P1" }),
      card(5),
      card(6, { release: "1.2" }), // shipped: out of the plan
      card(7, { status: "dropped" }),
    ];
    const releases = new Map([["1.2", { version: "1.2", title: null, state: "shipped" as const }]]);
    // 4 depends on 5: 5 first, though 4 has the higher priority.
    const columns = sprintPlan({ cards, links: [depends(4, 5)], releases, priorities: ["P1", "P2"], capacity: 1, started: 3, plans: new Map() });
    expect(shape(columns)).toEqual([
      ["Sprint", [1]],
      ["Next release", [2]],
      ["Sprint +2", [5]],
      ["Sprint +3", [4]],
      ["Sprint +4", [3]],
    ]);
    expect(columns[3]?.cards[0]?.after).toEqual([5]);
  });

  it("keeps a feature planned by hand where it was put, warns when it comes before what it needs, and sends the overflow Later", () => {
    const cards = [card(1), card(2), card(3), ...Array.from({ length: 8 }, (_, i) => card(10 + i))];
    // 1 planned by hand for the sprint after the next (3 started: rank 5 is +2); it depends on 2.
    const columns = sprintPlan({ cards, links: [depends(1, 2)], releases: new Map(), priorities: [], capacity: 1, started: 3, plans: new Map([[1, 5], [3, 4]]) });
    const planned = columns.find((column) => column.label === "Sprint +2")?.cards.find((one) => one.card.id === 1);
    expect(planned?.manual).toBe(true);
    expect(planned?.late).toEqual([2]);
    // 3 was planned for the next sprint (rank 4): it waits in Next release, to move.
    expect(columns.find((column) => column.label === "Next release")?.cards.map((one) => [one.card.id, one.toMove])).toEqual([[3, true]]);
    expect(columns.at(-1)?.offset).toBe(LATER);
    expect(columns.at(-1)?.cards.length).toBeGreaterThan(0);
  });

  it("puts the epics in levels and the features in waves", () => {
    const epics = [card(20, { kind: "epic", title: "Pay" }), card(21, { kind: "epic", title: "Ship" }), card(22, { kind: "epic", title: "Track" })];
    const levels = epicLevels(epics, new Map([[21, [20]], [22, [21, 20]]]), []);
    expect(levels.map((node) => [node.epic.id, node.level])).toEqual([[20, 0], [21, 1], [22, 2]]);
    const features = [card(1), card(2), card(3, { status: "validated", progress: "in_production" })];
    const waves = featureWaves(features, [depends(1, 2), depends(2, 3)]);
    // 3 is in production: 2 can start, 1 comes after it.
    expect([waves.get(2), waves.get(1)]).toEqual([1, 2]);
  });
});

async function seed(): Promise<number[]> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
  const ids: number[] = [];
  for (const [title, epic] of [["Checkout", null], ["Pay by card", "Checkout"], ["Receipt", "Checkout"], ["Invoices", null]] as const) {
    ids.push(
      (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, epic, position, author) VALUES (?, ?, 'draft', ?, '', ?, ?, 'pe') RETURNING id")
        .bind(REPO, title === "Checkout" ? "epic" : "feature", title, epic, ids.length + 1)
        .first<{ id: number }>())!.id,
    );
  }
  // Receipt depends on Pay by card.
  await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'depends', ?)").bind(ids[2], String(ids[1])).run();
  return ids;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("The Roadmap tab", () => {
  it("shows the proposal and the tree, keeps the proposal, plans by hand and clears the plan", async () => {
    const [epic, pay, receipt, invoices] = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const url = `/projects/${REPO}/roadmap`;
    const page = await (await get(`${url}?per=1`, cookie)).text();
    expect(page).toContain("<h2>Sprints to come</h2>");
    expect(page).toMatch(/aria-label="Sprint \+2">[\s\S]*?id="plan-c\d+"/);
    expect(page).toContain(`After <a class="mono" href="#plan-c${pay}">C${pay}</a>`);
    expect(page).toContain('class="epic-graph"');
    expect(page).toContain(`<a class="mono" href="/projects/${REPO}/cards/${epic}">C${epic}</a> Checkout`);
    expect(page).toContain(">Wave 2</span>");

    const kept = await post(url, { csrf, action: "plan_keep", per: "1" }, cookie);
    expect(kept.headers.get("location")).toBe(`${url}?per=1&kept=3#plan`);
    const plans = async () => (await env.DB.prepare("SELECT card_id, sprint FROM card_plans ORDER BY card_id").all<{ card_id: number; sprint: number }>()).results;
    // No sprint started: +2 is rank 2.
    expect(await plans()).toEqual([
      { card_id: pay, sprint: 2 },
      { card_id: receipt, sprint: 3 },
      { card_id: invoices, sprint: 4 },
    ]);

    await post(url, { csrf, action: "plan", card: String(invoices), sprint: "next" }, cookie);
    expect((await env.DB.prepare("SELECT release FROM cards WHERE id = ?").bind(invoices).first<{ release: string }>())?.release).toBe("Next release");
    await post(url, { csrf, action: "plan", card: String(pay), sprint: "5" }, cookie);
    const after = await (await get(`${url}?per=1`, cookie)).text();
    expect(after).toContain(`title="It depends on C${pay}, planned later">Before C${pay}</span>`);

    await post(url, { csrf, action: "plan_clear", per: "1" }, cookie);
    expect(await plans()).toEqual([]);
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["plan_kept", "cards_to_refinement", "card_unplanned", "card_planned", "plan_cleared"]));
  });

  it("lets a tester read the plan but not change it", async () => {
    const [, pay] = await seed();
    await grantRole("tess", "tester");
    const { cookie, csrf } = await signIn("tess");
    const page = await (await get(`/projects/${REPO}/roadmap`, cookie)).text();
    expect(page).toContain("<h2>Sprints to come</h2>");
    expect(page).not.toContain("Keep the proposal</button>");
    expect((await post(`/projects/${REPO}/roadmap`, { csrf, action: "plan", card: String(pay), sprint: "3" }, cookie)).status).toBe(403);
  });
});

describe("The board's drill-down", () => {
  it("filters on a card's epic from its tag, keeping the lanes, and says how to go back", async () => {
    const [epic, pay] = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie } = await signIn("pe");
    const board = await (await get(`/projects/${REPO}/board?by=status`, cookie)).text();
    expect(board).toContain(`<a class="tag tag-link" href="/projects/${REPO}/board?by=status&amp;epic=Checkout"`);
    const drilled = await (await get(`/projects/${REPO}/board?by=status&epic=Checkout`, cookie)).text();
    expect(drilled).toContain('class="board-focus"');
    expect(drilled).toContain(`href="/projects/${REPO}/cards/${epic}"><span class="mono">C${epic}</span> Checkout</a>`);
    expect(drilled).toContain(`id="card-${pay}"`);
    expect(drilled).not.toContain("Invoices");
    expect(drilled).toContain('data-by="status"');
    // Once drilled, the tag no longer links.
    expect(drilled).not.toContain('class="tag tag-link"');
  });
});
