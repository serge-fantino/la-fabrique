import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { groupPending, mergedBranch, nextRelease, type CompareCommit } from "../src/production";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const HEAD = "394e4ea0000000000000000000000000000000000";

const CONFIG = {
  nom: "Widget",
  branches: { production: "main", integration: "integration", travail: ["feature/*", "refacto/*"] },
  environnements: {
    int: { url: "https://int.widget.example", version: "/api/version" },
    production: { url: "https://widget.example", version: "/api/version" },
  },
  workflows: { ci: "ci.yml", deploiement_int: "deploy-int.yml", migrations_production: "migrations-prod.yml" },
  version: { fichier: "site/nouveautes.json" },
};

function commit(sha: string, parents: string[], message: string, date: string): CompareCommit {
  return { sha, parents, message, author: "dev", date, url: `https://github.com/${REPO}/commit/${sha}` };
}

// Shape of the épicerie's integration branch: each working branch merged as "Intégration : feature/…".
const HISTORY = [
  commit("68dcc2b", ["e875a2e"], "E-mails (#138) : bienvenue et conseils", "2026-10-29T21:00:00Z"),
  commit("84eed9a", ["e875a2e", "68dcc2b"], "Intégration : feature/emails", "2026-10-29T21:10:00Z"),
  commit("8d95d9d", ["84eed9a"], "Menu : Ma cuisine", "2026-10-29T22:00:00Z"),
  commit("35720d4", ["84eed9a", "8d95d9d"], "Intégration : feature/menu-preferences", "2026-10-29T22:10:00Z"),
  commit("57a2d62", ["35720d4"], "Assistant connecté : reconnu quel qu'il soit", "2026-10-29T23:00:00Z"),
  commit(HEAD, ["35720d4", "57a2d62"], "Intégration : feature/assistants-tous", "2026-10-29T23:10:00Z"),
];

describe("Pending work grouping", () => {
  it("groups commits by the working branch each merge brought in, newest first", () => {
    const groups = groupPending(HISTORY, CONFIG.branches.travail);
    expect(groups.map((group) => group.branch)).toEqual([
      "feature/assistants-tous",
      "feature/menu-preferences",
      "feature/emails",
    ]);
    expect(groups.map((group) => group.commits.map((c) => c.sha))).toEqual([["57a2d62"], ["8d95d9d"], ["68dcc2b"]]);
    expect(groups[2]?.issues).toEqual([138]);
  });

  it("keeps commits made directly on integration apart", () => {
    const groups = groupPending(
      [...HISTORY, commit("aaaaaaa", [HEAD], "v1.168 : en essai", "2026-10-30T00:00:00Z")],
      CONFIG.branches.travail,
    );
    expect(groups.at(-1)).toMatchObject({ branch: null, title: "Direct commits" });
    expect(groups.at(-1)?.commits.map((c) => c.sha)).toEqual(["aaaaaaa"]);
  });

  it("reads the branch from usual merge messages", () => {
    expect(mergedBranch("Merge pull request #12 from acme/feature/login", [])).toBe("feature/login");
    expect(mergedBranch("Merge branch 'refacto/store' into integration", [])).toBe("refacto/store");
    expect(mergedBranch("Intégration : refacto/store-v2", ["refacto/*"])).toBe("refacto/store-v2");
  });

  it("finds the next release: the first “Quoi de neuf” entry without a time", () => {
    const raw = JSON.stringify([
      { version: "1.168", date: "2026-10-30", titre: "E-mails", changements: ["Un e-mail de bienvenue."] },
      { version: "1.167", date: "2026-10-29", heure: "23:19", titre: "Recettes" },
    ]);
    expect(nextRelease(raw)).toEqual({ version: "1.168", title: "E-mails", changes: ["Un e-mail de bienvenue."] });
    expect(nextRelease("not json")).toBeNull();
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

function toRest(c: CompareCommit) {
  return {
    sha: c.sha,
    html_url: c.url,
    parents: c.parents.map((sha) => ({ sha })),
    author: { login: "dev" },
    commit: { message: c.message, committer: { date: c.date }, author: { name: "Dev", date: c.date } },
  };
}

function run(conclusion: string | null, headSha = HEAD, status = "completed") {
  return {
    workflow_runs: [
      {
        status,
        conclusion,
        html_url: `https://github.com/${REPO}/actions/runs/1`,
        created_at: "2026-10-29T23:12:00Z",
        head_sha: headSha,
      },
    ],
  };
}

function mockStatus(ci: unknown, deploy: unknown): void {
  github()
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/compare/main...integration` })
    .reply(200, JSON.stringify({ ahead_by: 6, commits: HISTORY.map(toRest) }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/actions/workflows/ci.yml/runs?branch=integration&per_page=1` })
    .reply(200, JSON.stringify(ci), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/actions/workflows/deploy-int.yml/runs?branch=integration&per_page=1` })
    .reply(200, JSON.stringify(deploy), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/actions/workflows/migrations-prod.yml/runs?branch=main&per_page=1` })
    .reply(200, JSON.stringify(run("success", "e875a2e")), JSON_HEADERS);
  fetchMock
    .get("https://int.widget.example")
    .intercept({ path: "/api/version" })
    .reply(200, JSON.stringify({ numero: "1.168" }), JSON_HEADERS);
  fetchMock
    .get("https://widget.example")
    .intercept({ path: "/api/version" })
    .reply(200, JSON.stringify({ numero: "1.167" }), JSON_HEADERS);
  github()
    .intercept({ path: `/repos/${REPO}/contents/site/nouveautes.json?ref=integration` })
    .reply(200, JSON.stringify([{ version: "1.168", titre: "E-mails", changements: ["Bienvenue."] }]));
}

async function seed(config: unknown = CONFIG): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'e875a2e', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data) VALUES (?, 'stories', ?)").bind(
      REPO,
      JSON.stringify([{ number: 138, title: "E-mails aux utilisateurs" }]),
    ),
  ]);
}

