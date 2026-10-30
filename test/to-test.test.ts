import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProductionStatus } from "../src/production";
import { get, grantRole, logActions, post, signIn } from "./helpers";

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
    expect(page).toContain('<button type="submit" class="criterion" aria-pressed="true"><span class="box" aria-hidden="true">✓</span><span>Meals can move');
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

describe("Validating on int", () => {
  const ISSUE = {
    number: 31,
    title: "Plan the week",
    state: "open",
    html_url: `https://github.com/${REPO}/issues/31`,
    user: { login: "pe" },
    labels: [{ name: "a-valider-sur-int" }],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    closed_at: null,
    body: "## Besoin\n\nPlanifier.\n\n## Critères d'acceptation\n\nSept jours s'affichent\nUn repas se déplace\n\n---\nDemande de @pe",
  };
  const CONFIG_FR = { ...CONFIG, demandes: { etiquettes: { a_valider: "a-valider-sur-int" } } };

  function github() {
    return fetchMock.get("https://api.github.com");
  }

  function appToken(times = 1) {
    github()
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS)
      .times(times);
  }

  it("ticks a criterion in the GitHub issue, as the person, and logs it", async () => {
    await seed(CONFIG_FR);
    appToken();
    github().intercept({ path: `/repos/${REPO}/issues/31` }).reply(200, JSON.stringify(ISSUE), JSON_HEADERS);
    let sent = null as { body: string } | null;
    let auth = "";
    github()
      .intercept({ method: "PATCH", path: `/repos/${REPO}/issues/31` })
      .reply(200, (options) => {
        sent = JSON.parse(String(options.body));
        auth = (options.headers as Record<string, string>)["authorization"] ?? "";
        return JSON.stringify({ ...ISSUE, body: sent?.body });
      });
    await grantRole("qa", "tester");
    const { cookie, csrf } = await signIn("qa");
    const response = await post(`/projects/${REPO}/to-test/criterion`, { csrf, issue: "31", index: "1", text: "Un repas se déplace", done: "1" }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/to-test#story-31`);
    expect(auth).toBe("Bearer gho_session_token");
    expect(sent?.body).toBe("## Besoin\n\nPlanifier.\n\n## Critères d'acceptation\n\nSept jours s'affichent\n- [x] Un repas se déplace\n\n---\nDemande de @pe");
    expect(await logActions()).toContainEqual({ actor: "qa", action: "criterion_checked", details: JSON.stringify({ index: 1, text: "Un repas se déplace" }) });
  });

  it("refuses when the issue changed meanwhile", async () => {
    await seed(CONFIG_FR);
    appToken();
    github().intercept({ path: `/repos/${REPO}/issues/31` }).reply(200, JSON.stringify(ISSUE), JSON_HEADERS);
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/to-test/criterion`, { csrf, issue: "31", index: "1", text: "Something else", done: "1" }, cookie);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("The issue changed on GitHub meanwhile");
  });

  it("validates only when every criterion is checked, comments in the project's language and removes the label", async () => {
    await seed(CONFIG_FR);
    appToken(3);
    github().intercept({ path: `/repos/${REPO}/issues/31` }).reply(200, JSON.stringify(ISSUE), JSON_HEADERS);
    const { cookie, csrf } = await signIn("admin-one");
    const refused = await post(`/projects/${REPO}/to-test/validate`, { csrf, issue: "31" }, cookie);
    expect(refused.status).toBe(422);

    const done = { ...ISSUE, body: ISSUE.body.replace("Sept jours s'affichent\nUn repas se déplace", "- [x] Sept jours s'affichent\n- [x] Un repas se déplace") };
    github().intercept({ path: `/repos/${REPO}/issues/31` }).reply(200, JSON.stringify(done), JSON_HEADERS);
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/31/comments` })
      .reply(201, (options) => {
        comment = JSON.parse(String(options.body)).body;
        return "{}";
      });
    github().intercept({ method: "DELETE", path: `/repos/${REPO}/issues/31/labels/a-valider-sur-int` }).reply(200, "[]", JSON_HEADERS);
    const response = await post(`/projects/${REPO}/to-test/validate`, { csrf, issue: "31" }, cookie);
    expect(response.status).toBe(303);
    expect(comment).toBe("Validé sur int par @admin-one (version 1.169) : tous les critères d'acceptation sont vérifiés.");
    expect(await logActions()).toContainEqual({ actor: "admin-one", action: "story_validated", details: JSON.stringify({ version: "1.169" }) });

    const page = await (await get(`/projects/${REPO}/to-test`, cookie)).text();
    expect(page).toContain('<span class="pill ok">Validated</span> by @admin-one');
  });

  it("reports a defect as a new issue linked to the story", async () => {
    await seed(CONFIG_FR);
    let created = null as { title: string; body: string } | null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues` })
      .reply(201, (options) => {
        created = JSON.parse(String(options.body));
        return JSON.stringify({ ...ISSUE, number: 90, title: created?.title, body: created?.body, labels: [] });
      });
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/31/comments` })
      .reply(201, (options) => {
        comment = JSON.parse(String(options.body)).body;
        return "{}";
      });
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const response = await post(
      `/projects/${REPO}/to-test/defect`,
      { csrf, issue: "31", title: "Monday is missing", did: "Opened the menu", saw: "Six days", expected: "Seven days" },
      cookie,
    );
    expect(response.status).toBe(303);
    expect(created?.title).toBe("Monday is missing");
    expect(created?.body).toContain("Défaut trouvé sur int en testant #31.");
    expect(created?.body).toContain("## Ce que j'ai vu\n\nSix days");
    expect(comment).toBe("Défaut signalé par @pe : #90");
    const page = await (await get(`/projects/${REPO}/to-test`, cookie)).text();
    expect(page).toContain(`#90</a> Monday is missing <span class="pill alert">Open</span>`);
  });

  it("lets a tech lead read but not validate", async () => {
    await seed();
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    const page = await (await get(`/projects/${REPO}/to-test`, cookie)).text();
    expect(page).not.toContain("to-test/validate");
    expect((await post(`/projects/${REPO}/to-test/validate`, { csrf, issue: "31" }, cookie)).status).toBe(403);
  });
});
