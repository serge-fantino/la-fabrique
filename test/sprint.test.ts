import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const CONFIG = { nom: "Widget", version: { fichier: "notes.json", forme: "0.N" } };
const story = (number: number, title: string) => ({
  number, title, state: "open", labels: [], url: "", author: null, parent: null,
  subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [],
});
const release = (version: string, time: string | null) => ({ version, date: "2026-10-01", time, title: `Title ${version}`, changes: [], links: [], stories: null, upcoming: time === null });

async function seed(releases: unknown[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'releases', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify({ commitSha: "abc", releases })),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(21, "Choose the week"), story(22, "Print the week")]),
    ),
    env.DB.prepare("INSERT INTO card_values (repo, dimension, value, position, created_by) VALUES (?, 'release', '0.57', 1, 'pe')").bind(REPO),
  ]);
  const card = async (title: string, release: string | null) =>
    (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', ?, '', ?, 1, 'pe') RETURNING id")
      .bind(REPO, title, release)
      .first<{ id: number }>())?.id ?? 0;
  const c1 = await card("Week menu", "0.57");
  await card("Other release", "0.56");
  await card("No story yet", "0.57");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '21')").bind(c1),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '22')").bind(c1),
  ]);
}

describe("The sprint", () => {
  it("starts on a planned release, shows its cards and stories, one at a time, and stops", async () => {
    await seed([release("0.56", "10:00")]);
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");

    const before = await (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    expect(before).toContain("No sprint in progress.");
    expect(before).toContain('<input type="hidden" name="release" value="0.57" />');

    expect((await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start", release: "0.56" }, session.cookie)).headers.get("location")).toBe(
      `/projects/${REPO}/sprint?failure=not_planned`,
    );
    const started = await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start", release: "0.57" }, session.cookie);
    expect(started.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=started`);

    const page = await (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    expect(page).toContain('<span class="mono">0.57</span> <span class="pill warn">In progress</span>');
    expect(page).toContain("Started by <span class=\"mono\">@pe</span>");
    expect(page).toContain("<strong>2 stories left before the release</strong> · 2 cards, 2 stories, 0 in production.");
    expect(page).toContain("Week menu");
    expect(page).toContain("Choose the week");
    expect(page).toContain("No story yet: <a");
    expect(page).not.toContain("Other release");
    // On the board, the lane says Sprint.
    expect(await (await get(`/projects/${REPO}/board?by=release`, session.cookie)).text()).toContain('0.57 <span class="pill warn small">Sprint</span>');

    // One at a time.
    await env.DB.prepare("INSERT INTO card_values (repo, dimension, value, position, created_by) VALUES (?, 'release', '0.58', 2, 'pe')").bind(REPO).run();
    expect((await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start", release: "0.58" }, session.cookie)).headers.get("location")).toBe(
      `/projects/${REPO}/sprint?failure=running`,
    );

    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "stop" }, session.cookie);
    expect(await (await get(`/projects/${REPO}/sprint`, session.cookie)).text()).toContain("No sprint in progress.");
    expect((await logActions()).map((entry) => entry.action).filter((action) => action.startsWith("sprint_"))).toEqual(["sprint_started", "sprint_stopped"]);
  });

  it("orders the cards, then each card's stories; a nice-to-have story does not hold the release", async () => {
    await seed([release("0.56", "10:00")]);
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start", release: "0.57" }, session.cookie);
    const ids = (await env.DB.prepare("SELECT id, title FROM cards WHERE release = '0.57' ORDER BY id").all<{ id: number; title: string }>()).results;
    const [week, empty] = [ids[0]?.id ?? 0, ids[1]?.id ?? 0];
    const page = async () => (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    const at = (text: string, needle: string) => text.indexOf(needle);

    // Cards: the board's order, moved in the sprint.
    let text = await page();
    expect(at(text, "Week menu")).toBeLessThan(at(text, "No story yet"));
    const moved = await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "card_up", card: String(empty) }, session.cookie);
    expect(moved.headers.get("location")).toBe(`/projects/${REPO}/sprint#card-${empty}`);
    text = await page();
    expect(at(text, "No story yet")).toBeLessThan(at(text, "Week menu"));

    // Stories in the card: #21 then #22, then #22 first.
    expect(at(text, "Choose the week")).toBeLessThan(at(text, "Print the week"));
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "story_down", card: String(week), story: "21" }, session.cookie);
    text = await page();
    expect(at(text, "Print the week")).toBeLessThan(at(text, "Choose the week"));

    // Nice to have: shown, and no longer left before the release.
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "nice", card: String(week), story: "22", nice: "1" }, session.cookie);
    text = await page();
    expect(text).toContain('Print the week <span class="pill kind small">Nice to have</span>');
    expect(text).toContain("<strong>1 story left before the release</strong>");
    // The same order and mark in the backlog, by card.
    const backlog = await (await get(`/projects/${REPO}/backlog?group=card`, session.cookie)).text();
    expect(at(backlog, "Print the week")).toBeLessThan(at(backlog, "Choose the week"));
    expect(backlog).toContain('Print the week</a> <span class="pill kind small">Nice to have</span>');
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["sprint_card_moved", "sprint_story_moved", "story_nice_set"]));
  });

  it("ends by itself when the release notes date the release", async () => {
    await seed([release("0.56", "10:00")]);
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    await post(`/projects/${REPO}/sprint`, { csrf: session.csrf, action: "start", release: "0.57" }, session.cookie);
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'releases'")
      .bind(JSON.stringify({ commitSha: "abc", releases: [release("0.57", "11:00"), release("0.56", "10:00")] }), REPO)
      .run();
    const page = await (await get(`/projects/${REPO}/sprint`, session.cookie)).text();
    expect(page).toContain("The last one, <span class=\"mono\">0.57</span>, is out.");
    expect((await logActions()).map((entry) => entry.action)).toContain("sprint_shipped");
  });

  it("shows the release in progress on integration when no sprint was started, and is read-only for a tester", async () => {
    await seed([release("0.58", null), release("0.56", "10:00")]);
    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    const page = await (await get(`/projects/${REPO}/sprint`, tester.cookie)).text();
    expect(page).toContain('<span class="mono">0.58</span> Title 0.58 <span class="pill warn">In progress</span>');
    expect(page).toContain("In progress on the project's integration branch");
    expect(page).not.toContain("Start the sprint");
    expect((await post(`/projects/${REPO}/sprint`, { csrf: tester.csrf, action: "stop" }, tester.cookie)).status).toBe(403);
  });
});
