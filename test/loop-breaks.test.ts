import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { openBreakOf } from "../src/loop-breaks";
import { storyLoop } from "../src/loop-events";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const PAGE = `/projects/${REPO}/sprint/stories/12`;

function story(number: number, title: string): Story {
  return {
    number, title, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
    subTotal: 0, subCompleted: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null,
    pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }],
  };
}

// Story #12, Claude's run 9001 on it, stopped by a break of the given kind.
async function seed(kind: string): Promise<number> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", workflows: { claude: "claude.yml" }, claude: { plafond: 2 } }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify([story(12, "Week menu")])),
    env.DB.prepare("INSERT INTO loop_events (repo, story, run_id, phase) VALUES (?, 12, 9001, 'plan')").bind(REPO),
  ]);
  const row = await env.DB.prepare("INSERT INTO loop_events (repo, story, run_id, phase, break_kind, break_reason) VALUES (?, 12, 9001, 'break', ?, 'Criteria 2 and 3 contradict each other.') RETURNING id")
    .bind(REPO, kind)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

function github() {
  return fetchMock.get("https://api.github.com");
}

// What the story's page and a launch read on GitHub.
function githubReads(): void {
  github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).persist();
  github().intercept({ path: `/repos/${REPO}/actions/workflows/claude.yml/runs?per_page=30` }).reply(200, JSON.stringify({ workflow_runs: [] }), JSON_HEADERS).persist();
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("A break of the loop", () => {
  it("is open while it is the story's last event and no one answered it", async () => {
    await seed("spec");
    expect(openBreakOf(await storyLoop(env.DB, REPO, 12))).toMatchObject({ breakKind: "spec", answeredAt: null });
    await env.DB.prepare("INSERT INTO loop_events (repo, story, run_id, phase) VALUES (?, 12, 9002, 'plan')").bind(REPO).run();
    expect(openBreakOf(await storyLoop(env.DB, REPO, 12))).toBeNull();
  });

  it("goes to the role that unblocks it: the form for them, who it waits for to the others", async () => {
    await seed("spec");
    githubReads();
    await grantRole("pe", "product_engineer");
    await grantRole("tester", "tester");
    const forPe = await (await get(PAGE, (await signIn("pe")).cookie)).text();
    expect(forPe).toContain('<h2 id="stop">Claude stopped <span class="pill alert small">A doubt on the spec</span></h2>');
    expect(forPe).toContain("Criteria 2 and 3 contradict each other.");
    expect(forPe).toContain('<input type="hidden" name="action" value="answer_break" />');
    expect(forPe).toContain(">Answer and relaunch Claude</button>");
    const forTester = await (await get(PAGE, (await signIn("tester")).cookie)).text();
    expect(forTester).toContain("Waits for a Product Engineer and above.");
    expect(forTester).not.toContain('value="answer_break"');
  });

  it("is answered on the issue in the person's name, in the log, and Claude is relaunched on the story", async () => {
    const event = await seed("spec");
    githubReads();
    await grantRole("pe", "product_engineer");
    let comment = "";
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments`, body: (body) => ((comment ||= body), true) })
      .reply(201, JSON.stringify({ html_url: `https://github.com/${REPO}/issues/12#issuecomment-1` }), JSON_HEADERS);
    github().intercept({ method: "POST", path: `/repos/${REPO}/actions/workflows/claude.yml/dispatches` }).reply(204, "");
    github().intercept({ method: "POST", path: `/repos/${REPO}/issues/12/comments` }).reply(201, JSON.stringify({ html_url: "x" }), JSON_HEADERS);
    const { cookie, csrf } = await signIn("pe");
    const response = await post(PAGE, { csrf, action: "answer_break", event: String(event), answer: "Criterion 3 wins: the week starts on Monday.", relaunch: "1" }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PAGE}?answered=relaunched`);
    const sent = JSON.parse(comment) as { body: string };
    // In the project's language (French unless it says otherwise).
    expect(sent.body).toContain("**Réponse à l'arrêt de Claude** (un doute sur la spec), de @pe depuis La Fabrique extraordinaire");
    expect(sent.body).toContain("> Claude s'était arrêté : Criteria 2 and 3 contradict each other.");
    expect(sent.body).toContain("Criterion 3 wins: the week starts on Monday.");
    expect(await env.DB.prepare("SELECT answered_by FROM loop_events WHERE id = ?").bind(event).first()).toEqual({ answered_by: "pe" });
    const logged = (await logActions()).find((entry) => entry.action === "loop_break_answered");
    expect(logged).toMatchObject({ actor: "pe" });
    expect(JSON.parse(logged?.details ?? "{}")).toMatchObject({ kind: "spec", run: 9001, relaunched: true, comment: `https://github.com/${REPO}/issues/12#issuecomment-1` });
    expect((await logActions()).some((entry) => entry.action === "claude_launched")).toBe(true);

    // Answered once: the stop is closed, a second answer is refused.
    const page = await (await get(`${PAGE}?answered=relaunched`, cookie)).text();
    expect(page).toContain("Your answer is on the issue, and Claude is relaunched on the story.");
    expect(page).not.toContain('<h2 id="stop">');
    expect(page).toContain("Answered by @pe on");
    const again = await post(PAGE, { csrf, action: "answer_break", event: String(event), answer: "Again", relaunch: "0" }, cookie);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("@pe already answered this stop.");
  });

  it("is refused to a role it does not go to, and needs an answer", async () => {
    const event = await seed("tests");
    githubReads();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const refused = await post(PAGE, { csrf, action: "answer_break", event: String(event), answer: "Go on.", relaunch: "1" }, cookie);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("This stop is for a tech lead and above.");
    await grantRole("lead", "tech_lead");
    const lead = await signIn("lead");
    const empty = await post(PAGE, { csrf: lead.csrf, action: "answer_break", event: String(event), answer: "  ", relaunch: "0" }, lead.cookie);
    expect(empty.status).toBe(422);
    expect(await env.DB.prepare("SELECT answered_at FROM loop_events WHERE id = ?").bind(event).first()).toEqual({ answered_at: null });
  });

  it("waits in Agents for the person who answers it", async () => {
    await seed("decision");
    const { cookie } = await signIn("admin-one");
    const agents = await (await get("/agents", cookie)).text();
    expect(agents).toContain("Claude stopped, waiting for a person <span class=\"muted small\">(1)</span>");
    expect(agents).toContain('<span class="pill alert small">A decision to take</span>');
    expect(agents).toContain("its deciders: a Product Engineer and above");
    expect(agents).toContain(`href="/projects/${REPO}/sprint/stories/12#stop">Answer</a>`);
  });
});
