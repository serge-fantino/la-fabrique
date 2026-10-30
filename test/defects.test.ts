import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DAILY_CAP } from "../src/defects";
import { toTestContent } from "../src/to-test-views";
import { storyChecks } from "../src/validation";
import type { ProductionStatus } from "../src/production";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";
import { branchKind } from "../src/projects";
import { CONFIG, connect, INT_URL, me, REPO } from "./oauth-helpers";

const JSON_HEADERS = { headers: { "content-type": "application/json" } };
// A 1×1 PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function story(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Story ${number}`,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: 140,
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

function status(issues: number[], waiting: ProductionStatus["waiting"] = []): ProductionStatus {
  return {
    production: "main",
    integration: "integration",
    integrationHead: "abc",
    aheadBy: 1,
    groups: [{ branch: "feature/146-x", title: "", mergedAt: "2026-10-30T08:00:00Z", commits: [], issues }],
    workflows: [],
    versions: [],
    waiting,
    ready: true,
    blockers: [],
  };
}

// Work on int for `issues`; the first release-notes entry waiting there
// declares them as its stories.
async function seedInt(issues: number[], entries: ProductionStatus["waiting"] = [{ version: "1.170", title: "Menu", changes: [] }]): Promise<void> {
  const waiting = entries.map((entry, index) => (index === 0 && entry.stories === undefined ? { ...entry, stories: issues } : entry));
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(status(issues, waiting)), now),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
      REPO,
      JSON.stringify([story(140, { parent: null, subTotal: 3 }), story(146), story(147)]),
      now,
    ),
  ]);
}

function mockVersion(answers: string | null = "int"): void {
  fetchMock
    .get(INT_URL)
    .intercept({ method: "GET", path: "/api/version" })
    .reply(200, JSON.stringify({ numero: "1.169", ...(answers ? { environnement: answers } : {}) }), JSON_HEADERS);
}

interface Sent {
  issue: { title: string; body: string; labels: string[] } | null;
  comment: { body: string } | null;
}

function mockGitHub(number = 150): Sent {
  const sent: Sent = { issue: null, comment: null };
  const github = fetchMock.get("https://api.github.com");
  github
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  github.intercept({ method: "POST", path: `/repos/${REPO}/issues` }).reply(201, (options) => {
    sent.issue = JSON.parse(String(options.body));
    return JSON.stringify({
      number,
      title: sent.issue?.title,
      state: "open",
      html_url: `https://github.com/${REPO}/issues/${number}`,
      user: { login: "la-fabrique[bot]" },
      labels: (sent.issue?.labels ?? []).map((name) => ({ name })),
      created_at: "2026-10-30T12:00:00Z",
      updated_at: "2026-10-30T12:00:00Z",
      closed_at: null,
      body: sent.issue?.body,
    });
  });
  return sent;
}

function mockStoryComment(sent: Sent, story = 146): void {
  fetchMock
    .get("https://api.github.com")
    .intercept({ method: "POST", path: `/repos/${REPO}/issues/${story}/comments` })
    .reply(201, (options) => {
      sent.comment = JSON.parse(String(options.body));
      return JSON.stringify({ id: 1 });
    });
}

const REPORT = {
  title: "The save button does nothing",
  seen: "Nothing happens when I tap Save.",
  expected: "The meal is saved.",
  environment: "int",
  version: "1.169–int",
  deployment: "319bb159",
  page: "/app/moi.html?ouvrir=integration",
  component: { selector: "button.save", text: "Save", box: { x: 10, y: 20, w: 120, h: 44 } },
  viewport: { w: 390, h: 844, dpr: 3 },
  user_agent: "Mozilla/5.0 (iPhone)",
  errors: ["TypeError: x is undefined"],
};

