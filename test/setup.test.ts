import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import example from "../docs/exemples/epicerie.fabrique.json";
import own from "../.fabrique.json";
import releaseNotes from "../docs/release-notes.json";
import type { FabriqueConfig } from "../src/fabrique-config";
import type { ConfigCheck } from "../src/projects";
import { parseReleases } from "../src/roadmap";
import { setupChecklist, type SetupItem } from "../src/setup";
import type { Story } from "../src/stories";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";

function check(config: FabriqueConfig | null, errors: string[] = [], docPages: string[] = ["CLAUDE.md"]): ConfigCheck {
  return { branch: "main", commitSha: "1".repeat(40), config, errors, checkedAt: "2026-10-30T09:00:00Z", committedAt: null, docPages };
}

const STORIES = [
  { number: 1, title: "Epic", subTotal: 2, parent: null },
  { number: 2, title: "Story", subTotal: 0, parent: 1, pullRequests: [{ number: 3, url: "", state: "merged" }] },
] as Story[];

const RELEASES = parseReleases(JSON.stringify(releaseNotes));

function states(items: SetupItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.key, item.state]));
}

describe("setupChecklist", () => {
  it("finds the épicerie all done, integration included; its lifecycle is optional until declared", () => {
    const items = setupChecklist({
      check: check(example as FabriqueConfig),
      releases: RELEASES,
      stories: STORIES,
      branches: ["main", "integration", "feature/138-emails"],
    });
    const found = states(items);
    expect(found["cycle"]).toBe("optional");
    expect(found["promotion"]).toBe("optional");
    expect(found["claude_workflow"]).toBe("optional");
    const optional = new Set(["cycle", "promotion", "claude_workflow"]);
    expect(Object.entries(found).filter(([key]) => !optional.has(key)).every(([, state]) => state === "done")).toBe(true);
  });

  it("finds La Fabrique done, with integration optional", () => {
    const items = setupChecklist({
      check: check(own as FabriqueConfig),
      releases: RELEASES,
      stories: STORIES,
      branches: ["main", "claude/compassionate-wright-34"],
    });
    const found = states(items);
    expect(found["integration"]).toBe("optional");
    const optional = new Set(["integration", "promotion", "claude_workflow"]);
    expect(Object.entries(found).filter(([key]) => !optional.has(key)).every(([, state]) => state === "done")).toBe(true);
  });

  it("says what a partial file lacks", () => {
    const items = setupChecklist({
      check: check({ nom: "Widget", branches: { integration: "integration" } }, [], []),
      releases: null,
      stories: [],
      branches: ["main"],
    });
    expect(states(items)).toEqual({
      config: "done",
      production: "missing",
      environments: "missing",
      ci: "missing",
      release_notes: "missing",
      documentation: "missing",
      requests: "missing",
      epics: "missing",
      working_branches: "missing",
      cycle: "optional",
      promotion: "optional",
      claude_workflow: "optional",
      // Started, so no longer optional.
      integration: "missing",
    });
    expect(items.find((item) => item.key === "production")?.found).toBe("Not declared: La Fabrique uses the default branch, `main`.");
  });

  it("wants at least one released entry, with its date and time", () => {
    const releases = parseReleases(JSON.stringify([{ version: "0.2", date: "2026-10-30", changements: [] }]));
    const item = setupChecklist({
      check: check({ nom: "W", version: { fichier: "notes.json" } }),
      releases,
      stories: [],
      branches: [],
    }).find((entry) => entry.key === "release_notes");
    expect(item?.state).toBe("missing");
    expect(item?.found).toBe("`notes.json`: no entry released yet (none has an `heure`).");
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Setup tab", () => {
  it("shows the checklist with how to set up what is missing", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', ?, ?, '[]', '[]')",
      ).bind(REPO, "1".repeat(40), JSON.stringify({ nom: "Widget" })),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(
        REPO,
        new Date().toISOString(),
      ),
    ]);
    const page = await (await get(`/projects/${REPO}/setup`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('aria-current="page">Setup</a>');
    expect(page).toContain("<strong>1 of 9 done</strong> · 8 missing · integration optional");
    expect(page).toContain("<strong>Release notes in the Fabrique format</strong>");
    expect(page).toContain('href="/guide/fabrique-json#notes-de-version-format-fabrique"');
  });

  it("serves the format documentation, with the anchors the how-to links use", async () => {
    const { cookie } = await signIn("admin-one");
    const page = await (await get("/guide/fabrique-json", cookie)).text();
    expect(page).toContain('id="notes-de-version-format-fabrique"');
    expect(page).toContain('id="champs"');
    expect(page).toContain('id="exemple-lépicerie-extraordinaire"');
    expect(page).toContain('id="le-fichier-fabriquejson"');
    expect(page).toContain('href="/guide/epicerie.fabrique.json"');
    const example = await get("/guide/epicerie.fabrique.json", cookie);
    expect(example.headers.get("content-type")).toContain("application/json");
    expect(((await example.json()) as { nom: string }).nom).toBeTruthy();
    expect((await get("/guide/fabrique-json")).status).toBe(303);
  });

  it("says when the go and Claude can be started from La Fabrique, with examples to read", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', ?, ?, '[]', '[]')",
      ).bind(REPO, "1".repeat(40), JSON.stringify({ nom: "Widget", workflows: { promouvoir: "promouvoir.yml" } })),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(REPO, new Date().toISOString()),
    ]);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/setup`, cookie)).text();
    expect(page).toContain("<code>promouvoir.yml</code>: the super admin gives the go from Production.");
    expect(page).toContain("No <code>workflows.claude</code>: Claude is not launched from La Fabrique.");
    expect(page).toContain('href="/guide/exemples/claude.yml"');
    const example = await get("/guide/exemples/claude.yml", cookie);
    expect(await example.text()).toContain("workflow_dispatch");
  });
});
