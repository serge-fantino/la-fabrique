import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { nextStep } from "../src/refinement";
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
  const spec = (questions: string[]) => ({ data: { spec: { answers: { a: "x" }, questions, source: "claude" as const, at: "2026-01-01" } } });
  const known = (stage: CardStory["stage"]) => new Map([[1, { stage } as CardStory]]);
  it("goes from Specify to Ready", () => {
    expect(nextStep({ data: {} }, [], new Map())).toEqual({ step: "specify" });
    expect(nextStep(spec(["Who?"]), [], new Map())).toEqual({ step: "answer", questions: 1 });
    expect(nextStep(spec([]), [], new Map())).toEqual({ step: "refine" });
    expect(nextStep(spec([]), [1], known("backlog"))).toEqual({ step: "validate", stories: [1] });
    expect(nextStep(spec([]), [1], known("ready"))).toEqual({ step: "ready" });
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
    expect(page).toContain("Answer (2)");
    expect(page).toContain(">Refine</button>");
    expect(page).toContain(">Validate</a>");
    expect(page).toContain("Not ready (not labelled ready)");
    expect(page).toContain('aria-label="Mark #21 ready">Mark ready</button>');
    expect(page).not.toContain("Elsewhere");
    expect(page.indexOf("Ideas and questions")).toBeGreaterThan(page.indexOf("Fourth"));
    expect(page).toContain("An idea");

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
