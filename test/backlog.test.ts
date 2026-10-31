import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const CONFIG = { nom: "Widget", cycle: { pret: ["criteres", "epique"], priorites: ["P1", "P2", "P3"] } };

function story(number: number, title: string, extra: Partial<Story> = {}): Story {
  return {
    number,
    title,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: 10,
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

const STORIES = [
  story(10, "Epic: Menu", { parent: null, subTotal: 4 }),
  story(11, "Not ready P1", { labels: ["P1"], criteria: [] }),
  story(12, "Ready P1", { labels: ["P1"] }),
  story(13, "Ready P2", { labels: ["P2", "ux"] }),
  story(14, "Ready, no priority"),
  story(15, "Being built", { labels: ["P1"], branches: ["feature/15-x"] }),
];

async function seed(config: unknown = CONFIG): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
      REPO,
      JSON.stringify(STORIES),
      new Date().toISOString(),
    ),
  ]);
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Backlog", () => {
  it("lists the stories not started by priority, ready ones first, with a priority control", async () => {
    await seed();
    const page = await (await get(`/projects/${REPO}/backlog`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('aria-current="page">Backlog</a>');
    expect(page).toContain(`<strong>4 stories not started</strong>, 3 ready (<a href="/projects/${REPO}/setup#lifecycle">Definition of Ready</a>) · P1 <strong>2</strong> · P2 <strong>1</strong> · P3 <strong>0</strong> · no priority <strong>1</strong>.`);
    expect(page).not.toContain("Being built");
    expect(page).not.toContain("Epic: Menu</a>");
    // Within P1, the ready story first.
    expect(page.indexOf("Ready P1")).toBeLessThan(page.indexOf("Not ready P1"));
    expect(page.indexOf("Not ready P1")).toBeLessThan(page.indexOf("Ready P2"));
    expect(page).toContain("no acceptance criteria");
    expect(page).toContain('<select name="priority" aria-label="Priority of #13" data-autosubmit>');
  });

  it("sets a priority on GitHub, removes the other one and writes it in the log", async () => {
    await seed();
    const github = fetchMock.get("https://api.github.com");
    github
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/labels` }).reply(422, JSON.stringify({ message: "already_exists" }), JSON_HEADERS);
    let added: unknown = null;
    github
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/13/labels` })
      .reply(200, (options) => {
        added = JSON.parse(String(options.body));
        return JSON.stringify([]);
      });
    github.intercept({ method: "DELETE", path: `/repos/${REPO}/issues/13/labels/P2` }).reply(200, "[]", JSON_HEADERS);

    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const response = await post(`/projects/${REPO}/backlog`, { csrf, issue: "13", priority: "P1" }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/backlog?notice=set#issue-13`);
    expect(added).toEqual({ labels: ["P1"] });
    expect(await logActions()).toContainEqual({ actor: "pe", action: "priority_set", details: JSON.stringify({ from: "P2", to: "P1" }) });

    const page = await (await get(`/projects/${REPO}/backlog?notice=set`, cookie)).text();
    expect(page).toContain("Priority set on GitHub.");
    expect(page).toContain("P1 <strong>3</strong>");
  });

  it("lets a tester see the backlog but not change priorities", async () => {
    await seed();
    await grantRole("qa", "tester");
    const { cookie, csrf } = await signIn("qa");
    const page = await (await get(`/projects/${REPO}/backlog`, cookie)).text();
    expect(page).not.toContain('name="priority"');
    expect(page).toContain('<span class="pill">P2</span>');
    expect((await post(`/projects/${REPO}/backlog`, { csrf, issue: "13", priority: "P1" }, cookie)).status).toBe(403);
  });

  it("refuses a priority the project does not declare", async () => {
    await seed();
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/backlog`, { csrf, issue: "13", priority: "urgent" }, cookie);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("This priority is not declared in .fabrique.json.");
  });

  it("explains how to prioritise when the project declares no priority", async () => {
    await seed({ nom: "Widget" });
    const page = await (await get(`/projects/${REPO}/backlog`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("To prioritise, declare priority labels");
    expect(page).not.toContain('name="priority"');
  });
});
