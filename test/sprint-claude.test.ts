import { env, fetchMock, SELF } from "cloudflare:test";
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
    // The page reads the workflow's runs: #12's is in progress.
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(
        200,
        JSON.stringify({ workflow_runs: [{ display_title: "Claude #12", status: "in_progress", conclusion: null, html_url: "https://github.com/run/1", created_at: "2026-10-31T14:00:00Z", updated_at: "2026-10-31T14:01:00Z" }] }),
        JSON_HEADERS,
      );
    const after = await (await get(response.headers.get("location") ?? "", cookie)).text();
    expect(after).toContain("Claude Code launched on #12");
    expect(after).toContain("launched by @admin-one");
    expect(after).toMatch(/Claude is working: <a [^>]*class="pill warn small" href="https:\/\/github.com\/run\/1"[^>]*>Claude working<\/a>/);
    expect(after).toMatch(/href="https:\/\/github.com\/acme\/widget\/actions\/workflows\/claude.yml">Every Claude run on GitHub<\/a>/);
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

describe("One story at a time per card", () => {
  it("holds a card's other stories while one is in progress, on the page and on the server", async () => {
    await seed({ nom: "Widget", workflows: { claude: "claude.yml" }, claude: { plafond: 2 } });
    const card = (await env.DB.prepare("SELECT id FROM cards WHERE title = 'Week menu'").first<{ id: number }>())?.id ?? 0;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '15', 3)").bind(card),
      env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'").bind(
        JSON.stringify([
          story(1, "Epic", { parent: null, subTotal: 3 }),
          story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }] }),
          story(13, "Bare one", { criteria: [] }),
          story(15, "Next one"),
        ]),
        REPO,
      ),
    ]);
    const { cookie, csrf } = await signIn("admin-one");
    const runs = (list: unknown[]) =>
      github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: list }), JSON_HEADERS);
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(6);
    runs([]);
    github()
      .intercept({ path: `/repos/${REPO}/pulls/30` })
      .reply(200, JSON.stringify({ number: 30, title: "Story #12", html_url: "https://github.com/acme/widget/pull/30", state: "open", merged_at: null, draft: false, user: { login: "claude[bot]" }, requested_reviewers: [] }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    // #15 waits for #12, whose pull request is open; it is not the next one.
    expect(page).toMatch(/title="#15 waits for #12 of the same card: its pull request #30 is not merged yet\. One story at a time per card\.">Waits for <span class="mono">#12<\/span>/);
    expect(page).not.toContain('aria-label="Launch Claude on #15"');

    // Sent anyway (an old page, the MCP): refused with the same reason.
    runs([]);
    const refused = await post(`/projects/${REPO}/sprint`, { csrf, action: "launch", story: "15" }, cookie);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("#15 waits for #12 of the same card: its pull request #30 is not merged yet");

    // Claude working on #12, with no pull request yet: the same.
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one"), story(13, "Bare one", { criteria: [] }), story(15, "Next one")]), REPO)
      .run();
    runs([{ display_title: "Claude #12", status: "in_progress", html_url: "https://github.com/run/1" }]);
    const working = await post(`/projects/${REPO}/sprint`, { csrf, action: "launch", story: "15" }, cookie);
    expect(working.status).toBe(409);
    expect(await working.text()).toContain("#15 waits for #12 of the same card: Claude is working on it");

    // #12 merged: #15 can go.
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one", { pullRequests: [{ number: 30, url: "x", state: "merged" }] }), story(13, "Bare one", { criteria: [] }), story(15, "Next one")]), REPO)
      .run();
    runs([]);
    github().intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` }).reply(204, "");
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/15/comments` }).reply(201, "{}", JSON_HEADERS);
    const launched = await post(`/projects/${REPO}/sprint`, { csrf, action: "launch", story: "15" }, cookie);
    expect(launched.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=launched&story=15`);
  });
});

async function webhook(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return SELF.fetch("https://la-fabrique.test/api/github/webhook", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}` },
    body,
  });
}

