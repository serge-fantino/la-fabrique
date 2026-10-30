import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { groupStories, type Story } from "../src/stories";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const API = `https://api.github.com/repos/${REPO}`;

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Story ${number}`,
    state: "open",
    html_url: `https://github.com/${REPO}/issues/${number}`,
    user: { login: "Someone" },
    labels: [],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    closed_at: null,
    parent_issue_url: null,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    ...extra,
  };
}

const ISSUES = [
  issue(1, { title: "Epic one", sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } }),
  issue(2, { state: "closed", closed_at: "2026-10-03T00:00:00Z", parent_issue_url: `${API}/issues/1` }),
  issue(3, {
    parent_issue_url: `${API}/issues/1`,
    labels: [{ name: "demande" }, { name: "ux" }],
    user: { login: "Admin-One" },
  }),
  issue(4, { title: "Loose story" }),
  issue(5, { title: "A pull request", pull_request: { url: "x" } }),
];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function github() {
  return fetchMock.get("https://api.github.com");
}

function mockSync(issues = ISSUES): void {
  github()
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/issues?state=all&per_page=100&page=1` })
    .reply(200, JSON.stringify(issues), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1` })
    .reply(
      200,
      JSON.stringify([
        {
          number: 5,
          title: "Request form",
          body: "Closes #3",
          state: "closed",
          merged_at: "2026-10-04T00:00:00Z",
          html_url: `https://github.com/${REPO}/pull/5`,
          head: { ref: "feature/3-form" },
        },
      ]),
      JSON_HEADERS,
    );
  github()
    .intercept({ path: `/repos/${REPO}/branches?per_page=100&page=1` })
    .reply(200, JSON.stringify([{ name: "main" }, { name: "feature/3-form" }, { name: "feature/4-loose" }]), JSON_HEADERS);
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify({ nom: "Widget", demandes: { etiquettes: { demande: "demande", prete: "prete-pour-claude" } } })),
  ]);
}

async function webhook(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return SELF.fetch("https://la-fabrique.test/api/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    },
    body,
  });
}

describe("Stories board", () => {
  it("groups issues by epic, with state, labels, pull requests and branches", async () => {
    await seed();
    mockSync();
    const page = await (await get(`/projects/${REPO}/stories`, (await signIn("admin-one")).cookie)).text();

    expect(page).toContain(`<a href="https://github.com/${REPO}/issues/1">#1</a> Epic one`);
    expect(page).toContain("1/2 done");
    expect(page).toContain(`href="https://github.com/${REPO}/issues/3"`);
    expect(page).toContain('<span class="chip circuit">demande</span>');
    expect(page).toContain('<span class="chip">ux</span>');
    expect(page).toContain(`href="https://github.com/${REPO}/pull/5">PR #5</a> <span class="muted">merged</span>`);
    expect(page).toContain("<code>feature/3-form</code>");
    expect(page).toContain("Not in an epic");
    expect(page).toContain("<code>feature/4-loose</code>");
    expect(page).not.toContain("A pull request");
  });

  it("reads GitHub at most once every ten minutes", async () => {
    await seed();
    mockSync();
    const { cookie } = await signIn("admin-one");
    await get(`/projects/${REPO}/stories`, cookie);
    expect((await get(`/projects/${REPO}/stories?state=open`, cookie)).status).toBe(200);
  });

  it("filters by state, label, epic and author", async () => {
    await seed();
    mockSync();
    const { cookie } = await signIn("admin-one");
    await get(`/projects/${REPO}/stories`, cookie);

    const open = await (await get(`/projects/${REPO}/stories?state=open`, cookie)).text();
    expect(open).not.toContain(`issues/2"`);
    const labelled = await (await get(`/projects/${REPO}/stories?label=ux`, cookie)).text();
    expect(labelled).toContain(`issues/3"`);
    expect(labelled).not.toContain(`issues/4"`);
    const mine = await (await get(`/projects/${REPO}/stories?mine=1`, cookie)).text();
    expect(mine).toContain(`issues/3"`);
    expect(mine).not.toContain(`issues/2"`);
    const epic = await (await get(`/projects/${REPO}/stories?epic=1`, cookie)).text();
    expect(epic).not.toContain("Not in an epic");
  });

  it("follows an issue closed on GitHub through the webhook, without reading GitHub", async () => {
    await seed();
    mockSync();
    const { cookie } = await signIn("admin-one");
    await get(`/projects/${REPO}/stories`, cookie);

    const response = await webhook("issues", {
      action: "closed",
      repository: { full_name: REPO },
      issue: issue(3, {
        state: "closed",
        closed_at: "2026-10-05T00:00:00Z",
        parent_issue_url: `${API}/issues/1`,
        user: { login: "Admin-One" },
      }),
    });
    expect(response.status).toBe(200);

    const closed = await (await get(`/projects/${REPO}/stories?state=closed`, cookie)).text();
    expect(closed).toContain(`issues/3"`);
  });

  it("reads GitHub again after a pull request event", async () => {
    await seed();
    mockSync();
    const { cookie } = await signIn("admin-one");
    await get(`/projects/${REPO}/stories`, cookie);

    expect((await webhook("pull_request", { action: "opened", repository: { full_name: REPO } })).status).toBe(200);
    mockSync([...ISSUES, issue(6, { title: "Fresh story" })]);
    expect(await (await get(`/projects/${REPO}/stories`, cookie)).text()).toContain("Fresh story");
  });

  it("is visible to every role and closed to anonymous visitors", async () => {
    await seed();
    mockSync();
    await grantRole("qa", "tester");
    expect((await get(`/projects/${REPO}/stories`, (await signIn("qa")).cookie)).status).toBe(200);
    expect((await get(`/projects/${REPO}/stories`)).headers.get("location")).toBe("/");
  });
});

describe("groupStories", () => {
  const story = (number: number, extra: Partial<Story> = {}): Story => ({
    number,
    title: `S${number}`,
    state: "open",
    url: "",
    author: null,
    labels: [],
    parent: null,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    pullRequests: [],
    branches: [],
    ...extra,
  });

  it("lists open epics first and keeps stories whose parent is unknown", () => {
    const groups = groupStories(
      [
        story(10, { subTotal: 1, state: "closed" }),
        story(20, { subTotal: 1 }),
        story(11, { parent: 10 }),
        story(21, { parent: 20 }),
        story(30, { parent: 999 }),
      ],
      { epic: null, label: null, state: "all", mine: false },
      "me",
    );
    expect(groups.map((group) => group.epic?.number ?? null)).toEqual([20, 10, null]);
    expect(groups[2]?.items.map((item) => item.number)).toEqual([30]);
  });
});
