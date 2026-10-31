import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateFabriqueConfig } from "../src/fabrique-config";
import { cycleRules, missingForReady, stageOf } from "../src/lifecycle";
import { acceptanceCriteria, type Story } from "../src/stories";
import { get, signIn } from "./helpers";

function story(extra: Partial<Story> = {}): Story {
  return {
    number: 7,
    title: "Story",
    state: "open",
    url: "https://github.com/acme/widget/issues/7",
    author: null,
    labels: [],
    parent: 1,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    pullRequests: [],
    branches: [],
    criteria: [{ text: "It works", done: false }],
    ...extra,
  };
}

const DEFAULT = cycleRules(null);

describe("acceptanceCriteria", () => {
  it("reads the list under the heading, in English or in French, with checked items", () => {
    const body = "## Context\n- not this\n\n## Acceptance criteria\n- [ ] One\n- [x] Two\n* Three\n\n## Notes\n- not this either";
    expect(acceptanceCriteria(body)).toEqual([
      { text: "One", done: false },
      { text: "Two", done: true },
      { text: "Three", done: false },
    ]);
    expect(acceptanceCriteria("### Critères d’acceptation\n- [ ] Un")).toEqual([{ text: "Un", done: false }]);
    expect(acceptanceCriteria("No heading\n- [ ] item")).toEqual([]);
    expect(acceptanceCriteria(null)).toEqual([]);
  });
});

describe("stageOf", () => {
  it("is Ready with criteria and an epic, Backlog otherwise, saying what lacks", () => {
    expect(stageOf(story(), DEFAULT, new Set())).toBe("ready");
    const bare = story({ criteria: [], parent: null });
    expect(stageOf(bare, DEFAULT, new Set())).toBe("backlog");
    expect(missingForReady(bare, DEFAULT)).toEqual(["no acceptance criteria", "not in an epic nor a card"]);
    // A story made from a card is grouped by it, as by an epic.
    expect(missingForReady(bare, { ...DEFAULT, inCard: new Set([bare.number]) })).toEqual(["no acceptance criteria"]);
    // Snapshots written before criteria were read.
    const old = story();
    delete old.criteria;
    expect(stageOf(old, DEFAULT, new Set())).toBe("backlog");
  });

  it("follows the work: branch or open PR, on int, closed", () => {
    expect(stageOf(story({ branches: ["feature/7-x"] }), DEFAULT, new Set())).toBe("in_dev");
    expect(stageOf(story({ pullRequests: [{ number: 9, url: "", state: "open" }] }), DEFAULT, new Set())).toBe("in_dev");
    expect(stageOf(story({ pullRequests: [{ number: 9, url: "", state: "closed" }] }), DEFAULT, new Set())).toBe("ready");
    expect(stageOf(story({ branches: ["feature/7-x"] }), DEFAULT, new Set([7]))).toBe("on_int");
    expect(stageOf(story({ state: "closed" }), DEFAULT, new Set([7]))).toBe("on_int");
    expect(stageOf(story({ state: "closed" }), DEFAULT, new Set())).toBe("done");
    expect(stageOf(story({ subTotal: 3 }), DEFAULT, new Set())).toBeNull();
  });

  it("applies the project's own Definition of Ready and priorities", () => {
    const rules = cycleRules({
      nom: "W",
      cycle: { pret: ["priorite", "etiquette_prete"], priorites: ["P1", "P2"] },
      demandes: { etiquettes: { prete: "ready-for-claude" } },
    });
    expect(missingForReady(story({ criteria: [], parent: null }), rules)).toEqual(["no priority", "not labelled ready"]);
    expect(stageOf(story({ labels: ["P2", "ready-for-claude"] }), rules, new Set())).toBe("ready");
  });
});

describe("cycle in .fabrique.json", () => {
  const tree = { files: new Set<string>(), folders: new Set<string>(), complete: true };
  it("accepts known checks and priority labels", () => {
    const { config, errors } = validateFabriqueConfig(
      JSON.stringify({ nom: "W", cycle: { pret: ["criteres", "priorite"], priorites: ["P1", "P2"] } }),
      tree,
    );
    expect(errors).toEqual([]);
    expect(config?.cycle).toEqual({ pret: ["criteres", "priorite"], priorites: ["P1", "P2"] });
  });

  it("names the checks it knows when one is not", () => {
    const { errors } = validateFabriqueConfig(JSON.stringify({ nom: "W", cycle: { pret: ["estimee"], priorites: "P1" } }), tree);
    expect(errors).toEqual([
      "`cycle.pret` must be a list among `criteres`, `epique`, `priorite`, `etiquette_prete`.",
      "`cycle.priorites` must be a list of GitHub labels, highest priority first.",
    ]);
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Stories board stages", () => {
  it("shows each story's stage, what a story in the backlog lacks, and filters by stage", async () => {
    const REPO = "acme/widget";
    const stories = [
      story({ number: 1, title: "Epic", parent: null, subTotal: 3, criteria: [] }),
      story({ number: 2, title: "Ready one" }),
      story({ number: 3, title: "Bare one", criteria: [] }),
      story({ number: 4, title: "Being built", branches: ["feature/4-x"] }),
      story({ number: 5, title: "Merged on int", state: "closed" }),
    ];
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
      ).bind(REPO, JSON.stringify({ nom: "Widget" })),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, ?)").bind(
        REPO,
        JSON.stringify(stories),
        new Date().toISOString(),
      ),
      env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, ?)").bind(
        REPO,
        JSON.stringify({ groups: [{ issues: [5] }] }),
        new Date().toISOString(),
      ),
    ]);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/stories`, cookie)).text();
    const row = (title: string) => page.slice(page.indexOf(title), page.indexOf("</tr>", page.indexOf(title)));
    expect(row("Ready one")).toContain('<span class="pill stage-ready ok">Ready</span>');
    expect(row("Bare one")).toContain('<span class="pill stage-backlog">Backlog</span><br /><span class="muted small">no acceptance criteria</span>');
    expect(row("Being built")).toContain("In development");
    expect(row("Merged on int")).toContain("On int");

    const filtered = await (await get(`/projects/${REPO}/stories?stage=in_dev`, cookie)).text();
    expect(filtered).toContain("Being built");
    expect(filtered).not.toContain("Ready one");
  });
});