describe("Claude's runs, as GitHub reports them", () => {
  it("reads the runs again, logs the end of a run, and leaves other workflows alone", async () => {
    await seed();
    await env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'claude_runs', '[]', ?)").bind(REPO, new Date().toISOString()).run();
    const run = (path: string, title: string) => ({
      action: "completed",
      repository: { full_name: REPO },
      workflow_run: { path, display_title: title, status: "completed", conclusion: "failure", html_url: "https://github.com/run/2", updated_at: "2026-10-31T15:00:00Z" },
    });

    // Another workflow: the Claude runs are not touched.
    expect((await webhook("workflow_run", run(".github/workflows/ci.yml", "CI"))).status).toBe(200);
    expect(await env.DB.prepare("SELECT kind FROM snapshots WHERE repo = ? AND kind = 'claude_runs'").bind(REPO).first()).toEqual({ kind: "claude_runs" });

    expect((await webhook("workflow_run", run(".github/workflows/claude.yml", "Claude #12"))).status).toBe(200);
    expect(await env.DB.prepare("SELECT kind FROM snapshots WHERE repo = ? AND kind = 'claude_runs'").bind(REPO).first()).toBeNull();
    const logged = await env.DB.prepare("SELECT actor, issue_number, details FROM activity_log WHERE action = 'claude_run_finished'").first<{ actor: string; issue_number: number; details: string }>();
    expect(logged).toMatchObject({ actor: "github", issue_number: 12 });
    expect(JSON.parse(logged?.details ?? "{}")).toEqual({ conclusion: "failure", url: "https://github.com/run/2" });
  });
});

describe("The pull request a Claude run opened", () => {
  it("is written in the log when the run ends: the story, the run and the pull request; an update says which one", async () => {
    await seed();
    const ended = (title: string) => ({
      action: "completed",
      repository: { full_name: REPO },
      workflow_run: {
        path: ".github/workflows/claude.yml",
        display_title: title,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/run/3",
        run_started_at: "2026-10-31T14:00:00Z",
        updated_at: "2026-10-31T14:20:00Z",
      },
    });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    const recent = (number: number, branch: string, created: string, body = "") => ({ number, title: "x", body, html_url: `https://github.com/acme/widget/pull/${number}`, created_at: created, head: { ref: branch } });
    github()
      .intercept({ path: `/repos/${REPO}/pulls?state=all&sort=created&direction=desc&per_page=20` })
      .reply(
        200,
        JSON.stringify([
          recent(41, "claude/12-ready-one", "2026-10-31T14:15:00Z"),
          recent(40, "claude/13-bare", "2026-10-31T14:10:00Z", "Refs #12"),
          recent(39, "claude/12-ready-one-old", "2026-10-30T09:00:00Z"),
        ]),
        JSON_HEADERS,
      );
    github().intercept({ method: "POST", path: "/graphql" }).reply(200, JSON.stringify({ data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } } }), JSON_HEADERS);
    expect((await webhook("workflow_run", ended("Claude #12"))).status).toBe(200);
    const opened = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'claude_pr_opened'").all<{ issue_number: number; details: string }>();
    expect(opened.results.map((row) => [row.issue_number, JSON.parse(row.details).pull])).toEqual([[12, 41]]);
    expect(JSON.parse(opened.results[0]?.details ?? "{}")).toEqual({ pull: 41, url: "https://github.com/acme/widget/pull/41", run: "https://github.com/run/3", conclusion: "success" });

    expect((await webhook("workflow_run", ended("Claude #12 · update #41"))).status).toBe(200);
    const updated = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'claude_pr_updated'").first<{ issue_number: number; details: string }>();
    expect(updated?.issue_number).toBe(12);
    expect(JSON.parse(updated?.details ?? "{}")).toMatchObject({ pull: 41, conclusion: "success" });
    const page = await (await get(`/projects/${REPO}/log`, (await signIn("admin-one")).cookie)).text();
    expect(page).toMatch(/Claude opened pull request <a [^>]*href="https:\/\/github.com\/acme\/widget\/pull\/41">#41<\/a> for/);
    expect(page).toMatch(/Claude brought pull request <a [^>]*href="https:\/\/github.com\/acme\/widget\/pull\/41">#41<\/a> of/);
  });
});