describe("What awaits production", () => {
  it("shows the pending branches, their commits and issues, versions and workflows", async () => {
    await seed();
    mockStatus(run("success"), run("success"));
    const page = await (await get(`/projects/${REPO}/production`, (await signIn("admin-one")).cookie)).text();

    expect(page).toContain("<strong>Ready for production.</strong>");
    expect(page).toContain("6 commits on <code>integration</code> not in <code>main</code>");
    expect(page).toContain("Integration: <code>feature/assistants-tous</code>");
    expect(page).toContain(`href="https://github.com/${REPO}/issues/138">#138</a> E-mails aux utilisateurs`);
    expect(page).toContain('>int</a> <span class="mono">1.168</span>');
    expect(page).toContain('>production</a> <span class="mono">1.167</span>');
    expect(page).toContain('<span class="pill warn">Next</span> <span class="mono">1.168</span>');
    expect(page).toContain("Production migrations");
    expect(page).not.toMatch(/<form[^>]*production/);
  });

  it("puts a red CI on integration first, with its link", async () => {
    await seed();
    mockStatus(run("failure"), run("success"));
    const page = await (await get(`/projects/${REPO}/production`, (await signIn("admin-one")).cookie)).text();
    const banner = page.indexOf("Not ready for production");
    expect(banner).toBeGreaterThan(-1);
    expect(page.indexOf("CI failed on integration.")).toBeGreaterThan(banner);
    expect(page.indexOf("CI failed on integration.")).toBeLessThan(page.indexOf("<h2>Versions</h2>"));
    expect(page).toContain(`<a href="https://github.com/${REPO}/actions/runs/1">See the run</a>`);
  });

  it("does not count a green run on an older commit", async () => {
    await seed();
    mockStatus(run("success"), run("success", "35720d4"));
    const page = await (await get(`/projects/${REPO}/production`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("Deployment to int has not run on the latest commit of integration yet.");
  });

  it("is visible to every role and offers no production action", async () => {
    await seed();
    mockStatus(run("success"), run("success"));
    await grantRole("qa", "tester");
    const response = await get(`/projects/${REPO}/production`, (await signIn("qa")).cookie);
    expect(response.status).toBe(200);
    const main = (await response.text()).split("<main>")[1] ?? "";
    expect(main).not.toContain("<button");
    expect(main).not.toContain("<form");
  });

  it("explains when the project has no integration branch", async () => {
    await seed({ nom: "Widget" });
    const page = await (await get(`/projects/${REPO}/production`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("does not declare an integration branch");
  });
});
