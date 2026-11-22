import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { availability, CAPABILITIES, ENDINGS, PLACES } from "../src/capabilities";
import { JOB_KINDS } from "../src/jobs";
import type { Project } from "../src/projects";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";

// La Fabrique's own decisions: a planned capability names one of them.
const DECISIONS = Object.keys(
  (import.meta as ImportMeta & { glob: (pattern: string, options: Record<string, unknown>) => Record<string, unknown> }).glob("../docs/decisions/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

// Every purpose La Fabrique's own calls are counted under (llm_calls), but
// the key check, which is not a capability.
const PURPOSES = ["spec_draft", "spec_revise", "epic_draft", "epic_revise", "spec_split", "spec_tests", "epic_features", "epic_review"];

describe("The catalogue of capabilities", () => {
  it("covers every background job and every purpose a call of La Fabrique is counted under, once", () => {
    for (const kind of JOB_KINDS) expect(CAPABILITIES.filter((entry) => entry.jobs?.includes(kind)).length, kind).toBe(1);
    for (const purpose of PURPOSES) expect(CAPABILITIES.filter((entry) => entry.purposes?.includes(purpose)).length, purpose).toBe(1);
  });

  it("says, for each capability, what it does, where it runs, how it ends, what it writes and where it is launched", () => {
    const ids = CAPABILITIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CAPABILITIES) {
      expect(entry.id, entry.id).toMatch(/^[a-z][a-z_]*$/);
      expect(entry.label && entry.does && entry.from, entry.id).toBeTruthy();
      expect(PLACES, entry.id).toContain(entry.place);
      expect(ENDINGS, entry.id).toContain(entry.ending);
      expect(entry.writes.answer.length + entry.writes.decision.length, entry.id).toBeGreaterThan(0);
      // A decision ends with what is written once decided.
      if (entry.ending === "decision") expect(entry.writes.decision.length, entry.id).toBeGreaterThan(0);
      // What writes a project's code runs in the project (principle 3).
      if (entry.place === "runner") expect(entry.workflow, entry.id).toBeTruthy();
      if (entry.planned) expect(DECISIONS.some((path) => path.includes(`/${entry.planned}-`)), entry.id).toBe(true);
    }
  });

  it("says whether a project can run each one now, and why not", () => {
    const project = { repo: REPO, check: { config: { workflows: { claude: "claude.yml" } } } } as unknown as Project;
    const find = (id: string) => CAPABILITIES.find((entry) => entry.id === id)!;
    expect(availability(find("spec"), project, { ANTHROPIC_API_KEY: "k" })).toEqual({ ok: true, reason: "Ready" });
    expect(availability(find("spec"), project, { ANTHROPIC_API_KEY: "" })).toEqual({ ok: false, reason: "La Fabrique has no Anthropic key" });
    expect(availability(find("code"), project, {})).toEqual({ ok: true, reason: "Workflow claude.yml" });
    expect(availability(find("review"), project, {})).toEqual({ ok: false, reason: "No `workflows.revue` in .fabrique.json" });
    expect(availability(find("story_loop"), project, {})).toEqual({ ok: false, reason: "Planned (ADR 0003)" });
  });
});

describe("The Capabilities tab", () => {
  it("lists the capabilities by where they run, with what each has cost on the project", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, committed_at, doc_pages) VALUES (?, 'main', 'c0ffee1', ?, '[]', '2026-11-02T08:00:00Z', '[]')",
      ).bind(REPO, JSON.stringify({ nom: "Widget", workflows: { claude: "claude.yml" } })),
      env.DB.prepare("INSERT INTO llm_calls (login, repo, purpose, cost_micros, outcome, at) VALUES ('pe', ?, 'spec_draft', 20000, 'ok', '2026-11-20T10:00:00Z')").bind(REPO),
      env.DB.prepare("INSERT INTO llm_calls (login, repo, purpose, cost_micros, outcome, at) VALUES ('pe', ?, 'spec_revise', 10000, 'ok', '2026-11-21T10:00:00Z')").bind(REPO),
      // An error that never reached Claude is not counted; another project is not either.
      env.DB.prepare("INSERT INTO llm_calls (login, repo, purpose, cost_micros, outcome) VALUES ('pe', ?, 'spec_draft', NULL, 'error')").bind(REPO),
      env.DB.prepare("INSERT INTO llm_calls (login, repo, purpose, cost_micros, outcome) VALUES ('pe', 'acme/other', 'spec_split', 5000, 'ok')"),
    ]);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/capabilities`, cookie)).text();
    expect(page).toContain('aria-current="page">Capabilities</a>');
    expect(page).toContain("<h2>In La Fabrique, with its own key</h2>");
    expect(page).toMatch(/<h2>In the project(&#39;|')s runner, with its secrets<\/h2>/);
    // The spec: two calls, $0.03 in all, $0.015 each, the last one's day.
    expect(page).toMatch(/<tr id="spec">[\s\S]*?<span class="mono">2<\/span> calls · <span class="mono">\$0\.03<\/span>[\s\S]*?last on 2026-11-21/);
    expect(page).toMatch(/<tr id="stories">[\s\S]*?Not used yet/);
    expect(page).toMatch(/<tr id="code">[\s\S]*?Workflow claude\.yml/);
    expect(page).toMatch(/<tr id="review">[\s\S]*?No `workflows\.revue` in \.fabrique\.json/);
    expect(page).toMatch(/<tr id="story_loop" class="planned">[\s\S]*?Planned \(ADR 0003\)/);
    expect(page).toMatch(/<tr id="stories">[\s\S]*?Waits for a decision[\s\S]*?Once decided: [\s\S]*?Product Engineer and above/);
    expect(page).toMatch(/<tr id="code">[\s\S]*?Tech lead and above/);
  });
});
