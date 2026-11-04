import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { nextStep } from "../src/refinement";
import { fingerprint, validationOf } from "../src/feature-validation";
import type { CardStory } from "../src/card-stories";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const CONFIG = { nom: "Widget", cycle: { pret: ["criteres", "etiquette_prete"] }, demandes: { etiquettes: { prete: "prete-pour-claude" } } };

function story(number: number, title: string, labels: string[] = []): Story {
  return {
    number, title, state: "open", url: "", author: null, labels, parent: null, subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "",
    closedAt: null, pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }],
  };
}

async function card(title: string, position: number, data: object, kind = "feature", release = "Next release"): Promise<number> {
  return (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author, data) VALUES (?, ?, 'validated', ?, 'Body of the card', ?, ?, 'pe', ?) RETURNING id")
    .bind(REPO, kind, title, release, position, JSON.stringify(data))
    .first<{ id: number }>())!.id;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("The next step of a feature", () => {
  const spec = (questions: string[]) => ({ title: "T", body: "B", data: { spec: { answers: { a: "x" }, questions, source: "claude" as const, at: "2026-01-01" } } });
  const known = (stage: CardStory["stage"]) => new Map([[1, { stage } as CardStory]]);
  it("goes from Specify to Ready", () => {
    expect(nextStep({ title: "T", body: "B", data: {} }, [], new Map())).toEqual({ step: "specify" });
    expect(nextStep(spec(["Who?"]), [], new Map())).toEqual({ step: "answer", questions: 1 });
    expect(nextStep(spec([]), [], new Map())).toEqual({ step: "refine" });
    expect(nextStep(spec([]), [1], known("backlog"))).toEqual({ step: "validate", stories: [1] });
    expect(nextStep(spec([]), [1], known("ready"))).toEqual({ step: "approve", validation: { state: "none" } });
  });

  it("is ready once validated, and needs validating again when the feature changes", () => {
    const base = spec([]);
    const kept = { ...base, data: { ...base.data, validation: { by: "pe", at: "2026-11-03T10:00:00Z", ...fingerprint(base, [1]) } } };
    expect(nextStep(kept, [1], known("ready"))).toEqual({ step: "ready" });
    expect(validationOf({ ...kept, body: "other" }, [1])).toMatchObject({ state: "outdated", why: ["its text changed"] });
    const respec = { ...kept, data: { ...kept.data, spec: { ...kept.data.spec, answers: { a: "y" } } } };
    expect(validationOf(respec, [1])).toMatchObject({ state: "outdated", why: ["its spec changed"] });
    expect(validationOf(kept, [1, 2])).toMatchObject({ why: ["a story was added"] });
    expect(validationOf(kept, [])).toMatchObject({ why: ["a story was removed"] });
    expect(nextStep({ ...kept, body: "other" }, [1], known("ready")).step).toBe("approve");
  });
});

describe("The Refinement tab", () => {
  it("lists Next release's features with their step, the rest apart, without calling GitHub", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2000-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify([story(21, "Choose the week")])),
    ]);
    await card("First", 1, {});
    await card("Second", 2, { spec: { answers: { a: "x" }, questions: ["A?", "B?"], source: "claude" } });
    await card("Third", 3, { spec: { answers: { a: "x" }, questions: [], source: "claude" } });
    const fourth = await card("Fourth", 4, { spec: { answers: { a: "x" }, questions: [], source: "claude" } });
    await card("An idea", 5, {}, "idea");
    await card("Elsewhere", 6, {}, "feature", "0.5");
    await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '21', 1)").bind(fourth).run();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");

    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain('href="/projects/acme/widget/refinement"');
    expect(page.indexOf(">Board<")).toBeLessThan(page.indexOf(">Refinement<"));
    expect(page.indexOf(">Refinement<")).toBeLessThan(page.indexOf(">Sprint<"));
    expect(page.indexOf("First")).toBeLessThan(page.indexOf("Second"));
    expect(page).toContain("Body of the card");
    expect(page).toContain(">Specify</button>");
    expect(page).toContain("Claude asks");
    expect(page).toContain(">Then refine</button>");
    expect(page).toContain(">Validate</a>");
    expect(page).toContain("Not ready (not labelled ready)");
    expect(page).toContain('aria-label="Mark #21 ready">Mark ready</button>');
    expect(page).not.toContain("Elsewhere");
    expect(page.indexOf("Ideas and questions")).toBeGreaterThan(page.indexOf("Fourth"));
    expect(page).toContain("An idea");
    expect(page).toContain("NO-GO");
    expect(page).toContain('href="#card-');
    expect(page).toContain("nice to have");

    // Mark ready: the label on GitHub, logged.
    const gh = fetchMock.get("https://api.github.com");
    gh.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    gh.intercept({ method: "POST", path: `/repos/${REPO}/issues/21/labels` }).reply(200, "[]", JSON_HEADERS);
    gh.intercept({ path: `/repos/${REPO}/issues/21` }).reply(200, JSON.stringify({ number: 21, title: "Choose the week", state: "open", html_url: "", user: null, labels: [{ name: "prete-pour-claude" }], created_at: "", updated_at: "", closed_at: null, body: "## Acceptance criteria\n- [ ] Works" }), JSON_HEADERS);
    const done = await post(`/projects/${REPO}/refinement`, { csrf, action: "story_ready", story: "21" }, cookie);
    expect(done.headers.get("location")).toBe(`/projects/${REPO}/refinement?notice=ready`);
    expect((await logActions()).map((entry) => entry.action)).toContain("story_marked_ready");
  });
});

