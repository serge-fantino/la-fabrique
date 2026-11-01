import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityStatement } from "../src/activity-log";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const ISSUE = {
  number: 41,
  title: "Plan the week",
  state: "closed",
  state_reason: "completed",
  html_url: `https://github.com/${REPO}/issues/41`,
  user: { login: "pe" },
  labels: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  closed_at: "2026-11-01T00:00:00Z",
};

async function seed(linked = true): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", langue: "en", branches: { production: "main" } }),
    ),
    env.DB.prepare("INSERT INTO cards (id, repo, kind, status, title, position, author) VALUES (5, ?, 'feature', 'validated', 'Menu', 1, 'pe')").bind(REPO),
    ...(linked ? [env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (5, 'story', '41')")] : []),
  ]);
}

function closer(node: unknown) {
  return JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [{ closer: node }] } } } } });
}

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

describe("A story closed by a merge before its validation (la-fabrique#186)", () => {
  it("is opened again, with a word on the issue and in the log", async () => {
    await seed();
    const github = () => fetchMock.get("https://api.github.com");
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ method: "POST", path: "/graphql" }).reply(200, closer({ __typename: "PullRequest", number: 185 }), JSON_HEADERS);
    let patch: unknown = null;
    github()
      .intercept({ method: "PATCH", path: `/repos/${REPO}/issues/41` })
      .reply(200, (options) => {
        patch = JSON.parse(String(options.body));
        return JSON.stringify({ ...ISSUE, state: "open" });
      });
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/41/comments` })
      .reply(201, (options) => {
        comment = JSON.parse(String(options.body)).body;
        return "{}";
      });
    const response = await webhook("issues", { action: "closed", repository: { full_name: REPO }, issue: ISSUE });
    expect(await response.json()).toEqual({ updated: 41, reopened: true });
    expect(patch).toEqual({ state: "open" });
    expect(comment).toBe(
      "Reopened by La Fabrique extraordinaire: GitHub closed it when #185 was merged, but it is not validated yet. It stays open until it is validated, then until the release that ships it.",
    );
    const logged = await env.DB.prepare("SELECT actor, issue_number, details FROM activity_log WHERE action = 'story_reopened'").first<{ actor: string; issue_number: number; details: string }>();
    expect(logged).toEqual({ actor: "github", issue_number: 41, details: JSON.stringify({ pull: 185 }) });
  });

  it("is left closed when it was validated, closed by a person, or not a card's story", async () => {
    await seed();
    const github = () => fetchMock.get("https://api.github.com");
    // Closed by a person: no pull request nor commit behind it.
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ method: "POST", path: "/graphql" }).reply(200, closer(null), JSON_HEADERS);
    expect(await (await webhook("issues", { action: "closed", repository: { full_name: REPO }, issue: ISSUE })).json()).toEqual({ updated: 41 });
    // Not planned: never asked.
    expect(await (await webhook("issues", { action: "closed", repository: { full_name: REPO }, issue: { ...ISSUE, state_reason: "not_planned" } })).json()).toEqual({ updated: 41 });
    // Validated: never asked either.
    await activityStatement(env.DB, { actor: "qa", action: "story_validated", repo: REPO, issueNumber: 41 }).run();
    expect(await (await webhook("issues", { action: "closed", repository: { full_name: REPO }, issue: ISSUE })).json()).toEqual({ updated: 41 });
    // Not in a card.
    expect(await (await webhook("issues", { action: "closed", repository: { full_name: REPO }, issue: { ...ISSUE, number: 42 } })).json()).toEqual({ updated: 42 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'story_reopened'").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
