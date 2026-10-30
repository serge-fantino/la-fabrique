import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProductionStatus } from "../src/production";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const CONFIG = {
  nom: "Widget",
  branches: { production: "main", integration: "integration" },
  environnements: {
    int: { url: "https://int.widget.example", version: "/api/version" },
    production: { url: "https://widget.example", version: "/api/version" },
  },
};

function story(number: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: 30,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    pullRequests: [],
    branches: [],
    criteria: [],
    ...extra,
  };
}

const STORIES = [
  story(30, "Epic: Weekly menu", { parent: null, subTotal: 3 }),
  story(31, "Plan the week", { criteria: [{ text: "Seven days show", done: false }, { text: "Meals can move", done: true }] }),
  story(32, "Shopping list", { criteria: [] }),
  story(33, "Not merged yet"),
];

const STATUS: ProductionStatus = {
  production: "main",
  integration: "integration",
  integrationHead: "abc",
  aheadBy: 3,
  groups: [
    { branch: "feature/31-plan", title: "", mergedAt: "2026-10-29T08:00:00Z", commits: [], issues: [31, 30] },
    { branch: "feature/32-list", title: "", mergedAt: "2026-10-30T08:00:00Z", commits: [], issues: [32, 99] },
  ],
  workflows: [],
  versions: [{ environment: "int", url: "https://int.widget.example", version: "1.169" }],
  waiting: [{ version: "1.169", title: "Menu", changes: ["Plan your week.", "List from the menu."] }],
  ready: true,
  blockers: [],
};

async function seed(config: unknown = CONFIG, production: ProductionStatus | null = STATUS): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(REPO, JSON.stringify(STORIES), now),
    ...(production
      ? [env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(production), now)]
      : []),
  ]);
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("To test", () => {
  it("lists the stories on int with their criteria, the waiting changes and a link to int", async () => {
    await seed();
    const page = await (await get(`/projects/${REPO}/to-test`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('aria-current="page">To test</a>');
    expect(page).toContain("<strong>2 stories and 2 changes to test</strong> on <code>integration</code>, waiting since <span class=\"mono\">2026-10-29 08:00 UTC</span>; it runs <span class=\"mono\">1.169</span>.");
    expect(page).toContain('<a class="button" href="https://int.widget.example">Open int</a>');
    expect(page).toContain("#30</a> Epic: Weekly menu</h3>");
    expect(page).toContain("Seven days show");
    expect(page).toContain('<li class="done"><span class="box" aria-hidden="true">✓</span>Meals can move');
    expect(page).toContain("No acceptance criteria written");
    expect(page).not.toContain("Not merged yet");
    expect(page).toContain("List from the menu.");
  });

  it("shows the page at once and reads int afterwards when the last read is old", async () => {
    await seed(CONFIG, null);
    const page = await (await get(`/projects/${REPO}/to-test`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain(`data-fragment="/projects/${REPO}/to-test?part=content"`);
  });

  it("says when production is up to date", async () => {
    await seed(CONFIG, { ...STATUS, aheadBy: 0, groups: [], waiting: [] });
    const page = await (await get(`/projects/${REPO}/to-test`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("Nothing new to test");
  });

  it("without an integration branch, says what the latest production version brought", async () => {
    await seed({ nom: "Widget", version: { fichier: "notes.json" } }, null);
    fetchMock
      .get("https://api.github.com")
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: `/repos/${REPO}/contents/notes.json?ref=abc` })
      .reply(
        200,
        JSON.stringify([
          { version: "0.3", date: "2026-10-30", heure: "10:00", titre: "Lists", changements: ["Shopping lists."] },
          { version: "0.2", date: "2026-10-20", heure: "10:00", changements: [] },
        ]),
      );
    const page = await (await get(`/projects/${REPO}/to-test`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("No integration branch: what the latest production version brought.");
    expect(page).toContain('<span class="mono">0.3</span> · Lists');
    expect(page).toContain("Shopping lists.");
  });
});