describe("Priority and order in Refinement", () => {
  const CONFIG2 = { ...CONFIG, cycle: { ...CONFIG.cycle, priorites: ["P1", "P2"] } };
  async function setup() {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG2)),
    ]);
    const a = await card("Alpha", 1, {});
    const idea = await card("An idea", 2, {}, "idea");
    const b = await card("Beta", 3, {});
    const c = await card("Gamma", 4, {});
    await grantRole("pe", "product_engineer");
    return { a, idea, b, c, ...(await signIn("pe")) };
  }
  const order = async () => (await env.DB.prepare("SELECT id FROM cards WHERE repo = ? ORDER BY position, id").bind(REPO).all<{ id: number }>()).results.map((r) => r.id);

  it("saves a feature's priority, logged", async () => {
    const { a, cookie, csrf } = await setup();
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain('name="priority"');
    expect(page).toContain('data-sortable="card_order"');
    const done = await post(`/projects/${REPO}/refinement`, { csrf, action: "card_priority", card: String(a), priority: "P1" }, cookie);
    expect(done.headers.get("location")).toBe(`/projects/${REPO}/refinement?notice=priority#card-${a}`);
    expect((await env.DB.prepare("SELECT priority FROM cards WHERE id = ?").bind(a).first<{ priority: string }>())?.priority).toBe("P1");
    expect((await logActions()).map((entry) => entry.action)).toContain("card_priority_set");
    const refused = await post(`/projects/${REPO}/refinement`, { csrf, action: "card_priority", card: String(a), priority: "P9" }, cookie);
    expect(refused.headers.get("location")).toBe(`/projects/${REPO}/refinement`);
  });

  it("saves the features' order, logged, and the board follows; arrows work without the script", async () => {
    const { a, idea, b, c, cookie, csrf } = await setup();
    const send = (fields: Record<string, string>) =>
      post(`/projects/${REPO}/refinement`, { csrf, ...fields }, cookie, { accept: "application/json" });
    const moved = await send({ action: "card_order", order: `${c},${a},${b}` });
    expect(await moved.json()).toEqual({ ok: true, changed: true });
    expect(await order()).toEqual([c, idea, a, b]);
    expect(await (await send({ action: "card_order", order: `${c},${a},${b}` })).json()).toEqual({ ok: true, changed: false });
    expect(await (await send({ action: "card_order", order: `${c},${a}` })).json()).toEqual({ ok: true, changed: false });
    const down = await post(`/projects/${REPO}/refinement`, { csrf, action: "card_down", card: String(c) }, cookie);
    expect(down.headers.get("location")).toBe(`/projects/${REPO}/refinement#card-${c}`);
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page.indexOf("Alpha")).toBeLessThan(page.indexOf("Gamma"));
    expect(page.indexOf("Gamma")).toBeLessThan(page.indexOf("Beta"));
    expect(page).toContain('aria-label="Move C' + a + ' down"');
    const board = await (await get(`/projects/${REPO}/board?by=release`, cookie)).text();
    expect(board.indexOf("Alpha")).toBeLessThan(board.indexOf("Gamma"));
    expect(board.indexOf("Gamma")).toBeLessThan(board.indexOf("Beta"));
    expect((await logActions()).filter((entry) => entry.action === "sprint_card_moved").length).toBe(2);
  });
});

