import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildCard } from "../src/dashboard";
import type { ProductionStatus } from "../src/production";
import type { Project } from "../src/projects";
import type { Story } from "../src/stories";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const CONFIG = {
  nom: "Widget",
  branches: { production: "main", integration: "integration", travail: ["feature/*"] },
  workflows: { ci: "ci.yml" },
  cycle: { pret: ["criteres", "epique"], priorites: ["P1", "P2"] },
};

function story(number: number, extra: Partial<Story> = {}): Story {
  return {
    number,
    title: `Story ${number}`,
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
    criteria: [{ text: "ok", done: false }],
    ...extra,
  };
}

const STORIES = [
  story(1, { parent: null, subTotal: 5 }),
  story(2, { labels: ["P1"] }),
  story(3, { labels: ["P1"], criteria: [] }),
  story(4, { branches: ["feature/4-x"] }),
  story(5, { state: "closed" }),
];

const STATUS: ProductionStatus = {
  production: "main",
  integration: "integration",
  integrationHead: "abc",
  aheadBy: 4,
  groups: [{ branch: "feature/5-y", title: "", mergedAt: "2026-10-29T08:00:00Z", commits: [], issues: [5] }],
  workflows: [],
  versions: [
    { environment: "int", url: "https://int.example", version: "1.12" },
    { environment: "production", url: "https://example", version: "1.11" },
  ],
  waiting: [{ version: "1.12", title: null, changes: ["A", "B"] }],
  ready: false,
  blockers: [{ text: "CI failed on integration.", url: null }],
};

const PROJECT = { repo: REPO, installationId: 99, check: { branch: "main", config: CONFIG } } as unknown as Project;
const fresh = (data: unknown) => ({ data, fetchedAt: new Date().toISOString() });

describe("buildCard", () => {
  it("says what needs attention, each figure linked to its tab", () => {
    const card = buildCard(
      PROJECT,
      {
        stories: fresh(STORIES) as never,
        production: fresh(STATUS) as never,
        delivery: fresh({ since: "2026-10-01", runs: [{ workflow: "ci", branch: "main", result: "failure", startedAt: "2026-10-30T08:00:00Z" }] }) as never,
        releases: fresh({ releases: [{ version: "1.11", date: "2026-10-28", time: "10:00", title: "Lists", changes: [], links: [], upcoming: false }] }) as never,
      },
      "super_admin",
    );
    const tile = (key: string) => card.tiles.find((candidate) => candidate.key === key);
    expect(card.tiles[0]?.key).toBe("production");
    expect(tile("production")).toMatchObject({ value: "Not ready", detail: "CI failed on integration.", tone: "alert", path: `/projects/${REPO}/production` });
    expect(tile("to_test")).toMatchObject({ value: "1", detail: "2 changes, since 2026-10-29", path: `/projects/${REPO}/to-test` });
    expect(tile("in_dev")).toMatchObject({ value: "1", path: `/projects/${REPO}/in-development` });
    expect(tile("ready")).toMatchObject({ value: "1", detail: "1 not ready" });
    expect(tile("top_priority")).toMatchObject({ label: "P1 in the backlog", value: "2", detail: "1 ready" });
    expect(tile("ci")).toMatchObject({ label: "CI on main", value: "Failed", tone: "alert" });
    expect(tile("versions")).toMatchObject({ value: "1.12 / 1.11", detail: "int / production" });
    expect(tile("release")).toMatchObject({ value: "1.11", detail: "2026-10-28 · Lists" });
    expect(card.stale).toBe(false);
  });

  it("puts first what the role looks at, and says when production was not read lately", () => {
    const card = buildCard(PROJECT, { stories: fresh(STORIES) as never }, "tester");
    expect(card.tiles[0]?.key).toBe("to_test");
    expect(card.tiles[0]?.value).toBe("…");
    expect(card.stale).toBe(true);
    expect(buildCard(PROJECT, {}, "tech_lead").tiles[0]?.key).toBe("ci");
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Dashboard", () => {
  it("is the home page, read from snapshots without calling GitHub", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
      ).bind(REPO, JSON.stringify(CONFIG)),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(REPO, JSON.stringify(STORIES), now),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(STATUS), now),
    ]);
    await grantRole("qa", "tester");
    const page = await (await get("/", (await signIn("qa")).cookie)).text();
    expect(page).toContain("<h1>Dashboard</h1>");
    expect(page).toContain(`<a href="/projects/${REPO}">Widget</a>`);
    expect(page).toContain(`href="/projects/${REPO}/to-test"`);
    expect(page).toContain('<span class="tile-label">To test on int</span>');
    expect(page).not.toContain("data-fragment");
    // The tester sees what to test first.
    expect(page.indexOf("To test on int")).toBeLessThan(page.indexOf("In development</span>"));
  });

  it("refreshes an old card once shown", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
      ).bind(REPO, JSON.stringify(CONFIG)),
    ]);
    const page = await (await get("/", (await signIn("admin-one")).cookie)).text();
    expect(page).toContain(`data-fragment="/projects/${REPO}/card"`);
  });
});
