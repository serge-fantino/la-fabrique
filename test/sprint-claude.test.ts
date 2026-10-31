import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

function story(number: number, title: string, extra: Partial<Story> = {}): Story {
  return {
    number, title, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: 1,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }], ...extra,
  };
}

// A sprint running with C1: #13 (not ready) then #12 (ready), and #14 ready but from no sprint card.
async function seed(config: Record<string, unknown> = { nom: "Widget", workflows: { claude: "claude.yml" }, claude: { plafond: 1 } }): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one"), story(13, "Bare one", { criteria: [] }), story(14, "Elsewhere")]),
    ),
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO),
  ]);
  const card = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 'Sprint', 1, 'pe') RETURNING id")
    .bind(REPO)
    .first<{ id: number }>())?.id ?? 0;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '13', 1)").bind(card),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '12', 2)").bind(card),
  ]);
}

function github() {
  return fetchMock.get("https://api.github.com");
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Claude Code from the sprint", () => {
  it("shows the next story for Claude, in the sprint's order, to tech leads only", async () => {
    await seed();
    await grantRole("lead", "tech_lead");
    const page = await (await get(`/projects/${REPO}/sprint`, (await signIn("lead")).cookie)).text();
    expect(page).toMatch(/Next for Claude: <a [^>]*issues\/12">#12<\/a> Ready one/);
    expect(page).toContain('aria-label="Launch Claude on #12">Launch the next story</button>');
    expect(page).toContain('aria-label="Launch Claude on #12">Launch Claude</button>');
    expect(page).not.toContain("Launch Claude on #13");
    expect(page).toContain("At most 1 Claude run at once");

    await grantRole("pe", "product_engineer");
    const pe = await signIn("pe");
    expect(await (await get(`/projects/${REPO}/sprint`, pe.cookie)).text()).not.toContain("Launch the next story");
    expect((await post(`/projects/${REPO}/sprint`, { csrf: pe.csrf, action: "launch", story: "12" }, pe.cookie)).status).toBe(403);
  });

  it("says how to declare the workflow when the project has none", async () => {
    await seed({ nom: "Widget" });
    await grantRole("lead", "tech_lead");
    const page = await (await get(`/projects/${REPO}/sprint`, (await signIn("lead")).cookie)).text();
    expect(page).toContain("the project declares its Claude workflow (<code>workflows.claude</code>");
    expect(page).not.toContain("Launch the next story");
  });

  it("launches the project's workflow on a story of the sprint, and says why when it cannot", async () => {
    await seed();
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    let dispatched: unknown = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` })
      .reply(204, (options) => {
        dispatched = JSON.parse(String(options.body));
        return "";
      });
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` }).reply(201, "{}", JSON_HEADERS);

    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "launch", story: "12" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=launched&story=12`);
    expect(dispatched).toEqual({ ref: "main", inputs: { issue: "12", par: "admin-one" } });
    expect((await logActions()).map((entry) => entry.action)).toContain("claude_launched");
    const after = await (await get(response.headers.get("location") ?? "", cookie)).text();
    expect(after).toContain("Claude Code launched on #12");
    expect(after).toContain("Claude launched by @admin-one");
    // Launched: no longer the next one.
    expect(after).toContain("No story ready for Claude");

    // A story outside the sprint is not launched from it.
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "launch", story: "14" }, cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint`);

    // At the cap, the page says so.
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(200, JSON.stringify({ workflow_runs: [{ status: "in_progress", html_url: "x" }] }), JSON_HEADERS);
    const refused = await post(`/projects/${REPO}/sprint`, { csrf, action: "launch", story: "12" }, cookie);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("Claude already runs 1 time on this project (cap 1)");
  });
});
