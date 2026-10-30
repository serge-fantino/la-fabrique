import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { workingBranches } from "../src/in-dev";
import type { Project } from "../src/projects";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const CONFIG = {
  nom: "Widget",
  branches: { production: "main", integration: "integration", travail: ["feature/*"] },
  workflows: { ci: "ci.yml" },
};

function story(number: number, title: string, extra: Record<string, unknown> = {}) {
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
    criteria: [],
    ...extra,
  };
}

function branch(sha: string, date: string, message: string) {
  return {
    commit: {
      sha,
      html_url: `https://github.com/${REPO}/commit/${sha}`,
      author: { login: "dev" },
      commit: { message, author: { name: "Dev", date }, committer: { date } },
    },
  };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("workingBranches", () => {
  it("keeps the branches matching the patterns, never production nor integration", () => {
    const project = { repo: REPO, installationId: 1, check: { config: CONFIG, branch: "main" } } as unknown as Project;
    expect(workingBranches(project, ["main", "integration", "feature/12-a", "docs"])).toEqual(["feature/12-a"]);
  });
});

describe("In development", () => {
  it("shows each story's branches, pull request, CI and last commit, stalled work and branches without a story", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
      ).bind(REPO, JSON.stringify(CONFIG)),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
        REPO,
        JSON.stringify([
          story(10, "Epic: Menu", { parent: null, subTotal: 2 }),
          story(12, "Plan the week", { branches: ["feature/12-plan"] }),
          story(13, "Old work", { branches: ["feature/13-old"] }),
        ]),
        now,
      ),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'branches', ?, ?)").bind(
        REPO,
        JSON.stringify(["main", "integration", "feature/12-plan", "feature/13-old", "feature/spike"]),
        now,
      ),
    ]);
    const github = fetchMock.get("https://api.github.com");
    github
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ path: `/repos/${REPO}/pulls?state=open&per_page=100&page=1` }).reply(
      200,
      JSON.stringify([
        {
          number: 40,
          title: "Plan the week",
          body: "Closes #12",
          draft: true,
          html_url: `https://github.com/${REPO}/pull/40`,
          created_at: daysAgo(1),
          head: { ref: "feature/12-plan" },
        },
      ]),
      JSON_HEADERS,
    );
    github.intercept({ path: `/repos/${REPO}/actions/workflows/ci.yml/runs?per_page=100` }).reply(
      200,
      JSON.stringify({
        workflow_runs: [
          { head_branch: "feature/12-plan", status: "completed", conclusion: "failure", html_url: "https://github.com/run/2", created_at: daysAgo(0.1) },
          { head_branch: "feature/12-plan", status: "completed", conclusion: "success", html_url: "https://github.com/run/1", created_at: daysAgo(1) },
        ],
      }),
      JSON_HEADERS,
    );
    github.intercept({ path: `/repos/${REPO}/branches/feature%2F12-plan` }).reply(200, JSON.stringify(branch("aaaaaaa1", daysAgo(0.1), "Week grid")), JSON_HEADERS);
    github.intercept({ path: `/repos/${REPO}/branches/feature%2F13-old` }).reply(200, JSON.stringify(branch("bbbbbbb2", daysAgo(5), "Started")), JSON_HEADERS);
    github.intercept({ path: `/repos/${REPO}/branches/feature%2Fspike` }).reply(200, JSON.stringify(branch("ccccccc3", daysAgo(0.5), "Try")), JSON_HEADERS);

    const { cookie } = await signIn("admin-one");
    const shell = await (await get(`/projects/${REPO}/in-development`, cookie)).text();
    expect(shell).toContain(`data-fragment="/projects/${REPO}/in-development?part=content"`);

    const part = await (await get(`/projects/${REPO}/in-development?part=content`, cookie)).text();
    expect(part).toContain("<strong>2 stories in development</strong> on 3 branches; <strong>1 stalled</strong>");
    const plan = part.slice(part.indexOf("Plan the week"), part.indexOf("</article>", part.indexOf("Plan the week")));
    expect(plan).toContain(`PR #40</a> <span class="pill warn">Draft</span>`);
    expect(plan).toContain('<a class="pill-link" href="https://github.com/run/2"><span class="pill alert">CI failed</span></a>');
    expect(plan).toContain("Week grid");
    const old = part.slice(part.indexOf("Old work"), part.indexOf("</article>", part.indexOf("Old work")));
    expect(old).toContain('<span class="pill alert">Stalled</span>');
    expect(part.slice(part.indexOf("Branches without a story"))).toContain("<code>feature/spike</code>");
    // Plan the week (latest commit) comes first.
    expect(part.indexOf("Plan the week")).toBeLessThan(part.indexOf("Old work"));

    // Then served from the snapshot, at once.
    const page = await (await get(`/projects/${REPO}/in-development`, cookie)).text();
    expect(page).toContain('aria-current="page">In development</a>');
    expect(page).toContain("Week grid");
  });
});
