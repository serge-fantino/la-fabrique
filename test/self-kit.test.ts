import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions, signIn } from "./helpers";

// La Fabrique tests itself (la-fabrique#211): the kit on its own pages,
// relayed by the person's session to the same project API.
const REPO = "acme/la-fabrique";
const J = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(): Promise<void> {
  const config = {
    nom: "La Fabrique",
    langue: "en",
    branches: { production: "main" },
    environnements: { production: { url: BASE, version: "/api/version", type: "production", signalement: "equipe" } },
  };
  const merged = [{ number: 30, url: `https://github.com/${REPO}/pull/30`, state: "merged" }];
  const story = (number: number, pullRequests: unknown[]) => ({
    number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests, branches: [], criteria: [{ text: "Works", done: false }],
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(REPO, JSON.stringify([story(211, merged), story(212, [])]), new Date().toISOString()),
  ]);
}

function relay(cookie: string | null, init: { path?: string; method?: string; body?: unknown; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (init.method === "POST") {
    headers["content-type"] = "application/json";
    headers["origin"] = init.origin ?? BASE;
  }
  return SELF.fetch(`${BASE}/self/relay${init.path ? `?path=${init.path}` : ""}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe("La Fabrique's own kit (la-fabrique#211)", () => {
  it("is on the pages of a signed-in person, and its relay says what they can do", async () => {
    await seed();
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    const page = await (await get("/settings", cookie)).text();
    expect(page).toContain('<meta name="fabrique-kit" content="/self/relay" />');
    expect(page).toContain('<link rel="stylesheet" href="/kit/fabrique-report.css" />');
    expect(await (await relay(cookie)).json()).toEqual({ relay: 2, linked: true, login: "tess", can: { report_defect: true, test_stories: true } });
    // Signed out: nothing.
    expect(await (await relay(null)).json()).toEqual({ relay: 2, linked: false, can: { report_defect: false, test_stories: false } });
    expect(await (await get("/", undefined)).text()).not.toContain("fabrique-kit");
  });

  it("lists the stories to validate in production, and reports a defect in the person's name", async () => {
    await seed();
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    const stories = (await (await relay(cookie, { path: "to-test" })).json()) as { stories: { number: number }[] };
    expect(stories.stories.map((story) => story.number)).toEqual([211]);

    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), J);
    let sent: { title: string; body: string; labels: string[] } | null = null;
    github.intercept({ method: "POST", path: `/repos/${REPO}/issues` }).reply(201, (options) => {
      sent = JSON.parse(String(options.body));
      return JSON.stringify({ number: 300, title: "Broken", state: "open", html_url: `https://github.com/${REPO}/issues/300`, user: null, labels: [], created_at: "", updated_at: "", closed_at: null, body: "" });
    }, J);
    const response = await relay(cookie, { method: "POST", path: "defects", body: { title: "The board does not move", seen: "Nothing moves.", page: "/projects/acme/la-fabrique/board" } });
    expect(response.status).toBe(201);
    expect(sent!.labels).toEqual(["bug"]);
    expect(sent!.body).toContain("@tess");
    expect(sent!.body).toContain("/projects/acme/la-fabrique/board");
    expect((await logActions()).some((entry) => entry.action === "defect_reported")).toBe(true);
  });

  it("refuses a request from another site, and a path out of the project API", async () => {
    await seed();
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    expect((await relay(cookie, { method: "POST", path: "defects", body: { title: "x" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await relay(cookie, { path: "../../oauth" })).status).toBe(400);
    expect((await relay(null, { path: "to-test" })).status).toBe(403);
  });
});
