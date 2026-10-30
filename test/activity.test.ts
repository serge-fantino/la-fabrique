import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { dayHeads, type ActivityCommit } from "../src/activity";
import { barChart, niceMax } from "../src/charts";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

function at(daysAgo: number, hour = 12): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, hour)).toISOString();
}

function commit(sha: string, parents: string[], when: string): ActivityCommit {
  return { sha, parents, author: "dev", authoredAt: when, committedAt: when };
}

describe("Activity computations", () => {
  it("finds the branch head at the end of each day along the first-parent line", () => {
    const commits = [
      commit("c4", ["c3", "b1"], "2026-10-30T10:00:00Z"),
      commit("b1", ["c2"], "2026-10-30T09:00:00Z"),
      commit("c3", ["c2"], "2026-10-29T18:00:00Z"),
      commit("c2", ["c1"], "2026-10-27T08:00:00Z"),
    ];
    const heads = dayHeads(commits, "c4", ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect([...heads.values()]).toEqual([null, "c2", "c2", "c3", "c4"]);
  });

  it("rounds axes to readable maxima", () => {
    expect([niceMax(0), niceMax(7), niceMax(12), niceMax(380), niceMax(1001)]).toEqual([1, 10, 20, 500, 2000]);
  });

  it("draws one hoverable target per day, bars only where there is data", () => {
    const svg = barChart({
      bars: [
        { day: "2026-10-29", up: 3, title: "29 Oct: 3 commits" },
        { day: "2026-10-30", up: 0, title: "30 Oct: 0 commits" },
      ],
      label: "Commits",
      upClass: "bar-commits",
    });
    expect(svg.match(/<path class="bar-commits"/g)).toHaveLength(1);
    expect(svg.match(/<rect class="chart-hit"/g)).toHaveLength(2);
    expect(svg).toContain("<title>29 Oct: 3 commits</title>");
    expect(svg).toContain('role="img" aria-label="Commits"');
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function github() {
  return fetchMock.get("https://api.github.com");
}

const COMMITS = [
  { sha: "c4", parents: ["c3", "b1"], when: at(0, 15) },
  { sha: "b1", parents: ["c2"], when: at(0, 9) },
  { sha: "c3", parents: ["c2"], when: at(1) },
  { sha: "c2", parents: ["c1"], when: at(2) },
  { sha: "c1", parents: ["c0"], when: at(4) },
];

function mockCommits(): void {
  github()
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  github()
    .intercept({
      path: (path: string) =>
        path.startsWith(`/repos/${REPO}/commits?`) && path.includes("sha=integration") && path.includes("since="),
    })
    .reply(
      200,
      JSON.stringify(
        COMMITS.map((c) => ({
          sha: c.sha,
          parents: c.parents.map((sha) => ({ sha })),
          author: { login: "dev" },
          commit: { author: { name: "Dev", date: c.when }, committer: { date: c.when } },
        })),
      ),
      JSON_HEADERS,
    );
}

function mockCompares(pairs: string[]): void {
  github()
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  for (const pair of pairs) {
    github()
      .intercept({ path: `/repos/${REPO}/compare/${pair}` })
      .reply(200, JSON.stringify({ files: [{ additions: 10, deletions: 2 }, { additions: 5, deletions: 0 }] }), JSON_HEADERS);
  }
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify({ nom: "Widget", branches: { production: "main", integration: "integration" } })),
  ]);
}

describe("Activity tab", () => {
  it("shows commits and lines changed per day, without merge commits", async () => {
    await seed();
    mockCommits();
    mockCompares(["c1...c2", "c2...c3", "c3...c4"]);
    const page = await (await get(`/projects/${REPO}/activity`, (await signIn("admin-one")).cookie)).text();

    expect(page).toContain('<p class="tile-label">Commits</p><p class="tile-value mono">4</p>');
    expect(page).toContain('<p class="tile-value mono">+45</p>');
    expect(page).toContain('<p class="tile-value mono">−6</p>');
    expect(page).toContain(`<title>${at(0).slice(0, 10)}: 1 commit</title>`);
    expect(page).toContain(`<title>${at(1).slice(0, 10)}: +15 / −2 lines</title>`);
    expect(page).toContain('<td class="mono">dev</td><td class="mono">4</td>');
    expect(page).not.toContain("still being read");
  });

  it("reads each day's lines only once", async () => {
    await seed();
    mockCommits();
    mockCompares(["c1...c2", "c2...c3", "c3...c4"]);
    const { cookie } = await signIn("admin-one");
    await get(`/projects/${REPO}/activity`, cookie);

    const again = await (await get(`/projects/${REPO}/activity`, cookie)).text();
    expect(again).toContain('<p class="tile-value mono">+45</p>');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM diff_stats").first("n")).toBe(3);
  });

  it("is visible to every role and closed to anonymous visitors", async () => {
    await seed();
    mockCommits();
    mockCompares(["c1...c2", "c2...c3", "c3...c4"]);
    await grantRole("qa", "tester");
    expect((await get(`/projects/${REPO}/activity?days=90`, (await signIn("qa")).cookie)).status).toBe(200);
    expect((await get(`/projects/${REPO}/activity`)).headers.get("location")).toBe("/");
  });
});

