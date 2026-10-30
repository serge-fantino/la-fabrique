import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import example from "../docs/exemples/epicerie.fabrique.json";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { "content-type": "application/json" };
const CONFIG = { nom: "Widget", demandes: example.demandes };

const ANSWERS = {
  title: "Mes recettes favorites",
  r_contexte: "Je refais souvent les mêmes plats.",
  r_besoin: "Retrouver mes recettes favorites en un geste.",
  r_criteres: "Quand je touche l'étoile, la recette passe en tête.",
  r_donnees_personnelles: "Aucune.",
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(config: unknown = CONFIG): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(config)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', '2099-01-01T00:00:00.000Z')").bind(REPO),
  ]);
}

function mockIssueCreation(token: string, labels: string[], sent: { body?: Record<string, unknown> }): void {
  fetchMock
    .get("https://api.github.com")
    .intercept({ method: "POST", path: `/repos/${REPO}/issues`, headers: { authorization: `Bearer ${token}` } })
    .reply((options) => {
      sent.body = JSON.parse(String(options.body)) as Record<string, unknown>;
      return {
        statusCode: 201,
        data: JSON.stringify({
          number: 42,
          title: ANSWERS.title,
          state: "open",
          html_url: `https://github.com/${REPO}/issues/42`,
          user: { login: "pe-anna" },
          labels: labels.map((name) => ({ name })),
          created_at: "2026-10-30T02:00:00Z",
          updated_at: "2026-10-30T02:00:00Z",
          closed_at: null,
        }),
        responseOptions: { headers: JSON_HEADERS },
      };
    });
}

describe("New request", () => {
  it("builds the form from the project's sections, with their help", async () => {
    await seed();
    await grantRole("pe-anna", "product_engineer");
    const page = await (await get(`/projects/${REPO}/requests/new`, (await signIn("pe-anna")).cookie)).text();
    expect(page).toContain('<label for="r_contexte">Contexte <span class="muted">(required)</span></label>');
    expect(page).toContain("Ce qui se passe aujourd&#39;hui, pour qui, et pourquoi ça ne va pas.");
    expect(page).toContain('<textarea id="r_donnees_personnelles" name="r_donnees_personnelles" rows="5" required');
    expect(page).toMatch(/<script src="\/request-draft\.js\?v=[0-9a-f]{8}" defer><\/script>/);
    expect(page).toContain('data-draft-key="lf-request:acme/widget"');
  });

  it("creates a readable issue under the person's name, with every section and the label", async () => {
    await seed();
    await grantRole("pe-anna", "product_engineer");
    const { cookie, csrf } = await signIn("pe-anna");
    const sent: { body?: Record<string, unknown> } = {};
    mockIssueCreation("gho_session_token", ["demande"], sent);

    const response = await post(`/projects/${REPO}/requests`, { csrf, ...ANSWERS }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/requests?created=42`);

    expect(sent.body?.["title"]).toBe(ANSWERS.title);
    expect(sent.body?.["labels"]).toEqual(["demande"]);
    const body = String(sent.body?.["body"]);
    const titles = example.demandes.rubriques.map((rubrique) => `## ${rubrique.titre}`);
    expect(titles.map((heading) => body.indexOf(heading))).toEqual(
      [...titles.map((heading) => body.indexOf(heading))].sort((a, b) => a - b),
    );
    expect(body).toContain("## Données personnelles\n\nAucune.");
    expect(body).toContain("## Écrans concernés\n\n—");
    expect(body.endsWith("Demande de @pe-anna via La Fabrique extraordinaire")).toBe(true);

    expect(await logActions()).toEqual([
      {
        actor: "pe-anna",
        action: "request_created",
        details: JSON.stringify({ title: ANSWERS.title, url: `https://github.com/${REPO}/issues/42` }),
      },
    ]);

    const mine = await (await get(`/projects/${REPO}/requests?created=42`, cookie)).text();
    expect(mine).toContain('data-draft-clear="lf-request:acme/widget"');
    expect(mine).toContain(`<a href="https://github.com/${REPO}/issues/42">Mes recettes favorites</a>`);
    expect(mine).toContain("Issue open");
  });

  it("lets the App add the label when GitHub drops it", async () => {
    await seed();
    await grantRole("pe-anna", "product_engineer");
    const { cookie, csrf } = await signIn("pe-anna");
    mockIssueCreation("gho_session_token", [], {});
    fetchMock
      .get("https://api.github.com")
      .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
      .reply(201, JSON.stringify({ token: "ghs_installation" }), { headers: JSON_HEADERS });
    fetchMock
      .get("https://api.github.com")
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/42/labels`, headers: { authorization: "Bearer ghs_installation" } })
      .reply(200, JSON.stringify([{ name: "demande" }]), { headers: JSON_HEADERS });

    const response = await post(`/projects/${REPO}/requests`, { csrf, ...ANSWERS }, cookie);
    expect(response.status).toBe(303);
  });

  it("refuses to send while a required section is empty", async () => {
    await seed();
    await grantRole("pe-anna", "product_engineer");
    const { cookie, csrf } = await signIn("pe-anna");

    const response = await post(`/projects/${REPO}/requests`, { csrf, ...ANSWERS, r_donnees_personnelles: "  " }, cookie);
    expect(response.status).toBe(422);
    const page = await response.text();
    expect(page).toContain("Fill in before sending:");
    expect(page).toContain("<li>Données personnelles</li>");
    expect(page).toContain("Mes recettes favorites");
  });

  it("renews an expired GitHub token before creating the issue", async () => {
    await seed();
    await grantRole("pe-anna", "product_engineer");
    const { cookie, csrf } = await signIn("pe-anna", {
      accessToken: "ghu_expired",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      refreshToken: "ghr_refresh",
      refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    fetchMock
      .get("https://github.com")
      .intercept({ method: "POST", path: "/login/oauth/access_token" })
      .reply(200, JSON.stringify({ access_token: "ghu_fresh", expires_in: 28800 }), { headers: JSON_HEADERS });
    mockIssueCreation("ghu_fresh", ["demande"], {});

    expect((await post(`/projects/${REPO}/requests`, { csrf, ...ANSWERS }, cookie)).status).toBe(303);
    const stored = await env.DB.prepare("SELECT access_token FROM sessions WHERE github_login = 'pe-anna'").first("access_token");
    expect(stored).toBe("ghu_fresh");
  });

  it("is not offered to testers, and the API refuses them", async () => {
    await seed();
    await grantRole("qa", "tester");
    const { cookie, csrf } = await signIn("qa");

    const list = await (await get(`/projects/${REPO}/requests`, cookie)).text();
    expect(list).not.toContain("New request");
    expect((await get(`/projects/${REPO}/requests/new`, cookie)).status).toBe(403);
    expect((await post(`/projects/${REPO}/requests`, { csrf, ...ANSWERS }, cookie)).status).toBe(403);
    expect(await logActions()).toEqual([]);
  });

  it("requires the CSRF token", async () => {
    await seed();
    await grantRole("pe-anna", "product_engineer");
    const { cookie } = await signIn("pe-anna");
    expect((await post(`/projects/${REPO}/requests`, ANSWERS, cookie)).status).toBe(403);
  });

  it("serves the draft script under the strict CSP", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/request-draft.js");
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("localStorage");
  });
});