describe("The pull requests of the sprint's stories", () => {
  it("shows each story's pull request and the reviews asked, and asks one in the person's name", async () => {
    await seed();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(
        JSON.stringify([
          story(1, "Epic", { parent: null, subTotal: 3 }),
          story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }], branches: ["claude/12-ready"] }),
          story(13, "Bare one", { criteria: [] }),
        ]),
        REPO,
      )
      .run();
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/pulls/30` })
      .reply(200, JSON.stringify({ number: 30, title: "Story #12", html_url: "https://github.com/acme/widget/pull/30", state: "open", merged_at: null, draft: false, user: { login: "claude[bot]" }, requested_reviewers: [{ login: "admin-two" }] }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toMatch(/PR #30 open<\/a> <span class="muted small">review asked from @admin-two<\/span>/);
    // Who can be asked: the tech leads and super admins, not one already asked.
    expect(page).toContain('<option value="lead">@lead</option>');
    expect(page).not.toContain('<option value="admin-two">');
    // Three parts: the sprint, the work in progress (the open pull request), the features and stories.
    const at = (text: string) => page.indexOf(text);
    expect(at('id="sprint-work">Implementation</h2>')).toBeGreaterThan(0);
    // Two cards beside the features (la-fabrique#179): the sprint's status, the implementation.
    expect(page).toMatch(/<div class="sprint-layout">\s*<div class="sprint-side">\s*<section class="sprint-head sprint-panel"/);
    expect(page).toContain('<section class="sprint-work sprint-panel"');
    expect(page).toContain('<section class="sprint-stories sprint-main"');
    expect(at('id="sprint-stories">Features and stories</h2>')).toBeGreaterThan(at("Implementation</h2>"));
    expect(at("PR #30 open")).toBeGreaterThan(at("Implementation</h2>"));
    expect(at("PR #30 open")).toBeLessThan(at("Features and stories</h2>"));
    expect(page).toContain(`<a href="/projects/${REPO}/sprint/stories/12">Ready one</a> <span class="muted small">PR open</span>`);

    let asked: unknown = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/pulls/30/requested_reviewers` })
      .reply(201, (options) => {
        asked = JSON.parse(String(options.body));
        return "{}";
      });
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "review", pull: "30", reviewer: "lead" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=review`);
    expect(asked).toEqual({ reviewers: ["lead"] });
    expect((await logActions()).map((entry) => entry.action)).toContain("review_requested");
    // Only someone La Fabrique knows as a reviewer.
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "review", pull: "30", reviewer: "stranger" }, cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint`);
  });
});

