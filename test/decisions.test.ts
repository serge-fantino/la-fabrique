import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { indexRows, parseDecision, STATUS_LABELS } from "../src/decisions";
import { validateFabriqueConfig } from "../src/fabrique-config";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const SHA = "c0ffee1";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

// La Fabrique's own decisions, as they are in its repository.
const OWN = (import.meta as ImportMeta & { glob: (pattern: string, options: Record<string, unknown>) => Record<string, unknown> }).glob("../docs/decisions/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

const github = () => fetchMock.get("https://api.github.com");

const ACCEPTED = `# 0033. A large epic is built on its own branch

- Status: Accepted (validated by alice on 2026-11-20, by [a comment on #296](https://github.com/acme/widget/pull/296#issuecomment-1)), amended by 0054
- Date: 2026-11-02
- Deciders: alice, @bob

## Context

Epic #136 and card C12 need it. See [ADR 0024](0024-a-release.md).

## Decision

Build it on \`epic/<id>\`.
`;

const PROPOSED = `# 0054. The owner validates a decision by a comment

- Status: Proposed
- Date: 2026-11-19
- Deciders: alice

## Context

It amends [0033](0033-a-large-epic.md).
`;

const NYGARD = `# 7. Use PostgreSQL

Date: 2026-01-04

## Status

Superseded by [8. Use D1](0008-use-d1.md)

## Context

Nothing else.
`;

describe("A decision file", () => {
  it("is read with its number, title, status, date, deciders, what it serves and the decisions it names", () => {
    expect(parseDecision("docs/adr/0033-a-large-epic.md", ACCEPTED)).toEqual({
      number: "0033",
      path: "docs/adr/0033-a-large-epic.md",
      title: "A large epic is built on its own branch",
      status: "accepted",
      statusText: "Accepted (validated by alice on 2026-11-20, by [a comment on #296](https://github.com/acme/widget/pull/296#issuecomment-1)), amended by 0054",
      date: "2026-11-02",
      deciders: ["alice", "bob"],
      issues: [136, 296],
      cards: [12],
      mentions: ["0024", "0054"],
    });
    expect(parseDecision("docs/adr/0054-the-owner.md", PROPOSED)).toMatchObject({ status: "proposed", mentions: ["0033"], deciders: ["alice"] });
  });

  it("is read in Nygard's format too, a status section and a short number", () => {
    expect(parseDecision("doc/adr/0007-use-postgresql.md", NYGARD)).toMatchObject({ number: "0007", title: "Use PostgreSQL", status: "superseded", date: "2026-01-04", deciders: [], mentions: ["0008"] });
  });

  it("is a decision even without a title or a status; the template and other files are not", () => {
    expect(parseDecision("docs/adr/0009-no-title.md", "Just text.")).toMatchObject({ number: "0009", title: "no title", status: "unknown" });
    expect(parseDecision("docs/adr/0000-template.md", ACCEPTED)).toBeNull();
    expect(parseDecision("docs/adr/README.md", ACCEPTED)).toBeNull();
    expect(parseDecision("docs/adr/open-decisions.md", ACCEPTED)).toBeNull();
    expect(STATUS_LABELS.unknown).toBe("No status");
  });

  it("La Fabrique's own decisions each have a title, a status, a date and deciders, and the index lists each one with its status", () => {
    const index = Object.entries(OWN).find(([path]) => path.endsWith("/README.md"))?.[1] ?? "";
    const rows = indexRows(index);
    const decisions = Object.entries(OWN)
      .map(([path, text]) => parseDecision(path.replace(/^\.\.\//, ""), text))
      .filter((decision) => decision !== null);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    for (const decision of decisions) {
      expect(decision.status, decision.path).not.toBe("unknown");
      expect(decision.date, decision.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(decision.deciders.length, decision.path).toBeGreaterThan(0);
      const row = rows.get(decision.number);
      expect(row?.file, `${decision.path} is not in docs/decisions/README.md`).toBe(decision.path.slice("docs/decisions/".length));
      expect(row?.status.toLowerCase(), decision.path).toBe(decision.status);
    }
    expect(rows.size).toBe(decisions.length);
  });

  it("is declared by .fabrique.json > decisions, docs/decisions by default, a folder that exists", () => {
    const tree = (folders: string[]) => ({ files: new Set([".fabrique.json"]), folders: new Set(folders), complete: true });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", decisions: {} }), tree(["docs/decisions"])).config?.decisions).toEqual({ dossier: "docs/decisions" });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", decisions: { dossier: "./docs/adr/" } }), tree(["docs/adr"])).config?.decisions).toEqual({ dossier: "docs/adr" });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", decisions: { dossier: "nowhere" } }), tree([])).errors).toEqual(["`decisions.dossier`: `nowhere` does not exist."]);
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", decisions: "docs" }), tree([])).errors[0]).toMatch(/^`decisions` must be an object/);
  });
});

async function seed(config: Record<string, unknown>): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, committed_at, doc_pages) VALUES (?, 'main', ?, ?, '[]', '2026-11-02T08:00:00Z', '[]')",
    ).bind(REPO, SHA, JSON.stringify({ nom: "Widget", ...config })),
  ]);
}

