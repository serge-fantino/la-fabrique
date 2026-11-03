import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cardMentions, type Story } from "../src/stories";
import { get, logActions, post, signIn } from "./helpers";

// Reality first (la-fabrique#205): while a sprint runs, a card being worked
// on is in the sprint, even if nobody put it there. A story leads to its
// feature, and the board finds a card by its story (la-fabrique#206).
const REPO = "acme/widget";

function story(number: number, title: string, extra: Partial<Story> = {}): Story {
  return {
    number, title, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }], ...extra,
  };
}

async function card(title: string, release: string | null, stories: number[], status = "validated"): Promise<number> {
  const id = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', ?, ?, '', ?, 1, 'pe') RETURNING id").bind(REPO, status, title, release).first<{ id: number }>())?.id ?? 0;
  for (const [at, number] of stories.entries()) await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', ?, ?)").bind(id, String(number), at + 1).run();
  return id;
}

async function seed(sprint: boolean): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget", langue: "en" })),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([
        // Back in development after a feedback.
        story(170, "Generic relay", { labels: ["rework"], pullRequests: [{ number: 30, url: `https://github.com/${REPO}/pull/30`, state: "merged" }] }),
        // Merged, to validate.
        story(171, "Week menu", { pullRequests: [{ number: 31, url: `https://github.com/${REPO}/pull/31`, state: "merged" }] }),
        // Nothing started.
        story(172, "Later"),
        story(173, "Dropped work", { branches: ["feature/173"] }),
      ]),
    ),
    ...(sprint ? [env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO)] : []),
  ]);
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const releaseOf = async (id: number) => (await env.DB.prepare("SELECT release FROM cards WHERE id = ?").bind(id).first<{ release: string | null }>())?.release ?? null;

describe("Reality first: the sprint takes the cards being worked on (la-fabrique#205)", () => {
  it("moves a card of Next release, or not set, whose story is in development or to test into the running sprint, and says so", async () => {
    await seed(true);
    const relay = await card("Generic relay", "Next release", [170]);
    const menu = await card("Week menu", null, [171]);
    const later = await card("Later", "Next release", [172]);
    const dropped = await card("Dropped work", "Next release", [173], "dropped");
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain(`C${relay} (#170), C${menu} (#171) joined the sprint: their stories are being developed or tested.`);
    expect(await releaseOf(relay)).toBe("Sprint");
    expect(await releaseOf(menu)).toBe("Sprint");
    expect(await releaseOf(later)).toBe("Next release");
    expect(await releaseOf(dropped)).toBe("Next release");
    // In the card's history, with the reason.
    const moves = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_moved' ORDER BY id").all<{ details: string }>();
    expect(moves.results.map((row) => (JSON.parse(row.details) as { reason?: string }).reason)).toEqual(["joined the sprint: #170 in development", "joined the sprint: #171 to test"]);
    expect((await logActions()).filter((action) => action.action === "card_moved")).toHaveLength(2);
    // Said once: the next display has nothing new to say.
    expect(await (await get(`/projects/${REPO}/sprint`, cookie)).text()).not.toContain("joined the sprint");
  });

  it("leaves the cards where they are when no sprint runs", async () => {
    await seed(false);
    const relay = await card("Generic relay", "Next release", [170]);
    const { cookie } = await signIn("admin-one");
    expect((await get(`/projects/${REPO}/board`, cookie)).status).toBe(200);
    expect(await releaseOf(relay)).toBe("Next release");
  });
});

describe("From a story to its feature (la-fabrique#206)", () => {
  it("finds a card by its story on the board", async () => {
    await seed(false);
    await card("Generic relay", "Next release", [170]);
    await card("Week menu", "Next release", [171]);
    const { cookie } = await signIn("admin-one");
    for (const q of ["%23170", "170"]) {
      const page = await (await get(`/projects/${REPO}/board?q=${q}`, cookie)).text();
      expect(page).toContain("Generic relay");
      expect(page).not.toContain("Week menu");
    }
  });
});

// No work on int without a sprint (la-fabrique#216); a shipped card comes
// back for a new story (#217): L'épicerie's C5, shipped in 1.172, and #186
// on int in 1.173 with no sprint running.
async function seedIntProject(): Promise<void> {
  const now = new Date().toISOString();
  const release = (version: string, stories: number[]) => ({ version, date: "2026-11-02", time: "18:00", title: `Release ${version}`, changes: [], links: [], stories, upcoming: false });
  const merged = (number: number) => [{ number, url: `https://github.com/${REPO}/pull/${number}`, state: "merged" as const }];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", langue: "en", branches: { production: "main", integration: "integration" }, version: { fichier: "docs/release-notes.json" } }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'releases', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify({ commitSha: "abc", releases: [release("1.172", [177, 178])] }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(
      REPO,
      JSON.stringify({ production: "main", integration: "integration", integrationHead: "def", aheadBy: 1, groups: [{ branch: "feature/186-share", title: "", mergedAt: now, commits: [], issues: [186] }], workflows: [], versions: [], waiting: [], ready: true, blockers: [] }),
      now,
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([
        story(177, "Propose a recipe", { pullRequests: merged(30), state: "closed" }),
        // Shipped in 1.172 without its validation: still open, declared.
        story(178, "Update a published recipe", { pullRequests: merged(31) }),
        story(186, "Share my recipes (C5)", { pullRequests: merged(40), mentions: [5] }),
      ]),
    ),
  ]);
}