describe("A pull request brought up to date with Claude", () => {
  it("shows a pull request in conflict with its base, and starts the workflow on it with `pr`", async () => {
    await seed();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(
        JSON.stringify([
          story(1, "Epic", { parent: null, subTotal: 3 }),
          story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }, { number: 29, url: "https://github.com/acme/widget/pull/29", state: "merged" }] }),
          story(13, "Bare one", { criteria: [], pullRequests: [{ number: 31, url: "https://github.com/acme/widget/pull/31", state: "open", guessed: true }] }),
        ]),
        REPO,
      )
      .run();
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    const detail = (number: number, mergeable: string) =>
      JSON.stringify({ number, title: "x", html_url: `https://github.com/acme/widget/pull/${number}`, state: "open", merged_at: null, user: { login: "someone" }, requested_reviewers: [], mergeable_state: mergeable, base: { ref: "main" } });
    github().intercept({ path: `/repos/${REPO}/pulls/30` }).reply(200, detail(30, "dirty"), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/pulls/31` }).reply(200, detail(31, "clean"), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain('PR #30 open</a> <span class="pill alert small">In conflict with <code>main</code></span>');
    expect(page).toContain('aria-label="Bring pull request #30 up to date with Claude">Update with Claude</button>');
    expect(page).not.toContain("Bring pull request #31 up to date");
    // A link that only the text makes says so.
    expect(page).toMatch(/PR #31 open<\/a> <span class="muted small" title="[^"]*">guessed from its text<\/span>/);

    // Started: the same workflow, with the pull request; a word on it; logged.
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    let dispatched: unknown = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` })
      .reply(204, (options) => {
        dispatched = JSON.parse(String(options.body));
        return "";
      });
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/30/comments` })
      .reply(201, (options) => {
        comment = JSON.parse(String(options.body)).body;
        return "{}";
      });
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "update", story: "12", pull: "30" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=updating&story=12&pull=30`);
    expect(dispatched).toEqual({ ref: "main", inputs: { issue: "12", par: "lead", pr: "30" } });
    expect(comment).toContain("Claude remet cette PR à jour");
    const logged = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'claude_update_launched'").first<{ issue_number: number; details: string }>();
    expect(logged?.issue_number).toBe(12);
    expect(JSON.parse(logged?.details ?? "{}")).toMatchObject({ pull: 30 });

    // Not a pull request of the story, or a merged one: nothing is started.
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "update", story: "12", pull: "29" }, cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint`);
    expect((await post(`/projects/${REPO}/sprint`, { csrf, action: "update", story: "12", pull: "31" }, cookie)).headers.get("location")).toBe(`/projects/${REPO}/sprint`);
    // Not for a Product Engineer.
    await grantRole("pe", "product_engineer");
    const pe = await signIn("pe");
    expect((await post(`/projects/${REPO}/sprint`, { csrf: pe.csrf, action: "update", story: "12", pull: "30" }, pe.cookie)).status).toBe(403);
  });
});

describe("Merging a pull request from the sprint", () => {
  it("offers Merge to the super admin when the project declares its merge workflow, and starts it", async () => {
    await seed({ nom: "Widget", workflows: { claude: "claude.yml", fusionner: "merge.yml" }, claude: { plafond: 1 } });
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }] })]), REPO)
      .run();
    const detail = JSON.stringify({ number: 30, title: "x", html_url: "https://github.com/acme/widget/pull/30", state: "open", merged_at: null, user: { login: "someone" }, requested_reviewers: [], mergeable_state: "clean", base: { ref: "main" } });
    const sprintReads = () => {
      github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
      github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
      github().intercept({ path: `/repos/${REPO}/pulls/30` }).reply(200, detail, JSON_HEADERS);
    };
    // A tech lead does not merge into production.
    await grantRole("lead", "tech_lead");
    const lead = await signIn("lead");
    sprintReads();
    expect(await (await get(`/projects/${REPO}/sprint`, lead.cookie)).text()).not.toContain("Merge pull request #30");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/pulls/30` }).reply(200, detail, JSON_HEADERS);
    expect((await post(`/projects/${REPO}/sprint`, { csrf: lead.csrf, action: "merge", pull: "30" }, lead.cookie)).status).toBe(403);

    const { cookie, csrf } = await signIn("admin-one");
    // Claude's runs were read a moment ago (kept 30 seconds).
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/pulls/30` }).reply(200, detail, JSON_HEADERS);
    expect(await (await get(`/projects/${REPO}/sprint`, cookie)).text()).toContain('aria-label="Merge pull request #30">Merge</button>');
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github().intercept({ path: `/repos/${REPO}/pulls/30` }).reply(200, detail, JSON_HEADERS);
    let dispatched: unknown = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/merge.yml/dispatches` })
      .reply(204, (options) => {
        dispatched = JSON.parse(String(options.body));
        return "";
      });
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "merge", pull: "30" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=merging&pull=30`);
    expect(dispatched).toEqual({ ref: "main", inputs: { pr: "30", par: "admin-one" } });
    expect((await logActions()).map((entry) => entry.action)).toContain("pull_merge_launched");
  });
});

describe("A merged story in the sprint", () => {
  it("is To validate, and points to To test", async () => {
    await seed();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one", { pullRequests: [{ number: 29, url: "https://github.com/acme/widget/pull/29", state: "merged" }] })]), REPO)
      .run();
    await grantRole("pe", "product_engineer");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, (await signIn("pe")).cookie)).text();
    expect(page).toContain('<span class="pill stage-to_validate warn">To validate</span> <span class="muted small">0/1 criteria checked</span> <a class="small" href="/projects/acme/widget/to-test#story-12">Test it</a>');
  });
});

describe("A merge refused", () => {
  it("says why, from the run's annotation, in the log and next to the pull request in the sprint", async () => {
    await seed({ nom: "Widget", workflows: { claude: "claude.yml", fusionner: "merge.yml" }, claude: { plafond: 1 } });
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }] })]), REPO)
      .run();
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/actions/runs/77/jobs` }).reply(200, JSON.stringify({ jobs: [{ id: 501, conclusion: "failure" }] }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/check-runs/501/annotations` })
      .reply(
        200,
        JSON.stringify([
          { annotation_level: "failure", title: "Merge refused", message: "Conflicts with main in: CLAUDE.md src/rights.ts. Bring the pull request up to date first (Update with Claude), then merge again." },
          { annotation_level: "failure", title: "", message: "Process completed with exit code 1." },
        ]),
        JSON_HEADERS,
      );
    const run = { id: 77, path: ".github/workflows/merge.yml", display_title: "Merge #30", status: "completed", conclusion: "failure", html_url: "https://github.com/run/77" };
    expect((await webhook("workflow_run", { action: "completed", repository: { full_name: REPO }, workflow_run: run })).status).toBe(200);
    const logged = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'pull_merge_finished'").first<{ issue_number: number; details: string }>();
    expect(logged?.issue_number).toBe(30);
    expect(JSON.parse(logged?.details ?? "{}")).toEqual({
      conclusion: "failure",
      reason: "Conflicts with main in: CLAUDE.md src/rights.ts. Bring the pull request up to date first (Update with Claude), then merge again.",
      url: "https://github.com/run/77",
    });

    const { cookie } = await signIn("admin-one");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/pulls/30` })
      .reply(200, JSON.stringify({ number: 30, title: "x", html_url: "https://github.com/acme/widget/pull/30", state: "open", merged_at: null, user: { login: "someone" }, requested_reviewers: [], mergeable_state: "dirty", base: { ref: "main" } }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain('<span class="pill alert small">Merge refused</span> <span class="small">Conflicts with main in: CLAUDE.md src/rights.ts.');
    expect(page).toMatch(/<a [^>]*class="small" href="https:\/\/github.com\/run\/77">the run<\/a>/);
    const log = await (await get(`/projects/${REPO}/log`, cookie)).text();
    expect(log).toContain("refused: Conflicts with main in: CLAUDE.md src/rights.ts.");
  });
});

