import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Card } from "../src/cards";
import type { CardStory } from "../src/card-stories";
import type { StoryCards } from "../src/card-groups";
import { planRelease, proposeVersion } from "../src/sprint-release";
import { activityStatement } from "../src/activity-log";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const story = (number: number, title: string, state = "open") => ({
  number, title, state, labels: [], url: "", author: null, parent: null,
  subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [],
});
const release = (version: string, time: string | null, stories: number[] | null = null, title = `Title ${version}`) =>
  ({ version, date: "2026-10-01", time, title, changes: [], links: [], stories, upcoming: time === null });

describe("proposeVersion", () => {
  it("proposes the next minor and major after the newest release", () => {
    expect(proposeVersion("0.78", "minor")).toBe("0.79");
    expect(proposeVersion("0.78", "major")).toBe("1.0");
    expect(proposeVersion("v1.169", "minor")).toBe("v1.170");
    expect(proposeVersion("v1.169", "major")).toBe("v2.0");
    expect(proposeVersion(null, "minor")).toBeNull();
  });
});

describe("planRelease", () => {
  const card = (id: number, title: string) => ({ id, title }) as Card;
  const links = { order: new Map([[1, [10, 11]], [2, [20]]]), nice: new Set<string>() } as unknown as StoryCards;
  const st = (number: number, stage: CardStory["stage"]) => [number, { number, title: `S${number}`, stage, closed: false } as CardStory] as const;
  const checks = (numbers: number[]) => new Map(numbers.map((n) => [n, { validated: { by: "qa", at: "", version: null }, defects: [] }]));

  it("takes the cards done and the next entries that declare one of their stories; the rest stays with its reason", () => {
    const plan = planRelease({
      cards: [card(1, "Week"), card(2, "Print")],
      links,
      stories: new Map([st(10, "to_validate"), st(11, "to_validate"), st(20, "to_validate")]),
      checks: checks([10, 11]),
      notes: [
        release("next", null, [10, 20], "Mixed"),
        release("next", null, [20], "Only not done"),
        release("next", null, [], "No story"),
        release("0.78", "00:26"),
      ] as never,
      releases: [{ version: "0.78", title: null, state: "shipped" }],
    });
    expect(plan.cards.map((c) => c.done)).toEqual([true, false]);
    expect(plan.cards[1]?.stories[0]?.reason).toBe("merged, not validated in To test");
    expect(plan.stories.sort()).toEqual([10, 11]);
    expect(plan.entries.map((e) => [e.title, e.taken, e.reason])).toEqual([
      ["Mixed", true, null],
      ["Only not done", false, "declares only stories not done"],
      ["No story", false, "declares no story"],
    ]);
    expect([plan.minor, plan.major]).toEqual(["0.79", "1.0"]);
    expect(plan.title).toBe("Week");
    expect(plan.entries[0]).toMatchObject({ partial: true, caveat: "Partial: not done yet, #20 S20." });
    expect(plan.entries[1]?.partial).toBe(false);
    expect(plan.notDone).toEqual([{ number: 20, title: "S20" }]);
  });
});

async function seed(workflows: Record<string, string> = { publier: "publier.yml" }): Promise<{ week: number }> {
  const config = { nom: "Widget", version: { fichier: "notes.json", forme: "0.N" }, workflows };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'releases', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify({ commitSha: "abc", releases: [release("next", null, [21], "Week change"), release("0.78", "10:00")] }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(21, "Choose the week")]),
    ),
  ]);
  const week = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 'Sprint', 1, 'pe') RETURNING id").bind(REPO).first<{ id: number }>())?.id ?? 0;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '21')").bind(week),
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO),
    activityStatement(env.DB, { actor: "qa", action: "story_validated", repo: REPO, issueNumber: 21, details: { version: null } }),
  ]);
  return { week };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const TOKEN = () => fetchMock.get("https://api.github.com").intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs" }), JSON_HEADERS);