import { releaseProgress } from "../src/refinement";
describe("The release's progress", () => {
  const mk = (id: number, data: object) => ({ id, title: `F${id}`, body: "", data }) as never;
  const done = { spec: { answers: { a: "x" }, questions: [], source: "claude" } };
  const validated = { ...done, validation: { by: "pe", at: "2026-11-03T10:00:00Z", ...fingerprint({ title: "F2", body: "", data: done as never }, [1, 2]) } };
  it("counts and says what blocks", () => {
    const links = { order: new Map([[2, [1, 2]], [3, [3]]]), nice: new Set<string>() } as never;
    const known = new Map([[1, { stage: "ready" }], [2, { stage: "ready" }], [3, { stage: "backlog" }]]) as never;
    const p = releaseProgress([mk(1, {}), mk(2, validated), mk(3, done)], links, known);
    expect([p.features, p.specified, p.refined, p.ready]).toEqual([3, 2, 2, 1]);
    expect(p.blockers.map((b) => b.card.id)).toEqual([1, 3]);
    // Stories ready but not validated: blocks, and says so.
    const q = releaseProgress([mk(2, done)], links, known);
    expect(q.blockers[0]?.reason).toBe("not validated");
  });
});

describe("Validating a feature", () => {
  it("is offered, kept with who and when, logged, shown to a tester without the button, and lost when the feature changes", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2000-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify([story(21, "Choose the week", ["prete-pour-claude"])])),
    ]);
    const id = await card("Weekly", 1, { spec: { answers: { a: "x" }, questions: [], source: "claude", at: "2026-01-01T00:00:00Z" } });
    await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '21', 1)").bind(id).run();
    await grantRole("pe", "product_engineer");
    await grantRole("tess", "tester");
    const pe = await signIn("pe");

    let page = await (await get(`/projects/${REPO}/refinement`, pe.cookie)).text();
    expect(page).toContain(">Validate the feature</button>");
    expect(page).toContain("not validated");
    expect(await (await get(`/projects/${REPO}/cards/${id}`, pe.cookie)).text()).toContain(">Validate the feature</button>");

    const done = await post(`/projects/${REPO}/cards/${id}`, { csrf: pe.csrf, action: "validate_feature", back: `/projects/${REPO}/refinement#card-${id}` }, pe.cookie);
    expect(done.headers.get("location")).toBe(`/projects/${REPO}/refinement#card-${id}`);
    expect((await logActions()).map((entry) => entry.action)).toContain("card_validated");
    page = await (await get(`/projects/${REPO}/refinement`, pe.cookie)).text();
    expect(page).toContain("Validated by @pe");
    expect(page).toContain("GO");
    expect(await (await get(`/projects/${REPO}/cards/${id}`, pe.cookie)).text()).toContain("by <span class=\"mono\">me</span>");

    const tester = await signIn("tess");
    const seen = await (await get(`/projects/${REPO}/refinement`, tester.cookie)).text();
    expect(seen).toContain("Validated by @pe");
    expect(seen).not.toContain("Validate the feature");
    expect((await post(`/projects/${REPO}/cards/${id}`, { csrf: tester.csrf, action: "validate_feature" }, tester.cookie)).status).toBe(403);

    await env.DB.prepare("UPDATE cards SET body = 'Changed text' WHERE id = ?").bind(id).run();
    page = await (await get(`/projects/${REPO}/refinement`, pe.cookie)).text();
    expect(page).toContain("its text changed");
    expect(page).toContain("NO-GO");
    expect(page).toContain("to validate again: its text changed");
  });
});