describe("A pull request opened by the only reviewer, on a project without a merge workflow", () => {
  it("says there is no one else to ask, and where to merge it; no branch menu on the sprint", async () => {
    await seed();
    await env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'")
      .bind(JSON.stringify([story(1, "Epic", { parent: null, subTotal: 3 }), story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }] })]), REPO)
      .run();
    const { cookie } = await signIn("admin-one");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/pulls/30` })
      .reply(200, JSON.stringify({ number: 30, title: "x", html_url: "https://github.com/acme/widget/pull/30", state: "open", merged_at: null, user: { login: "Admin-One" }, requested_reviewers: [], mergeable_state: "clean", base: { ref: "main" } }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    // admin-two is a super admin too (SUPER_ADMINS): the only one left to ask.
    expect(page).toContain('<option value="admin-two">@admin-two</option>');
    expect(page).not.toContain('<option value="Admin-One">');
    expect(page).toMatch(/no merge workflow declared \(<a [^>]*href="\/projects\/acme\/widget\/setup">workflows\.fusionner<\/a>\): <a [^>]*href="https:\/\/github.com\/acme\/widget\/pull\/30">merge it on GitHub<\/a>/);
    expect(page).not.toContain("data-branch-menu");
  });
});

describe("The sprint of a project with an integration branch", () => {
  it("leads to the go in Production, and shows no reference-branch banner", async () => {
    await seed({ nom: "Widget", branches: { production: "main", integration: "integration" }, workflows: { claude: "claude.yml" }, claude: { plafond: 1 } });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint?ref=integration`, (await signIn("admin-one")).cookie)).text();
    expect(page).toMatch(/the release is the go: test the stories on int, then give the go, here or in <a [^>]*href="\/projects\/acme\/widget\/production">Production<\/a>; once it is out, the sprint closes/);
    expect(page).not.toContain("ref-banner");
  });
});

