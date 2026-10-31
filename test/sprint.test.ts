import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const CONFIG = { nom: "Widget", version: { fichier: "notes.json", forme: "0.N" } };
const story = (number: number, title: string, state = "open") => ({
  number, title, state, labels: [], url: "", author: null, parent: null,
  subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [],
});
const release = (version: string, time: string | null, stories: number[] | null = null) =>
  ({ version, date: "2026-10-01", time, title: `Title ${version}`, changes: [], links: [], stories, upcoming: time === null });

// C1 "Week menu" (#21, #22) and C2 "No story yet" in Next release; C3 in 0.56.
async function seed(releases: unknown[] = [release("0.56", "10:00")]): Promise<{ week: number; empty: number }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'releases', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify({ commitSha: "abc", releases })),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(21, "Choose the week"), story(22, "Print the week")]),
    ),
  ]);
  const card = async (title: string, release: string | null, position: number) =>
    (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', ?, '', ?, ?, 'pe') RETURNING id")
      .bind(REPO, title, release, position)
      .first<{ id: number }>())?.id ?? 0;
  const week = await card("Week menu", "Next release", 1);
  const empty = await card("No story yet", "Next release", 2);
  await card("Other release", "0.56", 3);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '21')").bind(week),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '22')").bind(week),
  ]);
  return { week, empty };
}

async function writer(): Promise<{ cookie: string; csrf: string }> {
  await grantRole("pe", "product_engineer");
  return signIn("pe");
}

const releaseOf = async (id: number) => (await env.DB.prepare("SELECT release FROM cards WHERE id = ?").bind(id).first<{ release: string | null }>())?.release;

