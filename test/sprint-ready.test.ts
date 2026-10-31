import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { storyPriority } from "../src/card-priority";
import { cycleRules } from "../src/lifecycle";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
// As the épicerie: criteria, an epic (or a card), a priority and the ready label.
const CONFIG = {
  nom: "Widget",
  cycle: { pret: ["criteres", "epique", "priorite", "etiquette_prete"], priorites: ["P1", "P2", "P3"] },
  demandes: { etiquettes: { prete: "prete-pour-claude" } },
};

function story(number: number, title: string, extra: Partial<Story> = {}): Story {
  return {
    number, title, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }], ...extra,
  };
}

async function seed(config: Record<string, unknown> = CONFIG): Promise<number> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(21, "Choose the week"), story(22, "Print the week")]),
    ),
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO),
  ]);
  const card = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 'Sprint', 1, 'pe') RETURNING id")
    .bind(REPO)
    .first<{ id: number }>())?.id ?? 0;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '21', 1)").bind(card),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position, nice) VALUES (?, 'story', '22', 2, 1)").bind(card),
  ]);
  return card;
}

function github() {
  return fetchMock.get("https://api.github.com");
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("A story's priority from its card's", () => {
  it("is the card's for a needed story, one level lower when nice to have", () => {
    const rules = cycleRules(CONFIG as Parameters<typeof cycleRules>[0]);
    expect(storyPriority(rules, "P1", false)).toBe("P1");
    expect(storyPriority(rules, "P1", true)).toBe("P2");
    expect(storyPriority(rules, "P3", true)).toBe("P3");
    expect(storyPriority(rules, null, false)).toBeNull();
  });
});

describe("Getting the sprint's stories ready", () => {
  it("counts a card as an epic: a story made from a card needs no epic", async () => {
    await seed({ nom: "Widget", cycle: { pret: ["criteres", "epique"] } });
    await grantRole("pe", "product_engineer");
    const page = await (await get(`/projects/${REPO}/sprint`, (await signIn("pe")).cookie)).text();
    expect(page).toContain('<span class="pill stage-ready ok">Ready</span>');
    expect(page).not.toContain("Not ready");
  });

  it("says why a story is not ready, and fixes it from the sprint: the card's priority, then ready for Claude", async () => {
    const card = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain("Not ready: no priority, not labelled ready");
    expect(page).toContain('aria-label="Mark #21 ready">Mark ready</button>');
    expect(page).toContain(`aria-label="Priority of C${card} and its stories"`);

    // P1 on the card: #21 takes P1, #22 (nice to have) P2.
    const labelled: Record<string, string[]> = {};
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github().intercept({ method: "POST", path: `/repos/${REPO}/labels` }).reply(201, "{}", JSON_HEADERS).times(2);
    for (const number of [21, 22]) {
      github()
        .intercept({ method: "POST", path: `/repos/${REPO}/issues/${number}/labels` })
        .reply(200, (options) => {
          labelled[number] = (JSON.parse(String(options.body)) as { labels: string[] }).labels;
          return "[]";
        });
    }
    const set = await post(`/projects/${REPO}/sprint`, { csrf, action: "card_priority", card: String(card), priority: "P1" }, cookie);
    expect(set.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=priority#card-${card}`);
    expect(labelled).toEqual({ 21: ["P1"], 22: ["P2"] });
    expect((await env.DB.prepare("SELECT priority FROM cards WHERE id = ?").bind(card).first<{ priority: string }>())?.priority).toBe("P1");

    const after = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(after).toContain("Not ready: not labelled ready");

    // Ready for Claude.
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/21/labels` }).reply(200, "[]", JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/issues/21` })
      .reply(200, JSON.stringify({ number: 21, title: "Choose the week", state: "open", html_url: "", user: null, labels: [{ name: "P1" }, { name: "prete-pour-claude" }], created_at: "", updated_at: "", closed_at: null, body: "## Acceptance criteria\n- [ ] Works" }), JSON_HEADERS);
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "story_ready", story: "21" }, cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=ready`);
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["card_priority_set", "priority_set", "story_marked_ready"]));
  });
});