describe("A story's page, from the sprint", () => {
  it("shows its steps, its criteria, its pull request, Claude's runs and its history", async () => {
    await seed();
    await env.DB.batch([
      env.DB.prepare("UPDATE snapshots SET data = ? WHERE repo = ? AND kind = 'stories'").bind(
        JSON.stringify([
          story(1, "Epic", { parent: null, subTotal: 3 }),
          story(12, "Ready one", { pullRequests: [{ number: 30, url: "https://github.com/acme/widget/pull/30", state: "open" }], criteria: [{ text: "Works", done: true }, { text: "Fast", done: false }] }),
        ]),
        REPO,
      ),
      env.DB.prepare("INSERT INTO activity_log (actor, action, repo, issue_number, details) VALUES ('lead', 'claude_launched', ?, 12, '{}')").bind(REPO),
      env.DB.prepare("INSERT INTO activity_log (actor, action, repo, issue_number, details) VALUES ('lead', 'review_requested', ?, 30, ?)").bind(REPO, JSON.stringify({ pull: 30, reviewer: "admin-two" })),
    ]);
    await grantRole("pe", "product_engineer");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
    github()
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(200, JSON.stringify({ workflow_runs: [{ id: 5, name: "Claude #12", display_title: "Claude #12", status: "completed", conclusion: "success", html_url: "https://github.com/acme/widget/actions/runs/5", created_at: "2026-10-30T10:00:00Z", updated_at: "2026-10-30T10:20:00Z" }] }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/pulls/30` })
      .reply(200, JSON.stringify({ number: 30, title: "Story #12", html_url: "https://github.com/acme/widget/pull/30", state: "open", merged_at: null, draft: false, user: { login: "claude[bot]" }, requested_reviewers: [{ login: "admin-two" }], base: { ref: "main" } }), JSON_HEADERS);
    const page = await (await get(`/projects/${REPO}/sprint/stories/12`, (await signIn("pe")).cookie)).text();
    expect(page).toContain(`<a href="/projects/${REPO}/sprint">Sprint</a>`);
    expect(page).toContain("<h1>#12 Ready one</h1>");
    expect(page).toMatch(/href="https:\/\/github.com\/acme\/widget\/issues\/12">Issue #12 on GitHub<\/a>/);
    // Ready and Claude done; the pull request is where it stands.
    expect(page).toMatch(/<li class="story-step done">[^]*?<strong>Ready for dev<\/strong>/);
    expect(page).toMatch(/<li class="story-step done">[^]*?<strong>Claude at work<\/strong> <span class="muted small">Launched by @lead/);
    expect(page).toMatch(/<li class="story-step current">[^]*?<strong>Pull request<\/strong> <span class="muted small">Open, waiting for its merge/);
    expect(page).toMatch(/<li class="story-step waiting">[^]*?<strong>In production<\/strong>/);
    expect(page).toContain('Acceptance criteria <span class="muted mono">1/2</span>');
    expect(page).toMatch(/href="https:\/\/github.com\/acme\/widget\/pull\/30">PR #30<\/a> Story #12/);
    expect(page).toContain("review asked from @admin-two");
    expect(page).toContain('href="https://github.com/acme/widget/actions/runs/5">success</a>');
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain("History");
    expect(page).toMatch(/@lead<\/td>/);
    // Not a number: not found.
    expect((await get(`/projects/${REPO}/sprint/stories/x`, (await signIn("pe")).cookie)).status).toBe(404);
  });
});
