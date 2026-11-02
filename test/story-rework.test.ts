import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityStatement } from "../src/activity-log";
import type { Story } from "../src/stories";
import { get, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const J = { headers: { "content-type": "application/json" } };

function story(number: number, title: string, extra: Partial<Story> = {}): Story {
  return {
    number, title, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: 1,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }], ...extra,
  };
}

// A sprint with C1: #12, merged then tested, back in development with a feedback.
async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", langue: "en", workflows: { claude: "claude.yml" }, claude: { plafond: 2 } }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([
        story(1, "Epic", { parent: null, subTotal: 1 }),
        story(12, "Plan the week", { labels: ["rework"], pullRequests: [{ number: 30, url: `https://github.com/${REPO}/pull/30`, state: "merged" }] }),
      ]),
    ),
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO),
    activityStatement(env.DB, { actor: "tess", action: "story_feedback", repo: REPO, issueNumber: 12, details: { criterion: 0, criterion_text: "Works", text: "Nothing is saved", comment: `https://github.com/${REPO}/issues/12#issuecomment-1` } }),
  ]);
  const card = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', 'Week menu', '', 'Sprint', 1, 'pe') RETURNING id").bind(REPO).first<{ id: number }>())?.id ?? 0;
  await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref, position) VALUES (?, 'story', '12', 1)").bind(card).run();
}

const github = () => fetchMock.get("https://api.github.com");

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

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Rework a story with its feedbacks (la-fabrique#202)", () => {
  it("shows the story back in development with its feedbacks, and reworks it with Claude only when asked", async () => {
    await seed();
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), J);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), J);
    const { cookie, csrf } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/sprint`, cookie)).text();
    expect(page).toContain('<span class="pill warn small">Back in development</span>');
    expect(page).toMatch(/stories\/12#feedbacks">1 feedback<\/a>/);
    expect(page).toContain(">Rework with Claude</button>");
    // Nothing started by itself: no dispatch was made by showing the page.

    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), J);
    github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), J);
    let dispatched: unknown = null;
    github().intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` }).reply(204, (options) => {
      dispatched = JSON.parse(String(options.body));
      return "";
    });
    let comment = "";
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` }).reply(201, (options) => {
      comment = (JSON.parse(String(options.body)) as { body: string }).body;
      return "{}";
    }, J);
    const response = await post(`/projects/${REPO}/sprint`, { csrf, action: "rework", story: "12" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/sprint?notice=reworking&story=12`);
    expect(dispatched).toEqual({ ref: "main", inputs: { issue: "12", par: "admin-one", rework: "true" } });
    expect(comment).toContain("Claude reworks this story with its test feedbacks, launched by @admin-one");
    expect((await logActions()).map((entry) => entry.action)).toContain("story_rework_launched");
  });

  it("puts the story to test again when the rework's pull request is merged", async () => {
    await seed();
    const issue = { number: 12, title: "Plan the week", state: "open", html_url: "", labels: [{ name: "rework" }, { name: "P1" }], user: null, created_at: "", updated_at: "", closed_at: null, body: "" };
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), J).times(2);
    github().intercept({ path: `/repos/${REPO}/issues/12` }).reply(200, JSON.stringify(issue), J);
    let removed = false;
    github().intercept({ method: "DELETE", path: `/repos/${REPO}/issues/12/labels/rework` }).reply(200, () => {
      removed = true;
      return "[]";
    }, J);
    let comment = "";
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` }).reply(201, (options) => {
      comment = (JSON.parse(String(options.body)) as { body: string }).body;
      return "{}";
    }, J);
    const pull = { number: 41, merged_at: "2026-11-02T18:00:00Z", title: "Rework: save the week", body: "Refs #12", head: { ref: "claude/12-rework-7" } };
    expect((await webhook("pull_request", { action: "closed", repository: { full_name: REPO }, pull_request: pull })).status).toBe(200);
    expect(removed).toBe(true);
    expect(comment).toBe("The test feedbacks are taken into account (pull request #41 merged): the story is to test again (La Fabrique extraordinaire).");
    expect((await logActions()).map((entry) => entry.action)).toContain("story_rework_merged");
    // A pull request closed without merging changes nothing.
    expect((await webhook("pull_request", { action: "closed", repository: { full_name: REPO }, pull_request: { ...pull, merged_at: null } })).status).toBe(200);
  });
});
