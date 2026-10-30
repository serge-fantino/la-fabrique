import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DAILY_CAP } from "../src/defects";
import type { ProductionStatus } from "../src/production";
import { BASE, get, grantRole, logActions, post } from "./helpers";
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

function status(issues: number[]): ProductionStatus {
  return {
    production: "main",
    integration: "integration",
    integrationHead: "abc",
    aheadBy: 1,
    groups: [{ branch: "feature/146-x", title: "", mergedAt: "2026-10-30T08:00:00Z", commits: [], issues }],
    workflows: [],
    versions: [],
    waiting: [],
    ready: true,
    blockers: [],
  };
}

async function seedInt(issues: number[]): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(status(issues)), now),
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

  it("says in /api/me that reporting is off when no environment allows it", async () => {
    const { tokens } = await connect("mona", {
      ...CONFIG,
      environnements: { int: { url: INT_URL, version: "/api/version", type: "integration", signalement: false } },
    });
    expect(((await (await me(tokens.access_token)).json()) as { can: { report_defect: boolean } }).can.report_defect).toBe(false);
  });
});