const file = (path: string, content: string) => github().intercept({ path: `/repos/${REPO}/contents/${path}?ref=${SHA}` }).reply(200, content);

// The tree, then one token for every decision file: two tokens in all.
function mockRepository(folder = "docs/adr"): void {
  github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(2);
  const tree = ["docs", folder, `${folder}/README.md`, `${folder}/0000-template.md`, `${folder}/0033-a-large-epic.md`, `${folder}/0054-the-owner.md`, `${folder}/open-decisions.md`, `${folder}/old`, `${folder}/old/0001-x.md`].map((path) => ({
    path,
    type: path.endsWith(".md") ? "blob" : "tree",
  }));
  github().intercept({ path: `/repos/${REPO}/git/trees/${SHA}?recursive=1` }).reply(200, JSON.stringify({ tree, truncated: false }), JSON_HEADERS);
  file(`${folder}/0033-a-large-epic.md`, ACCEPTED);
  file(`${folder}/0054-the-owner.md`, PROPOSED);
}

describe("The Decisions tab", () => {
  it("lists the decisions found in a usual folder, newest first, says which wait for a decider, and filters by status", async () => {
    await seed({});
    mockRepository();
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/decisions`, cookie)).text();
    expect(page).toContain('aria-current="page">Decisions</a>');
    expect(page).toContain("<code>docs/adr/</code>, found there");
    expect(page.indexOf("0054")).toBeLessThan(page.indexOf("0033"));
    expect(page).toMatch(/<a href="\/projects\/acme\/widget\/decisions\/0033">A large epic is built on its own branch<\/a>/);
    expect(page).toContain('<span class="pill warn">Proposed</span>');
    expect(page).toContain("One decision is proposed and waits for a decider");
    expect(page).toMatch(/href="https:\/\/github.com\/alice">@alice<\/a>, <a [^>]*href="https:\/\/github.com\/bob">@bob<\/a>/);
    expect(page).toContain('href="/projects/acme/widget/cards/12">C12</a>');
    expect(page).toContain('href="https://github.com/acme/widget/issues/136">#136</a>');
    expect(page).toContain('href="/projects/acme/widget/decisions/open">Open decisions</a>');
    expect(page).not.toContain("template");
    // Cached by commit: no second read of the repository.
    const proposed = await (await get(`/projects/${REPO}/decisions?status=proposed`, cookie)).text();
    expect(proposed).toContain("The owner validates a decision by a comment");
    expect(proposed).not.toContain("A large epic is built");
  });

  it("shows a decision: its facts, its text with links to the other decisions, and the decisions that name it", async () => {
    await seed({ decisions: { dossier: "docs/adr" } });
    mockRepository();
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    file("docs/adr/0033-a-large-epic.md", ACCEPTED);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/decisions/33`, cookie)).text();
    expect(page).toContain("<dt>Deciders</dt>");
    expect(page).toContain("amended by 0054");
    expect(page).toContain("<h2>Named by</h2>");
    expect(page).toMatch(/href="\/projects\/acme\/widget\/decisions\/0054"><span class="mono">0054<\/span> The owner validates/);
    // A link to a decision the folder does not hold opens on GitHub.
    expect(page).toContain(`https://github.com/${REPO}/blob/${SHA}/docs/adr/0024-a-release.md`);
    expect((await get(`/projects/${REPO}/decisions/99`, cookie)).status).toBe(404);
  });

  it("says how to start when the project has no decisions", async () => {
    await seed({});
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/git/trees/${SHA}?recursive=1` }).reply(200, JSON.stringify({ tree: [{ path: "src", type: "tree" }], truncated: false }), JSON_HEADERS);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/decisions`, cookie)).text();
    expect(page).toContain("This project has no decisions yet.");
    expect(page).toContain('href="/guide/fabrique-json#décisions"');
  });
});