describe("No work on int without a sprint, and a shipped card comes back (la-fabrique#216, #217)", () => {
  it("opens the sprint when int holds work production does not, and brings back the shipped card of a new story", async () => {
    await seedIntProject();
    const c5 = await card("Share recipes", "1.172", [177, 178, 186]);
    const other = await card("Old feature", "1.172", [178]);
    const next = await card("Planned", "Next release", []);
    const { cookie } = await signIn("admin-one");
    expect((await get(`/projects/${REPO}/board`, cookie)).status).toBe(200);
    const sprint = await env.DB.prepare("SELECT started_by, version, ended_at FROM sprints WHERE repo = ?").bind(REPO).first<{ started_by: string; version: string; ended_at: string | null }>();
    expect(sprint).toEqual({ started_by: "la-fabrique", version: "1.173", ended_at: null });
    const started = (await logActions()).find((entry) => entry.action === "sprint_started");
    expect(JSON.parse(started?.details ?? "{}")).toMatchObject({ forced: true, stories: [186] });
    // C5 comes back for #186, which no shipped version declares.
    expect(await releaseOf(c5)).toBe("Sprint");
    const moved = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_moved'").all<{ details: string }>();
    expect(moved.results.map((row) => (JSON.parse(row.details) as { reason?: string }).reason)).toEqual(["joined the sprint (shipped in 1.172): #186 to test"]);
    // A shipped card whose open story was declared by its release stays; Next release stays too.
    expect(await releaseOf(other)).toBe("1.172");
    expect(await releaseOf(next)).toBe("Next release");
    // Opened once.
    expect((await get(`/projects/${REPO}/board`, cookie)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sprints WHERE repo = ?").bind(REPO).first<{ n: number }>())?.n).toBe(1);
  });

  it("opens nothing when int and production hold the same work", async () => {
    await seedIntProject();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'production'")
      .bind(JSON.stringify({ production: "main", integration: "integration", integrationHead: "def", aheadBy: 0, groups: [], workflows: [], versions: [], waiting: [], ready: true, blockers: [] }), REPO)
      .run();
    const { cookie } = await signIn("admin-one");
    expect((await get(`/projects/${REPO}/board`, cookie)).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM sprints WHERE repo = ?").bind(REPO).first()).toBeNull();
  });
});

describe("A story linked to the card it names (la-fabrique#218)", () => {
  it("reads the cards a story names", () => {
    expect(cardMentions("Share my recipes (C5)", "Lié à C5 (#177), see C12 and C12.")).toEqual([5, 12]);
    expect(cardMentions("Fix the CSS", "ABC12 /c/5 #C7 C3PO")).toEqual([]);
  });

  it("proposes it on the card's page, and links it when asked", async () => {
    await seedIntProject();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'production'")
      .bind(JSON.stringify({ groups: [], waiting: [] }), REPO)
      .run();
    const c5 = await card("Share recipes", "1.172", [177, 178]);
    // #186 names this card in its title.
    const stories = JSON.parse((await env.DB.prepare("SELECT data FROM snapshots WHERE repo = ? AND kind = 'stories'").bind(REPO).first<{ data: string }>())?.data ?? "[]") as Story[];
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify(stories.map((entry) => (entry.number === 186 ? { ...entry, mentions: [c5] } : entry))), REPO)
      .run();
    const { cookie, csrf } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/cards/${c5}`, cookie)).text();
    expect(page).toContain(`Stories that name C${c5}`);
    expect(page).toContain(`>Link to C${c5}</button>`);
    const response = await post(`/projects/${REPO}/cards/${c5}`, { csrf, action: "link_story", story: "186", back: `/projects/${REPO}/to-test#story-186` }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/to-test#story-186`);
    const linked = await env.DB.prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = 'story' ORDER BY ref").bind(c5).all<{ ref: string }>();
    expect(linked.results.map((row) => row.ref)).toEqual(["177", "178", "186"]);
    expect((await logActions()).some((entry) => entry.action === "card_story_created" && entry.actor === "admin-one")).toBe(true);
    expect(await (await get(`/projects/${REPO}/cards/${c5}`, cookie)).text()).not.toContain("Stories that name");
  });
});