function report(accessToken: string, body: unknown, project = "widget"): Promise<Response> {
  return SELF.fetch(`${BASE}/api/projects/${project}/defects`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Reporting a defect from the project's app", () => {
  it("lets an account without a role report from int: the issue links the story, with page, version, component and screenshot", async () => {
    const { tokens } = await connect();
    await seedInt([146, 140]);
    mockVersion();
    const sent = mockGitHub();
    mockStoryComment(sent);

    const response = await report(tokens.access_token, { ...REPORT, screenshot: PNG });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      issue: { number: 150, url: `https://github.com/${REPO}/issues/150` },
      story: { number: 146 },
      triage: true,
    });

    const issue = sent.issue;
    expect(issue?.title).toBe(REPORT.title);
    expect(issue?.labels).toEqual(["bug", "to triage"]);
    expect(issue?.body).toContain("Defect reported from the app, on int, while testing #146.");
    expect(issue?.body).toContain("## What I saw\n\nNothing happens when I tap Save.");
    expect(issue?.body).toContain("| Version | `1.169–int` · deployment `319bb159` |");
    expect(issue?.body).toContain(`| Page | [/app/moi.html?ouvrir=integration](${INT_URL}/app/moi.html?ouvrir=integration) |`);
    expect(issue?.body).toContain("| Component | `button.save` « Save » (10, 20, 120 × 44) |");
    expect(issue?.body).toContain("| Screen | 390 × 844 @3x |");
    expect(issue?.body).toContain("TypeError: x is undefined");
    expect(issue?.body).toContain("@mona has no role in La Fabrique: to triage.");
    expect(issue?.body).toContain("Reported by @mona from Widget app, via La Fabrique extraordinaire");
    expect(sent.comment?.body).toBe("Defect reported by @mona: #150");

    const screenshot = /!\[Screenshot\]\((https:\/\/[^)]+)\)/.exec(issue?.body ?? "")?.[1] ?? "";
    expect(screenshot.startsWith(`${BASE}/screenshots/`)).toBe(true);
    const image = await SELF.fetch(screenshot);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await image.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await get(screenshot.replace(".png", ".jpg").slice(BASE.length))).status).toBe(404);

    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "mona", action: "defect_reported" }));
    const log = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'defect_reported'").first<{ issue_number: number; details: string }>();
    expect(log?.issue_number).toBe(146);
    expect(JSON.parse(log?.details ?? "{}")).toMatchObject({ defect: 150, environment: "int", triage: true, via: "Widget app" });
  });

  it("does not label a person with a role for triage, and links no story when several are on int", async () => {
    const { tokens } = await connect("tess");
    await grantRole("tess", "tester");
    await seedInt([146, 147]);
    mockVersion();
    const sent = mockGitHub();
    const response = await report(tokens.access_token, REPORT);
    expect(await response.json()).toMatchObject({ story: null, triage: false });
    expect(sent.issue?.labels).toEqual(["bug"]);
    expect(sent.issue?.body).toContain("Defect reported from the app, on int. On int at the time: #146, #147.");
  });

  it("refuses an environment with signalement false, or not declared", async () => {
    const { tokens } = await connect();
    const production = await report(tokens.access_token, { ...REPORT, environment: "production" });
    expect(production.status).toBe(403);
    expect(await production.json()).toMatchObject({ error: "reporting_disabled" });
    const local = await report(tokens.access_token, { ...REPORT, environment: "local" });
    expect(local.status).toBe(403);
  });

  it("refuses when the environment does not answer the same environnement", async () => {
    const { tokens } = await connect();
    mockVersion("production");
    const response = await report(tokens.access_token, REPORT);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "reporting_disabled" });
  });

  it("refuses another project than the connection's", async () => {
    const { tokens } = await connect();
    const response = await report(tokens.access_token, REPORT, "other-project");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "no_access" });
  });

  it("says which fields are invalid", async () => {
    const { tokens } = await connect();
    const response = await report(tokens.access_token, { ...REPORT, title: "", page: "https://elsewhere", screenshot: "data:image/gif;base64,R0lG" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid", fields: ["title", "page", "screenshot"] });
    const fake = await report(tokens.access_token, { ...REPORT, screenshot: "data:image/png;base64,/9j/4AAQ" });
    expect(await fake.json()).toMatchObject({ fields: ["screenshot"] });
  });

  it("caps the reports a day per account", async () => {
    const { tokens } = await connect();
    await env.DB.batch(
      Array.from({ length: DAILY_CAP }, () =>
        env.DB.prepare("INSERT INTO activity_log (actor, action, repo) VALUES ('mona', 'defect_reported', ?)").bind(REPO),
      ),
    );
    mockVersion();
    const response = await report(tokens.access_token, REPORT);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "daily_cap" });
  });

  it("answers 401 once the app is disconnected", async () => {
    const { tokens, cookie, csrf } = await connect();
    const page = await (await get("/apps", cookie)).text();
    const grant = /name="grant" value="([^"]+)"/.exec(page)?.[1] ?? "";
    await post("/apps", { csrf, action: "revoke", grant }, cookie);
    expect((await report(tokens.access_token, REPORT)).status).toBe(401);
  });

  it("reads int's declaration on the integration branch, deployed there, before it reaches production", async () => {
    const production = {
      ...CONFIG,
      branches: { production: "main", integration: "integration" },
      environnements: {
        int: { url: INT_URL, version: "/api/version" },
        production: { url: "https://widget.example.com", version: "/api/version", type: "production" },
      },
    };
    const { tokens } = await connect("mona", production);
    // Without the integration branch's reading, nothing is open.
    await env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, ?, ?, ?)")
      .bind(
        REPO,
        branchKind("integration"),
        JSON.stringify({
          branch: "integration",
          commitSha: "2".repeat(40),
          config: {
            ...production,
            environnements: {
              int: { url: INT_URL, version: "/api/version", type: "integration", signalement: true },
              production: { url: "https://widget.example.com", version: "/api/version", type: "integration", signalement: true },
            },
          },
          errors: [],
          checkedAt: new Date().toISOString(),
          committedAt: null,
          docPages: [],
        }),
        new Date().toISOString(),
      )
      .run();
    expect(((await (await me(tokens.access_token)).json()) as { can: { report_defect: boolean } }).can.report_defect).toBe(true);
    await seedInt([146]);
    mockVersion();
    const sent = mockGitHub();
    mockStoryComment(sent);
    expect((await report(tokens.access_token, REPORT)).status).toBe(201);
    // What production declares as production stays closed.
    expect((await report(tokens.access_token, { ...REPORT, environment: "production" })).status).toBe(403);
  });

  it("lists what a report can be about: the release notes on int, each with the stories it declares, the epic and defects left out", async () => {
    const { tokens } = await connect();
    await seedInt([146, 147, 140], [
      { version: "1.171", title: "Week", changes: ["Plan the week."], stories: [147, 140, 999] },
      // An entry that does not declare its stories has none, whatever is on int.
      { version: "1.170", title: "Menu", changes: [] },
    ]);
    const response = await SELF.fetch(`${BASE}/api/projects/widget/targets`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(response.status).toBe(200);
    const { versions } = (await response.json()) as { versions: { version: string; on_int: boolean; stories: { number: number; title: string }[] }[] };
    expect(versions[0]).toMatchObject({ version: "1.171", on_int: true, title: "Week", changes: ["Plan the week."] });
    expect(versions[0]?.stories).toEqual([
      { number: 147, title: "Story 147", url: `https://github.com/${REPO}/issues/147` },
      { number: 999, title: "", url: `https://github.com/${REPO}/issues/999` },
    ]);
    expect(versions[1]).toMatchObject({ version: "1.170", on_int: true, stories: [] });
    expect(versions).toHaveLength(2);
    const other = await SELF.fetch(`${BASE}/api/projects/other/targets`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(other.status).toBe(403);
  });

  it("links the story and the version the reporter chose", async () => {
    const { tokens } = await connect();
    await seedInt([146, 147], [{ version: "1.170", title: "Menu", changes: [] }]);
    mockVersion();
    const sent = mockGitHub();
    mockStoryComment(sent, 147);
    const response = await report(tokens.access_token, { ...REPORT, story: 147, release: "1.170" });
    expect(await response.json()).toMatchObject({ story: { number: 147 } });
    expect(sent.issue?.body).toContain("Defect reported from the app, on int, while testing #147. About version 1.170 “Menu”.");
    expect(sent.comment?.body).toBe("Defect reported by @mona: #150");
    const log = await env.DB.prepare("SELECT issue_number, details FROM activity_log WHERE action = 'defect_reported'").first<{ issue_number: number; details: string }>();
    expect(log?.issue_number).toBe(147);
    expect(JSON.parse(log?.details ?? "{}")).toMatchObject({ release: "1.170" });
  });

  it("links a change of the release note: quoted in the issue, kept in the log, and the version's only story linked", async () => {
    const { tokens } = await connect();
    await seedInt([147], [{ version: "1.170", title: "Menu", changes: ["Plan the week.", "Print the menu."] }]);
    mockVersion();
    const sent = mockGitHub();
    mockStoryComment(sent, 147);
    const response = await report(tokens.access_token, { ...REPORT, release: "1.170", change: 1 });
    expect(await response.json()).toMatchObject({ story: { number: 147 } });
    expect(sent.issue?.body).toContain("About version 1.170 “Menu”.\n\n> Print the menu.\n\n## What I saw");
    const log = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'defect_reported'").first<{ details: string }>();
    expect(JSON.parse(log?.details ?? "{}")).toMatchObject({ release: "1.170", change: "Print the menu." });
    expect((await report(tokens.access_token, { ...REPORT, release: "1.170", change: "1" })).status).toBe(400);

    const page = await (await get(`/projects/${REPO}/defects`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('<span class="mono">1.170</span><br /><span class="muted small">Print the menu.</span>');
  });

  it("lists the defects in the project's Defects tab, with their story, version and screenshot", async () => {
    const { tokens } = await connect();
    await seedInt([146, 147], [{ version: "1.170", title: "Menu", changes: [] }]);
    mockVersion();
    const sent = mockGitHub();
    mockStoryComment(sent, 147);
    await report(tokens.access_token, { ...REPORT, story: 147, release: "1.170", screenshot: PNG });
    const page = await (await get(`/projects/${REPO}/defects`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('aria-current="page">Defects</a>');
    expect(page).toContain("<strong>1 open</strong> · 1 to triage");
    expect(page).toContain(`href="/projects/${REPO}/defects/150"><span class="mono">#150</span> The save button does nothing</a> <span class="pill warn">to triage</span>`);
    expect(page).toContain(`href="https://github.com/${REPO}/issues/147">#147</a> Story 147`);
    expect(page).toContain('<td><span class="mono">1.170</span></td>');
    expect(page).toMatch(/href="\/screenshots\/[A-Za-z0-9_-]+\.png">Screenshot<\/a>/);
    const closed = await (await get(`/projects/${REPO}/defects?state=closed`, (await signIn("admin-one")).cookie)).text();
    expect(closed).toContain("No defect here.");
  });

  it("refuses a story that is not one of the project's", async () => {
    const { tokens } = await connect();
    await seedInt([146]);
    mockVersion();
    const response = await report(tokens.access_token, { ...REPORT, story: 999 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ fields: ["story"] });
  });

  it("says in /api/me that reporting is off when no environment allows it", async () => {
    const { tokens } = await connect("mona", {
      ...CONFIG,
      environnements: { int: { url: INT_URL, version: "/api/version", type: "integration", signalement: false } },
    });
    expect(((await (await me(tokens.access_token)).json()) as { can: { report_defect: boolean } }).can.report_defect).toBe(false);
  });
});

describe("Triage", () => {
  // A defect reported while two stories are on int: linked to none.
  async function reported(): Promise<void> {
    const { tokens } = await connect();
    await seedInt([146, 147], [{ version: "1.170", title: "Menu", changes: [] }]);
    mockVersion();
    mockGitHub();
    await report(tokens.access_token, REPORT);
  }

  function mockTriage(sent: { story?: string; defect?: string; label?: boolean }): void {
    const github = fetchMock.get("https://api.github.com");
    github
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues/147/comments` }).reply(201, (options) => {
      sent.story = (JSON.parse(String(options.body)) as { body: string }).body;
      return "{}";
    });
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues/150/comments` }).reply(201, (options) => {
      sent.defect = (JSON.parse(String(options.body)) as { body: string }).body;
      return "{}";
    });
    github.intercept({ method: "DELETE", path: `/repos/${REPO}/issues/150/labels/to%20triage` }).reply(200, () => {
      sent.label = true;
      return "[]";
    });
    github.intercept({ path: `/repos/${REPO}/issues/150` }).reply(
      200,
      JSON.stringify({
        number: 150,
        title: REPORT.title,
        state: "open",
        html_url: `https://github.com/${REPO}/issues/150`,
        user: { login: "la-fabrique[bot]" },
        labels: [{ name: "bug" }],
        created_at: "2026-10-30T12:00:00Z",
        updated_at: "2026-10-30T12:05:00Z",
        closed_at: null,
        body: "",
      }),
      JSON_HEADERS,
    );
  }

  // What the defect's page reads from GitHub: the issue, its comments, and
  // the story it is linked to.
  function mockLive(options: { body?: string; story?: number; comments?: { login: string; body: string }[] } = {}): void {
    const github = fetchMock.get("https://api.github.com");
    github
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ path: `/repos/${REPO}/issues/150` }).reply(
      200,
      JSON.stringify({ number: 150, title: REPORT.title, state: "open", html_url: `https://github.com/${REPO}/issues/150`, user: null, labels: [], created_at: "", updated_at: "", closed_at: null, body: options.body ?? "" }),
      JSON_HEADERS,
    );
    github.intercept({ path: `/repos/${REPO}/issues/150/comments?per_page=100` }).reply(
      200,
      JSON.stringify(
        (options.comments ?? []).map((comment, index) => ({
          user: { login: comment.login },
          created_at: "2026-10-30T13:00:00Z",
          html_url: `https://github.com/${REPO}/issues/150#issuecomment-${index}`,
          body: comment.body,
        })),
      ),
      JSON_HEADERS,
    );
    if (options.story) {
      github.intercept({ path: `/repos/${REPO}/issues/${options.story}` }).reply(
        200,
        JSON.stringify({ number: options.story, title: `Story ${options.story}`, state: "open", html_url: "", user: null, labels: [], created_at: "", updated_at: "", closed_at: null, body: "## Need\n\nSave the meal." }),
        JSON_HEADERS,
      );
    }
  }

  it("lists each defect with a link to its page, where testers triage it with the same choice as the report form", async () => {
    await reported();
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    const list = await (await get(`/projects/${REPO}/defects`, cookie)).text();
    expect(list).toContain(`<a href="/projects/${REPO}/defects/150"><span class="mono">#150</span> ${REPORT.title}</a>`);
    expect(list).toContain(`<a href="/projects/${REPO}/defects/150#triage">Triage</a>`);
    expect(list).not.toContain('name="about"');

    const screenshot = `${BASE}/screenshots/${"a".repeat(24)}.png`;
    mockLive({
      body: `## What I saw\n\nNothing happens, see #146.\n\n![Screenshot](${screenshot})\n\n![Elsewhere](https://example.com/x.png)`,
      comments: [{ login: "lead", body: "Seen on **int** too." }],
    });
    const page = await (await get(`/projects/${REPO}/defects/150`, cookie)).text();
    expect(page).toContain(`<h1>${REPORT.title}</h1>`);
    expect(page).toContain('<span class="pill warn">to triage</span>');
    expect(page).toContain(`href="https://github.com/${REPO}/issues/150">#150 on GitHub</a>`);
    expect(page).toContain("Not linked to a story yet.");
    expect(page).toContain('<h2 id="what-i-saw">What I saw</h2>');
    expect(page).toContain(`href="https://github.com/${REPO}/issues/146">#146</a>`);
    expect(page).toContain(`<img src="/screenshots/${"a".repeat(24)}.png" alt="Screenshot" loading="lazy" />`);
    expect(page).toContain('href="https://example.com/x.png" rel="noopener noreferrer">Image: Elsewhere</a>');
    expect(page).toContain("Seen on <strong>int</strong> too.");
    expect(page).toContain('<section id="triage" class="defect-triage">');
    expect(page).toContain('<input type="hidden" name="back" value="page" />');
    expect(page).toContain('<fieldset class="about-picker" data-about-picker>');
    expect(page).toContain('value="" checked /><label for="about-');
    expect(page).toContain('<input type="radio" name="about" id="about-1" value="r:1.170" /><label for="about-1"><strong class="mono">1.170</strong> Menu <span class="about-tag">on int</span></label>');
    expect(page).toMatch(/data-about-item data-text="#147 story 147"><input type="radio" name="about" id="(about-\d+)" value="s:147:1.170" \/><label for="\1">#147 Story 147<\/label>/);
    expect(page).toContain('name="triaged" value="1" checked');
    expect(page).toContain("reported defect");
  });

  it("links a defect to a story from its page, says it on GitHub, removes to triage, and To test follows", async () => {
    await reported();
    await grantRole("tess", "tester");
    const { cookie, csrf } = await signIn("tess");
    const sent: { story?: string; defect?: string; label?: boolean } = {};
    mockTriage(sent);
    const response = await post(`/projects/${REPO}/defects`, { csrf, defect: "150", about: "s:147:1.170", triaged: "1", back: "page" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/defects/150?notice=triaged#triage`);
    expect(sent.story).toBe("Defect #150 linked to this story by @tess");
    expect(sent.defect).toBe("Linked to #147 (version 1.170) by @tess, via La Fabrique extraordinaire");
    expect(sent.label).toBe(true);
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "tess", action: "defect_linked" }));

    const list = await (await get(`/projects/${REPO}/defects`, cookie)).text();
    expect(list).toContain(`href="https://github.com/${REPO}/issues/147">#147</a> Story 147`);
    expect(list).not.toContain('<span class="pill warn">to triage</span>');

    mockLive({ story: 147 });
    const page = await (await get(`/projects/${REPO}/defects/150?notice=triaged`, cookie)).text();
    expect(page).toContain("Defect triaged: its story and version are saved, and said on GitHub.");
    expect(page).toContain(`href="https://github.com/${REPO}/issues/147">#147</a> <strong>Story 147</strong>`);
    expect(page).toContain('<h2 id="need">Need</h2>');
    expect(page).toContain('value="s:147:1.170" checked />');
    expect(page).not.toContain('value="" checked');
    expect(page).toContain("triaged defect");

    const checks = await storyChecks(env.DB, REPO);
    expect(checks.get(147)?.defects).toEqual([150]);
  });

  it("triages to a change of a release note: each change is a choice, the one chosen is said on GitHub and shown checked", async () => {
    const { tokens } = await connect();
    await seedInt([146, 147], [{ version: "1.170", title: "Menu", changes: ["Plan the week.", "Print the menu."] }]);
    mockVersion();
    mockGitHub();
    await report(tokens.access_token, REPORT);
    const { cookie, csrf } = await signIn("admin-one");
    mockLive();
    const before = await (await get(`/projects/${REPO}/defects/150`, cookie)).text();
    expect(before).toMatch(/data-about-item data-text="print the menu\."><input type="radio" name="about" id="about-\d+" value="c:1:1.170" \/><label for="about-\d+">Print the menu\.<\/label>/);

    const sent: { defect?: string } = {};
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues/150/comments` }).reply(201, (options) => {
      sent.defect = (JSON.parse(String(options.body)) as { body: string }).body;
      return "{}";
    });
    const response = await post(`/projects/${REPO}/defects`, { csrf, defect: "150", about: "c:1:1.170", back: "page" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/defects/150?notice=triaged#triage`);
    expect(sent.defect).toBe("About version 1.170, no particular story (@admin-one, via La Fabrique extraordinaire)\n\n> Print the menu.");

    mockLive();
    const after = await (await get(`/projects/${REPO}/defects/150`, cookie)).text();
    expect(after).toContain('value="c:1:1.170" checked />');
    expect(after).toContain('<blockquote class="defect-change">');
    expect((await post(`/projects/${REPO}/defects`, { csrf, defect: "150", about: "c:7:1.170", back: "page" }, cookie)).status).toBe(400);
  });

  it("answers 404 for an issue that is not a defect, and keeps the list's filters when triaged from the list", async () => {
    await reported();
    const { cookie, csrf } = await signIn("admin-one");
    expect((await get(`/projects/${REPO}/defects/146`, cookie)).status).toBe(404);
    const response = await post(`/projects/${REPO}/defects`, { csrf, defect: "150", about: "", back: "?state=all" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/defects?state=all&notice=unchanged`);
  });

  it("refuses a story that is not the project's, and the defect itself", async () => {
    await reported();
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/defects`, { csrf, defect: "150", about: "s:150:" }, cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("#150 is not one of this project&#39;s stories.");
  });

  it("lists in To test the defects not linked to a story yet", () => {
    const content = toTestContent({ repo: REPO, installationId: 99, addedAt: "", addedBy: "", check: null }, {
      status: status([146]),
      stories: [story(146)] as never,
      environment: null,
      latest: null,
      unlinked: [{ number: 150, title: "Save does nothing", url: `https://github.com/${REPO}/issues/150`, triage: true }],
    });
    expect(content).toContain("<h2>Defects not linked to a story</h2>");
    expect(content).toContain(`<a href="/projects/${REPO}/defects/150">#150</a> Save does nothing <span class="pill warn">to triage</span>`);
    expect(content).toContain(`href="/projects/${REPO}/defects/150#triage">Triage</a>`);
  });
});
