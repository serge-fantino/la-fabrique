import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addEmptyRelease, nextVersion } from "../src/next-release";
import type { ProductionStatus } from "../src/production";
import { get, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const CONFIG = {
  nom: "Widget",
  branches: { production: "main", integration: "integration" },
  workflows: { promouvoir: "promouvoir.yml" },
  version: { fichier: "docs/notes.json", forme: "1.N" },
};
const NOTES = `[
  {
    "version": "1.4",
    "titre": "Menu",
    "changements": ["Plan."],
    "stories": [31],
    "liens": null
  }
]
`;
const STATUS: ProductionStatus = {
  production: "main",
  integration: "integration",
  integrationHead: "abc123",
  aheadBy: 1,
  groups: [],
  workflows: [],
  versions: [],
  waiting: [{ version: "1.4", title: "Menu", changes: ["Plan."] }],
  ready: true,
  blockers: [],
};

describe("nextVersion", () => {
  it("increments the minor or the major", () => {
    expect(nextVersion("1.4", "minor")).toBe("1.5");
    expect(nextVersion("1.4", "major")).toBe("2.0");
    expect(nextVersion("v1.169", "minor")).toBe("v1.170");
    expect(nextVersion("v1.169", "major")).toBe("v2.0");
    expect(nextVersion("next", "minor")).toBeNull();
  });
});

describe("addEmptyRelease", () => {
  it("puts an empty entry without heure on top, and refuses a version already there", () => {
    const text = addEmptyRelease(NOTES, "1.5")!;
    const entries = JSON.parse(text);
    expect(entries[0]).toEqual({ version: "1.5", titre: "", changements: [], stories: [], liens: null });
    expect(entries[1].version).toBe("1.4");
    expect(addEmptyRelease(NOTES, "1.4")).toBeNull();
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(REPO, now),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(REPO, JSON.stringify(STATUS), now),
  ]);
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("The go chooses the next release", () => {
  it("proposes the minor increment by default and the major on request", async () => {
    await seed();
    const page = await (await get(`/projects/${REPO}/production`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('name="next" value="minor" checked> Minor: <span class="mono">1.5</span>');
    expect(page).toContain('name="next" value="major"> Major: <span class="mono">2.0</span>');
  });

  it("opens a pull request on integration with the chosen number and journals it", async () => {
    await seed();
    const github = fetchMock.get("https://api.github.com");
    github.intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/promouvoir.yml/dispatches` }).reply(204, "");
    github.intercept({ path: `/repos/${REPO}/contents/docs/notes.json?ref=integration` }).reply(200, JSON.stringify({ content: toBase64(NOTES), sha: "filesha" }), JSON_HEADERS);
    github.intercept({ path: `/repos/${REPO}/git/ref/heads/integration` }).reply(200, JSON.stringify({ object: { sha: "headsha" } }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/git/refs` }).reply(201, "{}");
    let written = "";
    github.intercept({ method: "PUT", path: `/repos/${REPO}/contents/docs/notes.json` }).reply(200, (options) => {
      const body = JSON.parse(String(options.body)) as { content: string };
      written = new TextDecoder().decode(Uint8Array.from(atob(body.content), (char) => char.charCodeAt(0)));
      return "{}";
    });
    let pull: { base: string; title: string } | null = null;
    github.intercept({ method: "POST", path: `/repos/${REPO}/pulls` }).reply(201, (options) => {
      pull = JSON.parse(String(options.body));
      return JSON.stringify({ number: 88, html_url: `https://github.com/${REPO}/pull/88` });
    });

    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/production/go`, { csrf, next: "major" }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/production?notice=given-opened`);
    expect(JSON.parse(written)[0]).toEqual({ version: "2.0", titre: "", changements: [], stories: [], liens: null });
    expect(pull!.base).toBe("integration");
    const actions = await logActions();
    expect(actions).toContainEqual(expect.objectContaining({ actor: "admin-one", action: "next_release_proposed" }));
    expect(actions.find((a) => a.action === "go_given")?.details).toContain('"next":"2.0","next_kind":"major"');
    const log = await (await get(`/projects/${REPO}/log`, cookie)).text();
    expect(log).toContain('proposed the next release <span class="mono">2.0</span> (major, after <span class="mono">1.4</span>)');
  });
});