describe("Next release and the sprint", () => {
  it("shows Next release first on the board, always, with no release planned by number", async () => {
    await seed();
    const session = await writer();
    const board = await (await get(`/projects/${REPO}/board?by=release&empty=hide`, session.cookie)).text();
    const lanes = ['aria-label="Not set"', 'aria-label="Next release"', 'aria-label="0.56"'].map((lane) => board.indexOf(lane));
    expect(lanes[0]).toBe(-1);
    expect(lanes[1]).toBeGreaterThan(0);
    expect(lanes[1]).toBeLessThan(lanes[2] ?? 0);
    expect(board).not.toContain("Plan a release");
  });

  it("starts with the cards of Next release, which move to the Sprint lane; one at a time; stops back to Next release", async () => {
    const { week, empty } = await seed();
    const session = await writer();
    const before = await (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    expect(before).toContain("No sprint in progress");
    expect(before).toContain("The next sprint takes the 2 cards of Next release");

    expect((await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start" }, session.cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=started`);
    expect([await releaseOf(week), await releaseOf(empty)]).toEqual(["Sprint", "Sprint"]);
    const page = await (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    expect(page).toContain('<h2>Sprint <span class="pill warn">In progress</span></h2>');
    expect(page).toContain("<strong>2 stories left</strong> · 2 cards, 2 stories, 0 in production.");
    expect(page).toContain("Choose the week");
    expect(page).not.toContain("Other release");
    expect(page).toContain('Next release <span class="muted mono">0</span>');
    expect(await (await get(`/projects/${REPO}/board?by=release`, session.cookie)).text()).toContain('Sprint <span class="pill warn small">In progress</span>');

    // One at a time.
    await env.DB.prepare("UPDATE cards SET release = 'Next release' WHERE title = 'Other release'").run();
    expect((await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start" }, session.cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint?failure=running`);

    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "stop" }, session.cookie);
    expect([await releaseOf(week), await releaseOf(empty)]).toEqual(["Next release", "Next release"]);
    expect((await logActions()).map((entry) => entry.action).filter((action) => action.startsWith("sprint_"))).toEqual(["sprint_started", "sprint_stopped"]);
  });

  it("refuses to start with nothing in Next release", async () => {
    await seed();
    await env.DB.prepare("UPDATE cards SET release = NULL WHERE release = 'Next release'").run();
    const session = await writer();
    expect((await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start" }, session.cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint?failure=empty`);
  });

  it("orders the cards, then each card's stories; a nice-to-have story does not count as left", async () => {
    const { week, empty } = await seed();
    const session = await writer();
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start" }, session.cookie);
    const page = async () => (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    const at = (text: string, needle: string) => text.indexOf(needle);

    let text = await page();
    expect(at(text, "Week menu")).toBeLessThan(at(text, "No story yet"));
    expect((await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "card_up", card: String(empty) }, session.cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint#card-${empty}`);
    text = await page();
    expect(at(text, "No story yet")).toBeLessThan(at(text, "Week menu"));

    expect(at(text, "Choose the week")).toBeLessThan(at(text, "Print the week"));
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "story_down", card: String(week), story: "21" }, session.cookie);
    text = await page();
    expect(at(text, "Print the week")).toBeLessThan(at(text, "Choose the week"));

    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "nice", card: String(week), story: "22", nice: "1" }, session.cookie);
    text = await page();
    expect(text).toContain('Print the week <span class="pill kind small">Nice to have</span>');
    expect(text).toContain("<strong>1 story left</strong>");
    const backlog = await (await get(`/projects/${REPO}/backlog?group=card`, session.cookie)).text();
    expect(at(backlog, "Print the week")).toBeLessThan(at(backlog, "Choose the week"));
    expect(backlog).toContain('Print the week</a> <span class="pill kind small">Nice to have</span>');
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["sprint_card_moved", "sprint_story_moved", "story_nice_set"]));
  });

  it("closes by itself once the needed stories are out: the card takes the version that shipped it", async () => {
    const { week, empty } = await seed();
    await env.DB.prepare("UPDATE cards SET release = NULL WHERE id = ?").bind(empty).run();
    const session = await writer();
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start" }, session.cookie);
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "nice", card: String(week), story: "22", nice: "1" }, session.cookie);
    // #21 ships in 0.58, an unrelated 0.59 ships after; #22 (nice to have) is not done.
    await env.DB.batch([
      env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'releases'").bind(
        JSON.stringify({ commitSha: "abc", releases: [release("0.59", "12:00"), release("0.58", "11:00", [21]), release("0.56", "10:00")] }),
        REPO,
      ),
      env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'").bind(
        JSON.stringify([story(21, "Choose the week", "closed"), story(22, "Print the week")]),
        REPO,
      ),
    ]);
    const page = await (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    expect(page).toContain("No sprint in progress");
    expect(page).toContain('shipped in <span class="mono">0.58</span>');
    expect(await releaseOf(week)).toBe("0.58");
    expect((await logActions()).map((entry) => entry.action)).toContain("sprint_shipped");
  });

  it("closes by hand: what is done takes its version, the rest goes back to Next release", async () => {
    const { week, empty } = await seed([release("0.58", "11:00", [21, 22]), release("0.56", "10:00")]);
    const session = await writer();
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start" }, session.cookie);
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(21, "Choose the week", "closed"), story(22, "Print the week", "closed")]), REPO)
      .run();
    // The card without a story keeps the sprint open; it is closed by hand.
    expect(await (await get(`/projects/${REPO}/sprint`, session.cookie)).text()).toContain('<h2>Sprint <span class="pill warn">In progress</span></h2>');
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "close" }, session.cookie);
    expect([await releaseOf(week), await releaseOf(empty)]).toEqual(["0.58", "Next release"]);
  });

  it("shows the release in progress on integration when no sprint runs, read-only for a tester", async () => {
    await seed([release("0.58", null), release("0.56", "10:00")]);
    await env.DB.prepare("UPDATE cards SET release = '0.58' WHERE title = 'Week menu'").run();
    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    const page = await (await get(`/projects/${REPO}/sprint`, tester.cookie)).text();
    expect(page).toContain('On integration: <span class="mono">0.58</span> Title 0.58');
    expect(page).toContain("Choose the week");
    expect(page).not.toContain("Start the sprint");
    expect((await post(`/projects/${REPO}/sprint`, { csrf: tester.csrf, action: "stop" }, tester.cookie)).status).toBe(403);
  });
});