describe("The preparation document", () => {
  it("is built at each level, as HTML and as a numbered PDF, and logged", async () => {
    const { buildDoc, renderHtml, renderPdf, readLevel, fileName } = await import("../src/preparation");
    const spec = { answers: { objectif: "Sell more\n- fast\n- cheap ünï €" }, questions: [], source: "person" as const, at: "2026-01-01" };
    const feature = (id: number, title: string) => ({ id, title, body: "b", data: { spec }, status: "validated", progress: null, priority: "high", kind: "feature" }) as never;
    const links = { order: new Map([[1, [7]]]), nice: new Map() } as never;
    const stories = new Map([[7, { number: 7, title: "Story seven", stage: "ready", closed: false, criteria: [{ text: "It works", done: true }], priority: null, missing: [], pulls: [] }]]) as never;
    const input = (level: 1 | 2 | 3) => ({
      level, projectName: "Widget", description: "Makes widgets", preparing: "1.5", releases: [{ version: "1.4", title: null, state: "shipped" }, { version: "1.3", title: null, state: "shipped" }] as never,
      by: "pe", now: new Date("2026-11-04T10:00:00Z"), features: [feature(1, "First"), feature(2, "Second")], links, stories,
      rubriques: [{ cle: "objectif", titre: "Goal" }] as never, recorded: new Map([[7, [{ index: 0, text: "It works", steps: [] }]]]), sections: () => null,
    });
    const one = renderHtml(buildDoc(input(1)));
    expect(one).toContain("Widget");
    expect(one).toContain("Makes widgets");
    expect(one).toContain("1.5");
    expect(one).toContain("<svg");
    expect(one).toContain("NO-GO");
    expect(one).toContain("Goal");
    expect(one).toContain("<li>fast</li>");
    expect(one).not.toContain("Story seven");
    expect(one).not.toMatch(/<script|https?:\/\/(?!www\.w3\.org)/);
    expect(buildDoc(input(1)).latest).toBe("1.4");
    expect(renderHtml(buildDoc(input(2)))).toContain("It works");
    expect(renderHtml(buildDoc(input(2)))).not.toContain("Test cases");
    expect(renderHtml(buildDoc(input(3)))).toContain("Scenario: It works");
    expect(readLevel("9")).toBe(1);
    expect(fileName(buildDoc(input(2)), "acme/widget", "pdf")).toBe("preparation-widget-1.5-level2.pdf");
    const pdf = await renderPdf(buildDoc(input(3)));
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-")).toBe(true);
    // cover, summary, one page per feature
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(4);
  });

  it("downloads from the Refinement tab and logs the level and format", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
    ]);
    await card("Alpha", 1, { spec: { answers: { a: "x" }, questions: [], source: "person", at: "2026-01-01" } });
    await grantRole("pe", "product_engineer");
    const { cookie } = await signIn("pe");
    const pdf = await get(`/projects/${REPO}/refinement/preparation?level=3&format=pdf`, cookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("attachment");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const page = await get(`/projects/${REPO}/refinement/preparation?level=1&format=html`, cookie);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Alpha");
    const log = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'preparation_downloaded' ORDER BY id").all<{ details: string }>();
    expect(log.results.map((r) => JSON.parse(r.details))).toMatchObject([{ level: 3, format: "pdf" }, { level: 1, format: "html" }]);
  });
});

describe("Claude's questions in the Refinement card (la-fabrique#227)", () => {
  it("shows each card's questions with fields, queues the answers, closes the questions", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', '2000-01-01T00:00:00.000Z')").bind(REPO),
    ]);
    const a = await card("Alpha", 1, { spec: { answers: { a: "x" }, questions: ["Who?", "When?"], source: "claude" } });
    const b = await card("Beta", 2, { spec: { answers: { a: "x" }, questions: ["Why?"], source: "claude" } });
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain(`id="answer-${a}-1"`);
    expect(page).toContain(`id="answer-${b}-0"`);
    expect(page).toContain("Enough questions");

    const sent = await post(`/projects/${REPO}/refinement`, { csrf, action: "spec_answer", card: String(a), question_0: "Who?", answer_0: "Cooks" }, cookie);
    expect(sent.headers.get("location")).toContain("notice=launched");
    const job = await env.DB.prepare("SELECT kind, request FROM claude_jobs WHERE card_id = ?").bind(a).first<{ kind: string; request: string }>();
    expect(job?.kind).toBe("spec_answer");
    expect(job?.request).toContain("Cooks");

    const empty = await post(`/projects/${REPO}/refinement`, { csrf, action: "spec_answer", card: String(b) }, cookie);
    expect(empty.headers.get("location")).toContain("failure=");

    const closed = await post(`/projects/${REPO}/refinement`, { csrf, action: "spec_enough", card: String(b) }, cookie);
    expect(closed.headers.get("location")).toContain("notice=enough");
    const row = await env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(b).first<{ data: string }>();
    expect(JSON.parse(row!.data).spec.questions).toEqual([]);
    expect(JSON.parse(row!.data).spec.closed).toBe(true);
  });
});
