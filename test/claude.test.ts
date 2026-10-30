import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateFabriqueConfig } from "../src/fabrique-config";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const CONFIG = {
  nom: "Widget",
  langue: "fr",
  workflows: { claude: "claude.yml" },
  claude: { plafond: 1 },
  demandes: { etiquettes: { prete: "prete-pour-claude" } },
};

function story(number: number, title: string, extra: Partial<Story> = {}): Story {
  return {
    number,
    title,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: 1,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    pullRequests: [],
    branches: [],
    criteria: [{ text: "Works", done: false }],
    ...extra,
  };
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
      REPO,
      JSON.stringify([story(1, "Epic", { parent: null, subTotal: 2 }), story(12, "Ready one"), story(13, "Bare one", { criteria: [] })]),
      new Date().toISOString(),
    ),
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

describe("claude in .fabrique.json", () => {
  it("takes a cap from 1 to 10", () => {
    const tree = { files: new Set<string>(), folders: new Set<string>(), complete: false };
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", claude: { plafond: 3 } }), tree).config?.claude).toEqual({ plafond: 3 });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", claude: { plafond: 0 } }), tree).errors).toEqual([
      "`claude.plafond` must be a whole number from 1 to 10.",
    ]);
  });
});

describe("Launch Claude", () => {
  it("shows the button to tech leads on ready stories only", async () => {
    await seed();
    await grantRole("lead", "tech_lead");
    const page = await (await get(`/projects/${REPO}/backlog`, (await signIn("lead")).cookie)).text();
    const row = (title: string) => page.slice(page.indexOf(title), page.indexOf("</tr>", page.indexOf(title)));
    expect(row("Ready one")).toContain("Launch Claude</button>");
    expect(row("Bare one")).not.toContain("Launch Claude");
    expect(row("Bare one")).toContain("not ready");
  });

  it("is not for testers nor Product Engineers", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    expect(await (await get(`/projects/${REPO}/backlog`, cookie)).text()).not.toContain("Launch Claude");
    expect((await post(`/projects/${REPO}/backlog/claude`, { csrf, issue: "12" }, cookie)).status).toBe(403);
  });

  it("dispatches the project's workflow with the issue number, labels, comments and logs", async () => {
    await seed();
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(200, JSON.stringify({ workflow_runs: [{ status: "completed", html_url: "x" }] }), JSON_HEADERS);
    let dispatched: unknown = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` })
      .reply(204, (options) => {
        dispatched = JSON.parse(String(options.body));
        return "";
      });
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/12/labels` }).reply(200, "[]", JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/issues/12` })
      .reply(
        200,
        JSON.stringify({
          number: 12,
          title: "Ready one",
          state: "open",
          html_url: `https://github.com/${REPO}/issues/12`,
          user: null,
          labels: [{ name: "prete-pour-claude" }],
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
          closed_at: null,
        }),
        JSON_HEADERS,
      );
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` })
      .reply(201, (options) => {
        comment = JSON.parse(String(options.body)).body;
        return "{}";
      });

    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/backlog/claude`, { csrf, issue: "12" }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/backlog?notice=claude#issue-12`);
    expect(dispatched).toEqual({ ref: "main", inputs: { issue: "12", par: "admin-one" } });
    expect(comment).toContain("Claude lancé sur cette demande par @admin-one");
    expect(await logActions()).toContainEqual({
      actor: "admin-one",
      action: "claude_launched",
      details: JSON.stringify({ workflow: "claude.yml", running: 1, cap: 1 }),
    });
    const page = await (await get(`/projects/${REPO}/backlog`, cookie)).text();
    expect(page).toContain("launched by @admin-one on");
    expect(page).toContain("Launch again");
  });

  it("dispatches nothing over the cap", async () => {
    await seed();
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` })
      .reply(200, JSON.stringify({ workflow_runs: [{ status: "in_progress", html_url: "x" }] }), JSON_HEADERS);
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/backlog/claude`, { csrf, issue: "12" }, cookie);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Claude already runs 1 time on this project (cap 1)");
  });

  it("refuses a story that is not ready", async () => {
    await seed();
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/backlog/claude`, { csrf, issue: "13" }, cookie);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Story #13 is not ready");
  });
});