describe("Close the sprint makes the release", () => {
  it("asks minor or major with a title, shows what is taken, and starts nothing until confirmed", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const page = await (await post(`/projects/${REPO}/sprint`, { csrf, action: "close" }, cookie)).text();
    expect(page).toContain("Minor: <span class=\"mono\">0.79</span>");
    expect(page).toContain("Major: <span class=\"mono\">1.0</span>");
    expect(page).toContain('value="Week menu"');
    expect(page).toContain("The release takes");
    expect(page).toContain("Week change");
    expect((await logActions()).map((entry) => entry.action)).not.toContain("release_started");
  });

  it("dispatches the project's release workflow on confirmation and logs it; the sprint stays open", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    TOKEN();
    let sent: unknown = null;
    fetchMock.get("https://api.github.com").intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/publier.yml/dispatches` }).reply(204, (options) => {
      sent = JSON.parse(String(options.body));
      return "";
    });
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "release", kind: "major", title: "Weekly menus" }, cookie);
    expect(response.status).toBe(303);
    expect(sent).toEqual({ ref: "main", inputs: { version: "1.0", titre: "Weekly menus", stories: "21", par: "pe" } });
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["sprint_close_requested", "release_started"]));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sprints WHERE ended_at IS NULL").first<{ n: number }>())?.n).toBe(1);
  });

  it("is refused with a link to Setup when the project declares no release workflow; nothing changes", async () => {
    await seed({});
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "close" }, cookie);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("workflows.publier");
    expect((await logActions()).map((entry) => entry.action)).not.toContain("release_started");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sprints WHERE ended_at IS NULL").first<{ n: number }>())?.n).toBe(1);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain(`/projects/${REPO}/setup`);
  });

  it("is not offered to a tech lead or a tester, and refused if asked", async () => {
    await seed();
    for (const [login, role] of [["lead", "tech_lead"], ["qa2", "tester"]] as const) {
      await grantRole(login, role);
      const { cookie, csrf } = await signIn(login);
      expect(await (await get(`/projects/${REPO}/sprint`, cookie)).text()).not.toContain("Close the sprint");
      expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "release", kind: "minor", title: "x" }, cookie)).status).toBe(403);
    }
  });

  it("once the release workflow succeeds: the card takes the version, the validated story is closed, all logged", async () => {
    const { week } = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    TOKEN();
    fetchMock.get("https://api.github.com").intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/publier.yml/dispatches` }).reply(204, "");
    await post(`/projects/${REPO}/sprint`, { csrf, action: "release", kind: "minor", title: "Weekly menus" }, cookie);
    const github = fetchMock.get("https://api.github.com");
    TOKEN();
    github.intercept({ method: "GET", path: `/repos/${REPO}/issues/21` }).reply(200, JSON.stringify({ number: 21, title: "Choose the week", state: "open", labels: [], html_url: "", user: null, created_at: "", updated_at: "", closed_at: null }), JSON_HEADERS);
    let comment = "";
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues/21/comments` }).reply(201, (options) => {
      comment = String(options.body);
      return "{}";
    });
    github.intercept({ method: "PATCH", path: `/repos/${REPO}/issues/21` }).reply(200, "{}", JSON_HEADERS);
    const { releaseRunEvent } = await import("../src/sprint-release");
    const { findProject } = await import("../src/projects");
    const project = (await findProject(env.DB, REPO))!;
    expect(await releaseRunEvent(env, project, "completed", { conclusion: "success", path: ".github/workflows/publier.yml" } as never)).toBe(true);
    expect(comment).toContain("En production en version 0.79");
    expect((await env.DB.prepare("SELECT release FROM cards WHERE id = ?").bind(week).first<{ release: string }>())?.release).toBe("0.79");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sprints WHERE ended_at IS NULL").first<{ n: number }>())?.n).toBe(0);
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["release_published", "card_versioned", "story_closed", "sprint_shipped"]));
    // Once per release.
    expect(await releaseRunEvent(env, project, "completed", { conclusion: "success", path: ".github/workflows/publier.yml" } as never)).toBe(false);
  });
});

describe("the release, followed from the sprint", () => {
  it("shows the release in progress with a link to its runs, then why it failed; the sprint stays open", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    TOKEN();
    fetchMock.get("https://api.github.com").intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/publier.yml/dispatches` }).reply(204, "");
    await post(`/projects/${REPO}/sprint`, { csrf, action: "release", kind: "minor", title: "Weekly menus" }, cookie);
    const running = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(running).toContain('<strong>Release <span class="mono">0.79</span> in progress</strong>');
    expect(running).toMatch(/href="https:\/\/github.com\/acme\/widget\/actions\/workflows\/publier.yml">Follow it on GitHub<\/a>/);

    const github = fetchMock.get("https://api.github.com");
    TOKEN();
    github.intercept({ path: `/repos/${REPO}/actions/runs/88/jobs` }).reply(200, JSON.stringify({ jobs: [{ id: 601, conclusion: "failure" }] }), JSON_HEADERS);
    github
      .intercept({ path: `/repos/${REPO}/check-runs/601/annotations` })
      .reply(200, JSON.stringify([{ annotation_level: "failure", title: "Release refused", message: "Version 0.79 is already in the release notes." }]), JSON_HEADERS);
    const { releaseRunEvent } = await import("../src/sprint-release");
    const { findProject } = await import("../src/projects");
    const project = (await findProject(env.DB, REPO))!;
    expect(await releaseRunEvent(env, project, "completed", { id: 88, conclusion: "failure", path: ".github/workflows/publier.yml", html_url: "https://github.com/run/88" } as never)).toBe(true);
    const failed = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(failed).toContain('<strong>Release <span class="mono">0.79</span> failed</strong>: Version 0.79 is already in the release notes.');
    expect(failed).toContain("The sprint is still open: close it again once fixed.");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sprints WHERE ended_at IS NULL").first<{ n: number }>())?.n).toBe(1);
    expect((await logActions()).map((entry) => entry.action)).toContain("release_failed");
    // Once per release.
    expect(await releaseRunEvent(env, project, "completed", { id: 88, conclusion: "failure", path: ".github/workflows/publier.yml" } as never)).toBe(false);
  });
});

