import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "../src/stories";
import { get, logActions, signIn } from "./helpers";

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
