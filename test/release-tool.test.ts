import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RELEASE_NOTES_KIT_VERSION, RELEASE_NOTES_TOOL } from "../src/kit";
import { setupChecklist } from "../src/setup";
import { get, grantRole, logActions, post, signIn } from "./helpers";
import { addProject, REPO } from "./oauth-helpers";

// The project's copy of La Fabrique's release-notes tool (version.outil): its
// version in Setup, and its update proposed as a pull request.

const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const TOOL = "scripts/fabrique/release-notes.js";
const TOOL_CONFIG = {
  nom: "Widget",
  // No version.fichier: the release notes would be read too.
  version: { coulisses: "[coulisses]", outil: TOOL },
  workflows: { fusionner: "merge.yml" },
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function github() {
  return fetchMock.get("https://api.github.com");
}

// The copy on main, at a given version; or none.
function mockCopy(version: string | null): void {
  github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
  if (version === null) {
    github().intercept({ path: `/repos/${REPO}/contents/${TOOL}?ref=main` }).reply(404, "{}");
    return;
  }
  github().intercept({ path: `/repos/${REPO}/contents/${TOOL}?ref=main` }).reply(200, JSON.stringify({ sha: "sha-tool", path: TOOL }), JSON_HEADERS);
  github().intercept({ path: `/repos/${REPO}/contents/${TOOL}?ref=main` }).reply(200, `// FabriqueReleaseNotes ${version} — La Fabrique's release-notes tool\nexport const VERSION = "${version}";\n`);
}

async function setup(login = "admin-one"): Promise<string> {
  await env.DB.prepare("INSERT OR REPLACE INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(REPO, new Date().toISOString()).run();
  return (await get(`/projects/${REPO}/setup`, (await signIn(login)).cookie)).text();
}

describe("The release-notes tool in Setup", () => {
  it("is optional until declared, missing when absent or behind, done when up to date", () => {
    const found = (releaseTool?: Parameters<typeof setupChecklist>[0]["releaseTool"]) =>
      setupChecklist({ check: null, releases: null, stories: null, branches: [], ...(releaseTool === undefined ? {} : { releaseTool }) }).find((item) => item.key === "release_tool");
    const base = { branch: "main", latest: "1.2.0" };
    expect(found({ ...base, path: null, version: null, exists: false })?.state).toBe("optional");
    expect(found({ ...base, path: TOOL, version: null, exists: false })).toMatchObject({ state: "missing", found: `\`${TOOL}\` is not on \`main\` yet; 1.2.0 is available.` });
    expect(found({ ...base, path: TOOL, version: "1.0.0", exists: true })?.state).toBe("missing");
    expect(found({ ...base, path: TOOL, version: "1.2.0", exists: true })?.state).toBe("done");
    expect(found({ ...base, path: TOOL, version: null, exists: false, failure: "GitHub answered 500" })?.state).toBe("unknown");
    expect(found()).toBeUndefined();
  });

  it("says the copy is behind and offers the update to a tech lead", async () => {
    await addProject(TOOL_CONFIG);
    mockCopy("0.9.0");
    await grantRole("lead", "tech_lead");
    const page = await setup("lead");
    expect(page).toContain(`<code>${TOOL}</code> on <code>main</code>: 0.9.0; ${RELEASE_NOTES_KIT_VERSION} is available, run by <code>merge.yml</code>.`);
    expect(page).toContain(`Propose the update to ${RELEASE_NOTES_KIT_VERSION}`);
    // Read again from the cache, without asking GitHub.
    expect(await setup("lead")).toContain("is available");
  });

  it("says when the copy is up to date, with nothing to propose", async () => {
    await addProject(TOOL_CONFIG);
    mockCopy(RELEASE_NOTES_KIT_VERSION);
    const page = await setup();
    expect(page).toContain(`<code>${TOOL}</code> on <code>main</code>: ${RELEASE_NOTES_KIT_VERSION}, up to date, run by <code>merge.yml</code>.`);
    expect(page).not.toContain("Propose the update to");
  });

  it("proposes the update as a pull request under the person's name, with the project's marker", async () => {
    await addProject(TOOL_CONFIG);
    mockCopy("0.9.0");
    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    github().intercept({ path: `/repos/${REPO}/git/ref/heads/main` }).reply(200, JSON.stringify({ object: { sha: "abc" } }), JSON_HEADERS);
    github().intercept({ method: "POST", path: `/repos/${REPO}/git/refs` }).reply(201, "{}", JSON_HEADERS);
    let commit = null as { message: string; content: string; sha?: string; branch: string } | null;
    github()
      .intercept({ method: "PUT", path: `/repos/${REPO}/contents/${TOOL}` })
      .reply(200, (options) => {
        commit = JSON.parse(String(options.body));
        return "{}";
      });
    let pull = null as { title: string; body: string; base: string } | null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/pulls` })
      .reply(201, (options) => {
        pull = JSON.parse(String(options.body));
        return JSON.stringify({ number: 43, html_url: `https://github.com/${REPO}/pull/43` });
      });

    const response = await post(`/projects/${REPO}/release-tool`, { csrf }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/setup?notice=release_tool_proposed&pull=43#release-tool`);
    expect(commit?.message.startsWith(`[coulisses] La Fabrique: release-notes tool ${RELEASE_NOTES_KIT_VERSION}`)).toBe(true);
    expect(commit?.sha).toBe("sha-tool");
    expect(commit?.branch.startsWith(`fabrique/release-notes-${RELEASE_NOTES_KIT_VERSION}-`)).toBe(true);
    const bytes = Uint8Array.from(atob(commit?.content ?? ""), (char) => char.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(RELEASE_NOTES_TOOL);
    expect(pull).toMatchObject({ title: `[coulisses] La Fabrique: release-notes tool ${RELEASE_NOTES_KIT_VERSION}`, base: "main" });
    expect(pull?.body).toContain("from 0.9.0 to");
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "lead", action: "release_tool_update_proposed" }));
  });

  it("proposes the tool itself when the declared copy is not there yet", async () => {
    await addProject(TOOL_CONFIG);
    mockCopy(null);
    await grantRole("lead", "tech_lead");
    expect(await setup("lead")).toContain(`Propose the tool ${RELEASE_NOTES_KIT_VERSION}`);
  });

  it("is proposed by tech leads and super admins only", async () => {
    await addProject(TOOL_CONFIG);
    await grantRole("tess", "tester");
    const { cookie, csrf } = await signIn("tess");
    expect((await post(`/projects/${REPO}/release-tool`, { csrf }, cookie)).status).toBe(403);
  });
});
