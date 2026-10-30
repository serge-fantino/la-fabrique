import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityStatement } from "../src/activity-log";
import type { ProductionStatus } from "../src/production";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const CONFIG = {
  nom: "Widget",
  branches: { production: "main", integration: "integration" },
  workflows: { promouvoir: "promouvoir.yml" },
};

function story(number: number, title: string) {
  return {
    number,
    title,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: null,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    pullRequests: [],
    branches: [],
    criteria: [],
  };
}

const STATUS: ProductionStatus = {
  production: "main",
  integration: "integration",
  integrationHead: "abc123",
  aheadBy: 3,
  groups: [{ branch: "feature/31-plan", title: "", mergedAt: "2026-10-29T08:00:00Z", commits: [], issues: [31, 32] }],
  workflows: [],
  versions: [],
  waiting: [{ version: "1.169", title: "Menu", changes: ["Plan."] }],
  ready: true,
  blockers: [],
};

async function seed(status: ProductionStatus = STATUS, validated: number[] = [31, 32]): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
      REPO,
      JSON.stringify([story(31, "Plan the week"), story(32, "Shopping list")]),
      now,
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(status), now),
    ...validated.map((number) =>
      activityStatement(env.DB, { actor: "qa", action: "story_validated", repo: REPO, issueNumber: number, details: { version: "1.169" } }),
    ),
  ]);
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("The go", () => {
  it("shows the super admin what production will get and who validated it", async () => {
    await seed(STATUS, [31]);
    const page = await (await get(`/projects/${REPO}/production`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("Give the go for <span class=\"mono\">1.169</span>");
    expect(page).toContain("#31</a> Plan the week");
    expect(page).toContain('<span class="pill ok">Validated</span> <span class="muted small">by @qa</span>');
    expect(page).toContain('<span class="pill alert">Not validated</span>');
    expect(page).toContain("1 not validated on int: why give the go anyway?");
  });

  it("is for the super admin only", async () => {
    await seed();
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    const page = await (await get(`/projects/${REPO}/production`, cookie)).text();
    expect(page).not.toContain("Give the go");
    expect((await post(`/projects/${REPO}/production/go`, { csrf }, cookie)).status).toBe(403);
  });

  it("dispatches the project's promotion workflow on the production branch and logs the go", async () => {
    await seed();
    const github = fetchMock.get("https://api.github.com");
    github
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    let dispatched: unknown = null;
    github.intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/promouvoir.yml/dispatches` }).reply(204, (options) => {
      dispatched = JSON.parse(String(options.body));
      return "";
    });
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/production/go`, { csrf }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/production?notice=given`);
    expect(dispatched).toEqual({ ref: "main", inputs: { version: "1.169", par: "admin-one" } });
    expect(await logActions()).toContainEqual({
      actor: "admin-one",
      action: "go_given",
      details: JSON.stringify({ version: "1.169", commit: "abc123", stories: [31, 32], not_validated: [] }),
    });
  });

  it("needs a reason when stories are not validated, and keeps it", async () => {
    await seed(STATUS, []);
    const { cookie, csrf } = await signIn("admin-one");
    const refused = await post(`/projects/${REPO}/production/go`, { csrf }, cookie);
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("2 stories are not validated on int");

    const github = fetchMock.get("https://api.github.com");
    github
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/promouvoir.yml/dispatches` }).reply(204, "");
    const response = await post(`/projects/${REPO}/production/go`, { csrf, reason: "Hotfix, tested by hand" }, cookie);
    expect(response.status).toBe(303);
    const log = await (await get(`/projects/${REPO}/log`, cookie)).text();
    expect(log).toContain("gave the go to production (version <span class=\"mono\">1.169</span>), anyway: “Hotfix, tested by hand”");
  });

  it("refuses the go when production is not ready", async () => {
    await seed({ ...STATUS, ready: false, blockers: [{ text: "CI failed on integration.", url: null }] });
    const { cookie, csrf } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/production`, cookie)).text();
    expect(page).toContain("The go waits until production is ready");
    expect(page).not.toContain("/production/go");
    const response = await post(`/projects/${REPO}/production/go`, { csrf, reason: "please" }, cookie);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Not ready for production: CI failed on integration.");
  });
});
