import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const OTHER = "acme/other";

async function seed(): Promise<number> {
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(OTHER),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", claude: { budget: 10 } }),
    ),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(OTHER, JSON.stringify({ nom: "Other" })),
  ]);
  const card = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, author, position) VALUES (?, 'feature', 'shaping', 'Week menu', '', 'pe', 1) RETURNING id").bind(REPO).first<{ id: number }>())!.id;
  const call = (await env.DB.prepare("INSERT INTO llm_calls (login, repo, card_id, purpose, cost_micros, outcome, at) VALUES ('pe', ?, ?, 'spec_draft', 40000, 'ok', ?) RETURNING id").bind(REPO, card, at(30)).first<{ id: number }>())!.id;
  const job = (status: string, capability: string, kind: string, extra: { started?: string; finished?: string; call?: number; decision?: string } = {}) =>
    env.DB.prepare(
      "INSERT INTO claude_jobs (repo, card_id, kind, status, request, login, capability, started_at, finished_at, call_id, decision) VALUES (?, ?, ?, ?, '{}', 'pe', ?, ?, ?, ?, ?)",
    ).bind(REPO, card, kind, status, capability, extra.started ?? null, extra.finished ?? null, extra.call ?? null, extra.decision ?? null);
  await env.DB.batch([
    job("running", "spec", "spec_revise", { started: at(2) }),
    job("done", "stories", "spec_split", { finished: at(20) }),
    job("done", "spec", "spec_draft", { finished: at(30), call }),
    job("done", "stories", "spec_split", { finished: at(60), decision: "kept" }),
    // Older than a week: not shown.
    job("failed", "spec", "spec_draft", { finished: new Date(now - 9 * 24 * 3600_000).toISOString() }),
    env.DB.prepare("INSERT INTO runner_runs (run_id, repo, workflow, capability, story, status, url, started_at) VALUES (701, ?, 'claude', 'code', 12, 'in_progress', 'https://github.com/acme/widget/actions/runs/701', ?)").bind(REPO, at(5)),
    env.DB.prepare(
      `INSERT INTO runner_runs (run_id, repo, workflow, capability, story, pull, status, conclusion, url, started_at, finished_at, auth, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, api_cost_micros, real_cost_micros)
       VALUES (702, ?, 'claude', 'update', 12, 34, 'completed', 'success', 'https://github.com/acme/widget/actions/runs/702', ?, ?, 'subscription', 1200, 34000, 2100000, 150000, 8500000, 0)`,
    ).bind(REPO, at(90), at(70)),
    env.DB.prepare("INSERT INTO runner_runs (run_id, repo, workflow, capability, pull, status, conclusion, url, finished_at) VALUES (703, ?, 'revue', 'review', 50, 'completed', 'failure', 'https://github.com/acme/other/actions/runs/703', ?)").bind(OTHER, at(10)),
  ]);
  return card;
}

describe("The Agents page", () => {
  it("shows what runs, what waits for a decision, what ended and each project's month, across projects", async () => {
    const card = await seed();
    const { cookie } = await signIn("admin-one");
    const page = await (await get("/agents", cookie)).text();
    expect(page).toContain('<a href="/agents">Agents</a>');

    const section = (id: string) => page.slice(page.indexOf(`<section id="${id}">`), page.indexOf("</section>", page.indexOf(`<section id="${id}">`)));
    const active = section("active");
    expect(active).toContain("Running and waiting <span class=\"muted small\">(2)</span>");
    expect(active).toMatch(/Write or revise a card(&#39;|')s spec<\/strong> <span class="muted small">La Fabrique<\/span>/);
    expect(active).toContain(`href="/projects/${REPO}/cards/${card}">C${card}</a> Week menu`);
    expect(active).toMatch(/Code a story<\/strong> <span class="muted small">Runner<\/span><br><a [^>]*href="https:\/\/github.com\/acme\/widget\/issues\/12">#12<\/a>/);

    const decisions = section("decisions");
    expect(decisions).toContain("(1)");
    expect(decisions).toContain(`<a class="button small" href="/projects/${REPO}/cards/${card}/stories">Decide</a>`);

    const ended = section("ended");
    expect(ended).toContain("(4)");
    expect(ended).toMatch(/Bring a pull request up to date[\s\S]*?PR #34[\s\S]*?\$8\.50<\/span> <span class="muted small">at API rates, on the subscription<\/span><br><span class="small">151\.2k new in, 2\.1M from cache, 34\.0k out/);
    expect(ended).toContain('href="https://github.com/acme/widget/actions/runs/702#artifacts">transcript</a>');
    expect(ended).toMatch(/Write or revise a card(&#39;|')s spec[\s\S]*?\$0\.04/);
    expect(ended).toMatch(/Review a pull request[\s\S]*?Failed[\s\S]*?No usage reported/);
    expect(ended).not.toContain("Failed</span><br><span class=\"small\">by @pe");

    // Widget: $8.54 of $10 this month, past 80 %.
    expect(section("months")).toMatch(/Widget<\/a> <p class="notice budget" role="status">This month: <span class="mono">\$8\.54<\/span> of <span class="mono">\$10<\/span> \(85 %\)/);

    const filtered = await (await get(`/agents?project=${encodeURIComponent(OTHER)}`, cookie)).text();
    expect(filtered).not.toContain("Week menu");
    expect(filtered).toContain("Review a pull request");
    const byCapability = await (await get("/agents?capability=update", cookie)).text();
    expect(byCapability).toContain("Bring a pull request up to date");
    expect(byCapability).not.toContain("Code a story</strong>");
  });

  it("is for a tech lead and above", async () => {
    await seed();
    await grantRole("tl", "tech_lead");
    const lead = await signIn("tl");
    expect((await get("/agents", lead.cookie)).status).toBe(200);
    await grantRole("pe", "product_engineer");
    const pe = await signIn("pe");
    expect((await get("/agents", pe.cookie)).status).toBe(403);
    expect(await (await get("/projects", pe.cookie)).text()).not.toContain('href="/agents"');
  });
});
