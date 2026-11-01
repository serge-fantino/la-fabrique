import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateFabriqueConfig } from "../src/fabrique-config";
import { KIT_SOURCES, KIT_VERSION } from "../src/kit";
import { compareVersions, relayChanges } from "../src/kit-update";
import { get, grantRole, logActions, post, signIn } from "./helpers";
import { addProject, CONFIG, REPO } from "./oauth-helpers";

const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const FOLDER = "site/static/vendor/fabrique";
const KIT_CONFIG = {
  ...CONFIG,
  version: { coulisses: "[coulisses]" },
  application: { nom: "Widget app", retour: "/auth/fabrique/retour", kit: FOLDER },
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function github() {
  return fetchMock.get("https://api.github.com");
}

function appToken(): void {
  github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
}

// The project's copy, version 1.0.0, under the stable names.
function mockCopy(names = ["fabrique-report.js", "fabrique-report.css"], version = "1.0.0"): void {
  appToken();
  github()
    .intercept({ path: `/repos/${REPO}/contents/${FOLDER}?ref=main` })
    .reply(200, JSON.stringify(names.map((name) => ({ name, path: `${FOLDER}/${name}`, sha: `sha-${name}`, type: "file" }))), JSON_HEADERS);
  const script = names.find((name) => name.endsWith(".js") && !name.includes("early"));
  if (script) {
    github()
      .intercept({ path: `/repos/${REPO}/contents/${FOLDER}/${script}?ref=main` })
      .reply(200, `/*! FabriqueReport ${version} — report a defect */\n(function () {})();`);
  }
}

async function setup(login = "admin-one"): Promise<string> {
  await env.DB.prepare("INSERT OR REPLACE INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)")
    .bind(REPO, new Date().toISOString())
    .run();
  return (await get(`/projects/${REPO}/setup`, (await signIn(login)).cookie)).text();
}

describe("The report kit's version", () => {
  it("compares versions and lists what the relay must follow", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions(KIT_VERSION, KIT_VERSION)).toBe(0);
    expect(relayChanges("1.0.0").join(" ")).toContain("GET ?targets=1");
    expect(relayChanges("1.1.0").join(" ")).toContain("`change`");
    expect(relayChanges("1.2.0").join(" ")).toContain("stories:test");
    expect(relayChanges(KIT_VERSION)).toEqual([]);
  });

  it("reads application.kit and version.coulisses in .fabrique.json", () => {
    const tree = { files: new Set<string>(), folders: new Set<string>(), complete: false };
    const good = validateFabriqueConfig(JSON.stringify({ nom: "W", version: { coulisses: "[coulisses]" }, application: { kit: "./site/vendor/fabrique/" } }), tree);
    expect(good.errors).toEqual([]);
    expect(good.config?.application?.kit).toBe("site/vendor/fabrique");
    expect(good.config?.version?.coulisses).toBe("[coulisses]");
    const bad = validateFabriqueConfig(JSON.stringify({ nom: "W", application: { kit: "../etc" } }), tree);
    expect(bad.errors[0]).toContain("`application.kit`");
  });
});

describe("The report kit in Setup", () => {
  it("asks to declare the folder when the project does not", async () => {
    await addProject();
    expect(await setup()).toContain('Declare where the project keeps its copy, <code>"application": { "kit": "site/static/vendor/fabrique" }</code>');
  });

  it("says the project's copy is behind, what the relay must follow, and offers the update", async () => {
    await addProject(KIT_CONFIG);
    mockCopy();
    await grantRole("lead", "tech_lead");
    const page = await setup("lead");
    expect(page).toContain(`Kit 1.0.0 in <code>${FOLDER}</code> on <code>main</code>; <strong>${KIT_VERSION} is available</strong>.`);
    expect(page).toContain("<code>GET ?targets=1</code>");
    expect(page).toContain(`Propose the update to ${KIT_VERSION}`);
    // Read again from the cache, without asking GitHub.
    expect(await setup("lead")).toContain("is available");
  });

  it("says when the copy is up to date, and when its names carry the version", async () => {
    await addProject(KIT_CONFIG);
    mockCopy(["fabrique-report.js"], KIT_VERSION);
    expect(await setup()).toContain(`Kit ${KIT_VERSION} in <code>${FOLDER}</code> on <code>main</code>: up to date.`);
    await env.DB.prepare("DELETE FROM snapshots WHERE kind = 'kit'").run();
    mockCopy(["fabrique-report-1.0.0.js"], "1.0.0");
    expect(await setup()).toContain("name them <code>fabrique-report.js</code>");
  });

  it("proposes the update as a pull request under the person's name, with the project's marker", async () => {
    await addProject(KIT_CONFIG);
    mockCopy();
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    github().intercept({ path: `/repos/${REPO}/git/ref/heads/main` }).reply(200, JSON.stringify({ object: { sha: "abc" } }), JSON_HEADERS);
    github().intercept({ method: "POST", path: `/repos/${REPO}/git/refs` }).reply(201, "{}", JSON_HEADERS);
    const commits: { path: string; message: string; content: string; sha?: string }[] = [];
    for (const name of ["fabrique-report.js", "fabrique-report.css"]) {
      github()
        .intercept({ method: "PUT", path: `/repos/${REPO}/contents/${FOLDER}/${name}` })
        .reply(200, (options) => {
          commits.push({ path: name, ...(JSON.parse(String(options.body)) as { message: string; content: string; sha?: string }) });
          return "{}";
        });
    }
    let pull = null as { title: string; body: string; base: string } | null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/pulls` })
      .reply(201, (options) => {
        pull = JSON.parse(String(options.body));
        return JSON.stringify({ number: 42, html_url: `https://github.com/${REPO}/pull/42` });
      });

    const response = await post(`/projects/${REPO}/kit`, { csrf }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/setup?notice=kit_proposed&pull=42#connected-app`);
    expect(commits.map((commit) => commit.path)).toEqual(["fabrique-report.js", "fabrique-report.css"]);
    expect(commits[0]?.message.startsWith(`[coulisses] La Fabrique: report kit ${KIT_VERSION}`)).toBe(true);
    expect(commits[0]?.sha).toBe("sha-fabrique-report.js");
    const bytes = Uint8Array.from(atob(commits[1]?.content ?? ""), (char) => char.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(KIT_SOURCES["fabrique-report.css"]);
    expect(pull?.title).toBe(`[coulisses] La Fabrique: report kit ${KIT_VERSION}`);
    expect(pull?.body).toContain("**The relay on the app's server has to follow**");
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "lead", action: "kit_update_proposed" }));
  });

  it("is proposed by tech leads and super admins only", async () => {
    await addProject(KIT_CONFIG);
    await grantRole("tess", "tester");
    const { cookie, csrf } = await signIn("tess");
    expect((await post(`/projects/${REPO}/kit`, { csrf }, cookie)).status).toBe(403);
  });
});