describe("a partial change is warned about before the close", () => {
  async function seedPartial(): Promise<void> {
    await seed();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'releases'")
      .bind(JSON.stringify({ commitSha: "abc", releases: [release("next", null, [21, 22], "Week change"), release("0.78", "10:00")] }), REPO)
      .run();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(21, "Choose the week"), { ...story(22, "Print the week"), pullRequests: [{ number: 5, state: "MERGED", merged: true }] }]), REPO)
      .run();
    await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) SELECT id, 'story', '22' FROM cards WHERE title = 'Week menu'").run();
  }

  it("warns, lets the person postpone (nothing released) or go on to the partial entry with its caveat", async () => {
    await seedPartial();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const warning = await (await post(`/projects/${REPO}/sprint`, { csrf, action: "close" }, cookie)).text();
    expect(warning).toContain("Before closing the sprint");
    expect(warning).toContain("kept for a later release");
    expect(warning).toContain("Postpone the close");
    expect(warning).toContain("Partial: not done yet, #22");
    expect((await logActions()).map((entry) => entry.action)).not.toContain("release_started");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sprints WHERE ended_at IS NULL").first<{ n: number }>())?.n).toBe(1);
    const preview = await (await post(`/projects/${REPO}/sprint`, { csrf, action: "close", confirm: "1" }, cookie)).text();
    expect(preview).toContain("The release takes");
    expect(preview).toContain("partial");
    expect(preview).toContain("Partial: not done yet, #22");
  });
});
