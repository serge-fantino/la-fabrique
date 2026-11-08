import { createExecutionContext, createMessageBatch, env, fetchMock, getQueueResult, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import example from "../docs/exemples/epicerie.fabrique.json";
import { allowance, costMicros, usesOf } from "../src/llm";
import type Anthropic from "@anthropic-ai/sdk";
import worker from "../src/index";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { "content-type": "application/json" };
const CONFIG = { nom: "Widget", langue: "fr", demandes: example.demandes };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[\"CLAUDE.md\"]')",
    ).bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO doc_cache (repo, commit_sha, path, markdown) VALUES (?, 'abc', 'CLAUDE.md', ?)").bind(
      REPO,
      "# Widget\n\nPrinciple: never sell anything for losing weight.",
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([{ number: 7, title: "Existing basket story", state: "open", labels: [], url: "", author: null, parent: null, subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [] }]),
    ),
  ]);
}

const SECTIONS = {
  contexte: "On refait souvent les mêmes courses.",
  besoin: "Reprendre le panier de la semaine dernière en un geste.",
  criteres: "- [ ] Quand je touche « Reprendre », je vois les articles de la semaine dernière dans la liste.",
  ecrans: "",
  donnees_personnelles: "Aucune.",
  quoi_de_neuf: "Reprenez vos courses de la semaine dernière en un geste.",
  questions: "",
};

function claudeReply(sent: { body?: Record<string, unknown> }, answer: unknown, extra: Record<string, unknown> = {}): void {
  fetchMock
    .get("https://api.anthropic.com")
    .intercept({ method: "POST", path: (path) => path.startsWith("/v1/messages") })
    .reply((options) => {
      sent.body = JSON.parse(String(options.body)) as Record<string, unknown>;
      return {
        statusCode: 200,
        data: JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
          ...extra,
        }),
        responseOptions: { headers: JSON_HEADERS },
      };
    });
}

async function writerWithCard(): Promise<{ cookie: string; csrf: string; id: number }> {
  await seed();
  await grantRole("pe", "product_engineer");
  const session = await signIn("pe");
  const response = await post(`/projects/${REPO}/cards`, { csrf: session.csrf, title: "Quick reorder", body: "Reorder last week's basket. {segment: pro}", kind: "feature", status: "shaping" }, session.cookie);
  const id = Number(/cards\/(\d+)/.exec(response.headers.get("location") ?? "")?.[1]);
  return { ...session, id };
}

describe("What a call costs", () => {
  it("counts input, output, cache reads and cache writes at the model's price", () => {
    // 1000 × $4 + 2000 × $20 + 5000 × $0.20 + 1000 × $5 (a 5-minute cache write), per million tokens.
    expect(costMicros([{ model: "claude-opus-5-5", input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 1000 }])).toBe(50_000);
    expect(costMicros([{ model: "claude-unknown", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }])).toBeNull();
  });

  it("counts each model of a fallback at its own price", () => {
    const message = {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    } as unknown as Anthropic.Beta.BetaMessage;
    const uses = usesOf(message, "claude-opus-5-5");
    expect(uses.map((use) => use.model)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
    expect(costMicros(uses)).toBe(100 * 4 + 10 * 20 + 100 * 5 + 1000 * 25);
  });

  it("refuses without a key, to a tester, past the daily calls and past the monthly budget", async () => {
    expect(await allowance({ ...env, ANTHROPIC_API_KEY: "" }, "super_admin", "a")).toMatchObject({ ok: false, reason: expect.stringContaining("no API key") });
    expect(await allowance(env, "tester", "a")).toMatchObject({ ok: false, reason: "Your role does not let you use Claude." });
    expect(await allowance(env, "product_engineer", "a")).toEqual({ ok: true });
    const insert = (login: string, cost: number) =>
      env.DB.prepare("INSERT INTO llm_calls (login, purpose, cost_micros, outcome) VALUES (?, 'spec_draft', ?, 'ok')").bind(login, cost);
    await env.DB.batch([insert("a", 1), insert("a", 1), insert("a", 1)]);
    expect(await allowance(env, "product_engineer", "a")).toMatchObject({ ok: false, reason: expect.stringContaining("today's 3 calls") });
    await insert("b", 1_000_000).run();
    expect(await allowance(env, "product_engineer", "c")).toMatchObject({ ok: false, reason: expect.stringContaining("this month's Claude budget ($1.00)") });
  });
});

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return String(body);
}

// Claude's answer as the API streams it: a summary of its thinking, then
// the JSON in two pieces.
function claudeStream(
  sent: { body?: Record<string, unknown> },
  answer: unknown,
  options: { stopReason?: string; status?: number } = {},
): void {
  fetchMock
    .get("https://api.anthropic.com")
    .intercept({ method: "POST", path: (path) => path.startsWith("/v1/messages") })
    .reply((request) => {
      sent.body = JSON.parse(bodyText(request.body)) as Record<string, unknown>;
      if (options.status) {
        return { statusCode: options.status, data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), responseOptions: { headers: JSON_HEADERS } };
      }
      const text = JSON.stringify(answer);
      const half = Math.floor(text.length / 2);
      const events: [string, unknown][] = [
        ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The card is about reordering. Who is it for?" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, half) } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(half) } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: options.stopReason ?? "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 2000 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return {
        statusCode: 200,
        // ASCII only (escaped): the mock counts characters, not bytes.
        data: events
          .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n\n`)
          .join(""),
        responseOptions: { headers: { "content-type": "text/event-stream" } },
      };
    });
}

// What the queue's consumer does: run the waiting jobs, as Cloudflare would.
async function runQueue(): Promise<{ retried: number; acked: number }> {
  const { results } = await env.DB.prepare("SELECT id FROM claude_jobs WHERE status IN ('queued', 'running') ORDER BY id").all<{ id: number }>();
  const batch = createMessageBatch<{ job: number }>(
    "la-fabrique-claude",
    results.map((row) => ({ id: `m${row.id}`, timestamp: new Date(), attempts: 1, body: { job: row.id } })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  return { retried: result.retryMessages.length, acked: result.explicitAcks.length };
}

async function specOf(id: number): Promise<Record<string, unknown>> {
  return JSON.parse((await env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(id).first<{ data: string | null }>())?.data ?? "{}").spec ?? {};
}

async function statusOf(id: number): Promise<string | undefined> {
  return (await env.DB.prepare("SELECT status FROM cards WHERE id = ?").bind(id).first<{ status: string }>())?.status;
}

describe("A card's spec with Claude, in the background", () => {
  it("moves a draft card to Shaping when Claude is asked, and says why in the log", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "status", status: "draft" }, cookie);
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    expect(await statusOf(id)).toBe("shaping");
    const moved = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_moved' ORDER BY id DESC").first<{ details: string }>();
    expect(JSON.parse(moved?.details ?? "{}")).toMatchObject({ changes: [{ dimension: "status", from: "draft", to: "shaping" }], reason: "Claude asked" });
    claudeStream({}, { sections: SECTIONS, questions: ["Q ?"], enough: false, note: "v1" });
    await runQueue();
    expect(await statusOf(id)).toBe("shaping");
  });

  it("saves the request at once, then writes the spec from the queue, with its log and its cost", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    const response = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft", instruction: "Pensez au téléphone." }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}#claude-job`);
    expect(await env.DB.prepare("SELECT kind, status, login FROM claude_jobs").first()).toEqual({ kind: "spec_draft", status: "queued", login: "pe" });

    // While it waits: the widget, its live connection, no form to send again.
    const waiting = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(waiting).toContain('<strong data-job-label>Waiting for Claude</strong>');
    expect(waiting).toContain(`data-live="/projects/${REPO}/cards/${id}/live"`);
    expect(waiting).toContain("Pensez au téléphone.");
    expect(waiting).not.toContain('value="spec_draft"');
    const board = await (await get(`/projects/${REPO}/board?by=status`, cookie)).text();
    expect(board).toContain('<span class="pill warn">Claude working</span>');

    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, { sections: SECTIONS, questions: ["Pour combien de semaines en arrière ?"], enough: false, note: "Première version." });
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });

    // What Claude received: the project's principles (cached), the card, the stories, the sections.
    const body = sent.body ?? {};
    expect(body["model"]).toBe("claude-opus-5-5");
    expect(body["stream"]).toBe(true);
    expect(body["fallbacks"]).toBe("default");
    expect(body["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    const system = (body["system"] as { text: string; cache_control: unknown }[])[0];
    expect(system?.cache_control).toEqual({ type: "ephemeral" });
    expect(system?.text).toContain("never sell anything for losing weight");
    expect(system?.text).toContain('"criteres": Critères d\'acceptation (required)');
    expect(system?.text).toContain("Write in French.");
    const user = (body["messages"] as { content: string }[])[0]?.content ?? "";
    expect(user).toContain("Quick reorder");
    expect(user).toContain("#7 Existing basket story");
    expect(user).toContain("Pensez au téléphone.");

    expect(await specOf(id)).toMatchObject({ source: "claude", questions: ["Pour combien de semaines en arrière ?"], answers: { besoin: SECTIONS.besoin }, rounds: 1 });
    expect(await env.DB.prepare("SELECT status FROM claude_jobs").first()).toEqual({ status: "done" });
    const call = await env.DB.prepare("SELECT login, repo, card_id, purpose, input_tokens, cost_micros, outcome FROM llm_calls").first();
    expect(call).toEqual({ login: "pe", repo: REPO, card_id: id, purpose: "spec_draft", input_tokens: 1000, cost_micros: 50_000, outcome: "ok" });
    const log = (await env.DB.prepare("SELECT text FROM claude_job_events ORDER BY id").all<{ text: string }>()).results.map((row) => row.text);
    expect(log).toEqual([
      "Asked by @pe.",
      "Claude starts.",
      "Reads CLAUDE.md (0k characters), 0 other cards, 1 open story.",
      "Thinks: Who is it for?",
      "Writes: Contexte.",
      "Writes: Besoin.",
      "Writes: Critères d'acceptation.",
      "Writes: Écrans concernés.",
      "Writes: Données personnelles.",
      "Writes: Texte « Quoi de neuf ».",
      "Writes: Questions ouvertes.",
      "Done: 1 question for you. Cost $0.05.",
    ]);

    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("<h3>Besoin</h3>");
    expect(page).not.toContain("data-live=");
    expect(page).toContain('<label for="answer_0">Pour combien de semaines en arrière ?</label>');
    expect(page).toContain('value="spec_enough" formnovalidate>Enough questions</button>');
    expect(page).toContain("1 call · $0.05");
  });

  it("sends the answers with their questions, shows them while Claude works, keeps them, and does not ask again", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    claudeStream({}, { sections: SECTIONS, questions: ["Combien de semaines ?", "Sur le site aussi ?"], enough: false, note: "v1" });
    await runQueue();

    await post(
      `/projects/${REPO}/cards/${id}`,
      { csrf, action: "spec_answer", question_0: "Combien de semaines ?", answer_0: "Quatre.", question_1: "Sur le site aussi ?", answer_1: "", instruction: "Pensez au mobile." },
      cookie,
    );
    // Sent: read-only while Claude works, even after leaving the page.
    const waiting = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(waiting).toContain("<dt>Combien de semaines ?</dt><dd>Quatre.</dd>");
    expect(waiting).not.toContain('name="answer_0"');

    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, { sections: SECTIONS, questions: ["Et les produits retirés ?"], enough: false, note: "v2" });
    await runQueue();
    const user = ((sent.body?.["messages"] as { content: string }[])[0]?.content ?? "");
    expect(user).toContain("The person answers your questions:\n- Q: Combien de semaines ?\n  A: Quatre.");
    expect(user).not.toContain("Sur le site aussi ?");
    expect(user).toContain("Pensez au mobile.");
    expect(await specOf(id)).toMatchObject({ questions: ["Et les produits retirés ?"], dialogue: [{ question: "Combien de semaines ?", answer: "Quatre." }], rounds: 2 });
    expect(await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text()).toContain("<summary>Questions answered (1)</summary>");

    // Third round: only blocking questions; and the history goes with it.
    const next: { body?: Record<string, unknown> } = {};
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_answer", question_0: "Et les produits retirés ?", answer_0: "Non." }, cookie);
    claudeStream(next, { sections: SECTIONS, questions: [], enough: true, note: "Le besoin est clair : quatre semaines, mobile." });
    await runQueue();
    const again = ((next.body?.["messages"] as { content: string }[])[0]?.content ?? "");
    expect(again).toContain("Questions you asked before, and their answers:\n- Q: Combien de semaines ?\n  A: Quatre.");
    expect(again).toContain("This is round 3: ask only what blocks the specification.");
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("<strong>Claude knows enough to write the stories.</strong> Le besoin est clair : quatre semaines, mobile.");
    // Claude knows enough: the card is to validate.
    expect(await statusOf(id)).toBe("to_validate");
  });

  it("closes the questions when the person decides Claude knows enough, without losing them", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    claudeStream({}, { sections: SECTIONS, questions: ["Q1 ?", "Q2 ?"], enough: false, note: "v1" });
    await runQueue();
    const response = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_enough", question_0: "Q1 ?", answer_0: "" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=enough#spec`);
    expect(await statusOf(id)).toBe("to_validate");
    expect(await specOf(id)).toMatchObject({ questions: [], closed: true, dialogue: [{ question: "Q1 ?", skipped: true }, { question: "Q2 ?", skipped: true }] });
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("You closed the questions");
    expect(page).toContain("<dt>Q1 ?</dt><dd><span class=\"muted\">Left unanswered.</span></dd>");

    // A later change: Claude is told to ask nothing.
    const sent: { body?: Record<string, unknown> } = {};
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_revise", instruction: "Plus court." }, cookie);
    claudeStream(sent, { sections: SECTIONS, questions: ["Q3 ?"], enough: false, note: "v2" });
    await runQueue();
    expect(((sent.body?.["messages"] as { content: string }[])[0]?.content ?? "")).toContain("The person closed the questions: ask nothing more");
    expect(await specOf(id)).toMatchObject({ questions: [], closed: true });
  });

  it("tries again when Anthropic is busy, then says why it failed, keeps the request and offers to try again", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft", instruction: "Gardez ceci." }, cookie);
    for (let attempt = 1; attempt <= 3; attempt++) {
      claudeStream({}, {}, { status: 529 });
      expect(await runQueue()).toEqual(attempt < 3 ? { retried: 1, acked: 0 } : { retried: 0, acked: 1 });
    }
    expect(await env.DB.prepare("SELECT status, attempts FROM claude_jobs").first()).toEqual({ status: "failed", attempts: 3 });
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("Claude could not finish: The Anthropic API answered with an error (529).");
    expect(page).toContain("Gardez ceci.");
    expect(page).toContain('value="job_retry">Try again</button>');

    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "job_retry" }, cookie);
    const retried = await env.DB.prepare("SELECT kind, status, request FROM claude_jobs ORDER BY id DESC").first<{ kind: string; status: string; request: string }>();
    expect(retried).toMatchObject({ kind: "spec_draft", status: "queued" });
    expect(JSON.parse(retried?.request ?? "{}")).toMatchObject({ instruction: "Gardez ceci." });
  });

  it("says why when Claude declines, and still counts the call", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    claudeStream({}, {}, { stopReason: "refusal" });
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });
    expect(await env.DB.prepare("SELECT outcome FROM llm_calls").first()).toEqual({ outcome: "refused" });
    expect((await env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(id).first<{ data: string | null }>())?.data).toBeNull();
    expect(await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text()).toContain("Claude could not finish: Claude declined this request.");
  });

  it("takes one request at a time per card, refuses a tester, and a person past the quota", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    const twice = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    expect(twice.status).toBe(409);
    expect(await twice.text()).toContain("Claude is already working on this card");

    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    expect((await post(`/projects/${REPO}/cards/${id}`, { csrf: tester.csrf, action: "spec_draft" }, tester.cookie)).status).toBe(403);
    const insert = env.DB.prepare("INSERT INTO llm_calls (login, purpose, cost_micros, outcome) VALUES ('pe', 'spec_draft', 1, 'ok')");
    await env.DB.batch([insert, insert, insert]);
    await env.DB.prepare("UPDATE claude_jobs SET status = 'done'").run();
    const response = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("You reached today&#39;s 3 calls to Claude.");
  });

  it("asks for an answer, and saves a spec written by hand", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    const empty = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_answer", question_0: "Q ?", answer_0: " " }, cookie);
    expect(empty.status).toBe(422);
    expect(await empty.text()).toContain("Answer at least one of Claude&#39;s questions.");
    const fields = Object.fromEntries(Object.entries(SECTIONS).map(([key, value]) => [`s_${key}`, value]));
    const response = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_save", rev: "1", ...fields }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=spec_saved#spec`);
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("Edited by hand");
    expect(page).toContain("No call yet.");
  });

  it("pushes the job's progress to the card's open page", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_draft" }, cookie);
    const response = await SELF.fetch(`${BASE}/projects/${REPO}/cards/${id}/live`, { headers: { upgrade: "websocket", cookie } });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("no WebSocket");
    const received: { status: string; label: string; text?: string }[] = [];
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
    socket.accept();
    claudeStream({}, { sections: SECTIONS, questions: [], enough: true, note: "Clair." });
    await runQueue();
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.close();
    expect(received.at(0)).toMatchObject({ status: "queued", text: "Asked by @pe." });
    expect(received).toContainEqual(expect.objectContaining({ status: "running", label: "Claude is writing the spec", text: "Claude starts." }));
    expect(received.at(-1)).toMatchObject({ status: "done", text: "Done: Claude knows enough to write the stories. Cost $0.05." });

    // Not signed in: no connection.
    expect((await SELF.fetch(`${BASE}/projects/${REPO}/cards/${id}/live`, { headers: { upgrade: "websocket" }, redirect: "manual" })).status).toBe(303);
  });
});

describe("From a card to a story", () => {
  it("previews the issue, creates it in the person's name with a link to the card, and keeps the link", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    const fields = Object.fromEntries(Object.entries(SECTIONS).map(([key, value]) => [`s_${key}`, value]));
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_save", rev: "1", ...fields }, cookie);

    const preview = await (await get(`/projects/${REPO}/cards/${id}/story`, cookie)).text();
    expect(preview).toContain(">Besoin</h2>");
    expect(preview).toContain("Fiche d'origine : <a ");
    expect(preview).toContain(`href="${BASE}/c/${id}?rev=2"`);

    let sent: Record<string, unknown> = {};
    fetchMock
      .get("https://api.github.com")
      .intercept({ method: "POST", path: `/repos/${REPO}/issues`, headers: { authorization: "Bearer gho_session_token" } })
      .reply((options) => {
        sent = JSON.parse(String(options.body)) as Record<string, unknown>;
        return {
          statusCode: 201,
          data: JSON.stringify({
            number: 212,
            title: sent["title"],
            state: "open",
            html_url: `https://github.com/${REPO}/issues/212`,
            user: { login: "pe" },
            labels: [{ name: "demande" }],
            created_at: "2026-10-30T02:00:00Z",
            updated_at: "2026-10-30T02:00:00Z",
            closed_at: null,
          }),
          responseOptions: { headers: JSON_HEADERS },
        };
      });
    const response = await post(`/projects/${REPO}/cards/${id}/story`, { csrf, title: "Reprendre le panier" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=story`);
    expect(sent["title"]).toBe("Reprendre le panier");
    expect(sent["labels"]).toEqual(["demande"]);
    expect(String(sent["body"])).toContain(`## Besoin\n\n${SECTIONS.besoin}`);
    expect(String(sent["body"])).toContain(`Fiche d'origine : [C${id}, spec en version 2](${BASE}/c/${id}?rev=2) dans La Fabrique extraordinaire.`);
    expect(await env.DB.prepare("SELECT kind, ref FROM card_links WHERE card_id = ? AND kind = 'story'").bind(id).first()).toEqual({ kind: "story", ref: "212" });
    expect((await logActions()).map((entry) => entry.action)).toContain("card_story_created");
    // Its story made, the card is validated.
    expect(await statusOf(id)).toBe("validated");

    // Editing the card later keeps the story's link.
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "save", rev: "2", title: "Quick reorder, again", body: "Text", kind: "feature", status: "validated" }, cookie);
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain(`/issues/212">#212</a>`);
    // The story as GitHub has it: its title and its stage.
    expect(page).toContain('Reprendre le panier <span class="pill stage-');
    // Its progress, from that story.
    expect(page).toMatch(/From its stories: <span class="pill card-(to_prepare|ready)/);
  });

  it("keeps a permanent address for the card and the version of its spec", async () => {
    const { cookie, csrf, id } = await writerWithCard();
    expect((await get(`/c/${id}?rev=1`, cookie)).headers.get("location")).toBe(`/projects/${REPO}/cards/${id}`);
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_save", rev: "1", s_besoin: "x" }, cookie);
    expect((await get(`/c/${id}?rev=1`, cookie)).headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?rev=1`);
    expect((await get(`/c/${id}`)).headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent(`/c/${id}`)}`);
    expect((await get("/c/9999", cookie)).status).toBe(404);
  });

  it("sends back to the spec while a required section is empty", async () => {
    const { cookie, id } = await writerWithCard();
    const response = await get(`/projects/${REPO}/cards/${id}/story`, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}#spec`);
  });
});

// GitHub creating issues, one per story, in order; `fail` the ones refused.
function mockIssues(sent: Record<string, unknown>[], numbers: number[], fail: number[] = []): void {
  for (const number of numbers) {
    fetchMock
      .get("https://api.github.com")
      .intercept({ method: "POST", path: `/repos/${REPO}/issues` })
      .reply((options) => {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>;
        sent.push(body);
        if (fail.includes(number)) return { statusCode: 403, data: "{}", responseOptions: { headers: JSON_HEADERS } };
        return {
          statusCode: 201,
          data: JSON.stringify({
            number,
            title: body["title"],
            state: "open",
            html_url: `https://github.com/${REPO}/issues/${number}`,
            user: { login: "pe" },
            labels: [{ name: "demande" }],
            created_at: "2026-10-30T02:00:00Z",
            updated_at: "2026-10-30T02:00:00Z",
            closed_at: null,
          }),
          responseOptions: { headers: JSON_HEADERS },
        };
      });
  }
}

const TWO_STORIES = {
  stories: [
    { title: "Reprendre la semaine dernière", sections: { ...SECTIONS, criteres: "- [ ] Quand je touche « Reprendre », la liste se remplit." } },
    { title: "Choisir une autre semaine", sections: { ...SECTIONS, criteres: "- [ ] Quand je choisis une semaine, je vois ses articles." } },
  ],
  note: "La reprise d'abord, le choix ensuite.",
};

describe("Split into stories", () => {
  async function withSplit(): Promise<{ cookie: string; csrf: string; id: number }> {
    const session = await writerWithCard();
    const fields = Object.fromEntries(Object.entries(SECTIONS).map(([key, value]) => [`s_${key}`, value]));
    await post(`/projects/${REPO}/cards/${session.id}`, { csrf: session.csrf, action: "spec_save", rev: "1", ...fields }, session.cookie);
    const response = await post(`/projects/${REPO}/cards/${session.id}`, { csrf: session.csrf, action: "spec_split", instruction: "Deux au plus." }, session.cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${session.id}#claude-job`);
    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, TWO_STORIES);
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });
    const user = ((sent.body?.["messages"] as { content: string }[])[0]?.content ?? "");
    expect(user).toContain("Split this specification into stories.");
    expect(user).toContain("Deux au plus.");
    return session;
  }

  it("has Claude propose stories in the background, shown on the card, nothing sent to GitHub", async () => {
    const { cookie, id } = await withSplit();
    const log = (await env.DB.prepare("SELECT text FROM claude_job_events ORDER BY id").all<{ text: string }>()).results.map((row) => row.text);
    expect(log).toContain("Story 1: Reprendre la semaine dernière");
    expect(log).toContain("Story 2: Choisir une autre semaine");
    expect(log.at(-1)).toBe("Done: 2 stories proposed, to review before they go to GitHub. Cost $0.05.");
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("<strong>Claude proposes 2 stories</strong>: La reprise d&#39;abord, le choix ensuite.");
    expect(page).toContain(`href="/projects/${REPO}/cards/${id}/stories">Review and create the stories</a>`);
    const review = await (await get(`/projects/${REPO}/cards/${id}/stories`, cookie)).text();
    expect(review).toContain('name="keep_0" value="1" checked');
    expect(review).toContain('value="Choisir une autre semaine"');
    expect(review).toContain("(story 2 sur 2)");
  });

  it("has Claude write Gherkin test cases per story, editable on the card (la-fabrique#230)", async () => {
    const { cookie, csrf, id } = await withSplit();
    const asked = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_tests" }, cookie);
    expect(asked.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}#claude-job`);
    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, {
      stories: [
        { number: 0, title: "Reprendre la semaine dernière", gherkin: "Feature: Reprise\n  Scenario: Reprendre\n    Given une liste\n    When je touche Reprendre\n    Then elle se remplit" },
        { number: 0, title: "Choisir une autre semaine", gherkin: "Feature: Choix\n  Scenario: Choisir" },
      ],
      note: "Un scénario par critère.",
    });
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });
    expect(((sent.body?.["messages"] as { content: string }[])[0]?.content ?? "")).toContain("in Gherkin");
    expect(((await env.DB.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE purpose = 'spec_tests'").first<{ n: number }>())?.n ?? 0)).toBe(1);
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain('id="tests"');
    expect(page).toContain("Scenario: Reprendre");
    const saved = await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "tests_save", gherkin_0: "Scenario: Edited by hand", gherkin_1: "Scenario: Choisir" }, cookie);
    expect(saved.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=tests#tests`);
    expect(await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text()).toContain("Scenario: Edited by hand");
  });

  const form = (pairs: [string, string][]) => pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const postPairs = (path: string, pairs: [string, string][], cookie: string) =>
    SELF.fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: form(pairs) });

  it("shows each story as a block: growing sections, criteria one per line, what GitHub will receive", async () => {
    const { cookie, id } = await withSplit();
    const page = await (await get(`/projects/${REPO}/cards/${id}/stories`, cookie)).text();
    expect(page).toContain('name="s_0_besoin" rows="2" data-grow');
    expect(page).toContain('name="c_0" rows="1" data-grow');
    expect(page).toContain("Quand je touche « Reprendre », la liste se remplit.</textarea>");
    expect(page).toContain('value="crit_down:0:0"');
    expect(page).toContain("<summary>What GitHub will receive</summary>");
  });

  it("adds, moves and removes criteria without saving, and the preview follows what is kept", async () => {
    const { cookie, csrf, id } = await withSplit();
    const url = `/projects/${REPO}/cards/${id}/stories`;
    const base: [string, string][] = [["csrf", csrf], ["keep_0", "1"], ["title_0", "A"], ["title_1", "B"], ["rows_0", "1"], ["c_0", "First"], ["c_0", "Second"], ["rows_1", "1"], ["c_1", "Other"]];
    const added = await (await postPairs(url, [...base, ["action", "crit_add:0"]], cookie)).text();
    expect(added.match(/name="c_0"/g)).toHaveLength(3);
    const moved = await (await postPairs(url, [...base, ["action", "crit_down:0:0"]], cookie)).text();
    expect(moved.indexOf("Second</textarea>")).toBeLessThan(moved.indexOf("First</textarea>"));
    const removed = await (await postPairs(url, [...base, ["action", "crit_del:0:0"]], cookie)).text();
    expect(removed).not.toContain("First</textarea>");
    expect(removed).toContain("Second</textarea>");
    // Left out: no preview for story 2, "- [ ] First" in the body of story 1.
    expect(moved).toContain("Left out: nothing will be created for it.");
    expect(moved).toMatch(/story-preview">[\s\S]*?<li>\[ \] Second<\/li>|story-preview">[\s\S]*?Second/);
    // Nothing was saved.
    expect(JSON.parse((await env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(id).first<{ data: string }>())?.data ?? "{}").split.stories[0].answers.criteres).toContain("Quand je touche");
  });

  it("creates only the kept stories with their criteria as edited", async () => {
    const { cookie, csrf, id } = await withSplit();
    const sent: Record<string, unknown>[] = [];
    mockIssues(sent, [301]);
    const response = await postPairs(
      `/projects/${REPO}/cards/${id}/stories`,
      [["csrf", csrf], ["action", "create"], ["keep_1", "1"], ["title_0", "A"], ["title_1", "B"], ["rows_1", "1"], ["c_1", "One"], ["c_1", "Two"]],
      cookie,
    );
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=stories&created=1#stories`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.["title"]).toBe("B");
    expect(String(sent[0]?.["body"])).toContain("- [ ] One\n- [ ] Two");
  });

  it("shows the same editor in the feature's card on Refinement", async () => {
    const { cookie, id } = await withSplit();
    await env.DB.prepare("UPDATE cards SET release = 'Next release' WHERE id = ?").bind(id).run();
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain(`action="/projects/${REPO}/cards/${id}/stories"`);
    expect(page).toContain('name="c_1" rows="1" data-grow');
    expect(page).toContain("What GitHub will receive");
  });

  it("creates the checked stories, as edited, each linked to the card and its spec's version", async () => {
    const { cookie, csrf, id } = await withSplit();
    const sent: Record<string, unknown>[] = [];
    mockIssues(sent, [301]);
    const response = await post(
      `/projects/${REPO}/cards/${id}/stories`,
      { csrf, action: "create", keep_0: "1", title_0: "Reprendre ma semaine", title_1: "Choisir une autre semaine" },
      cookie,
    );
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=stories&created=1#stories`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.["title"]).toBe("Reprendre ma semaine");
    expect(String(sent[0]?.["body"])).toContain("Quand je touche « Reprendre », la liste se remplit.");
    // The version named is the one created from: it holds the edited stories' spec.
    const named = new RegExp(`Fiche d'origine : \\[C${id}, spec en version (\\d+)\\]\\(${BASE}/c/${id}\\?rev=(\\d+)\\) dans La Fabrique extraordinaire\\.`).exec(String(sent[0]?.["body"]));
    expect(named?.[1]).toBe(named?.[2]);
    const version = await env.DB.prepare("SELECT data FROM card_revisions WHERE card_id = ? AND rev = ?").bind(id, Number(named?.[1])).first<{ data: string }>();
    expect(JSON.parse(version?.data ?? "{}").split.stories[0].title).toBe("Reprendre ma semaine");
    expect(await env.DB.prepare("SELECT status FROM cards WHERE id = ?").bind(id).first()).toEqual({ status: "validated" });
    expect((await env.DB.prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = 'story'").bind(id).all()).results).toEqual([{ ref: "301" }]);
    expect(await specOf(id)).toBeTruthy();
    expect(JSON.parse((await env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(id).first<{ data: string }>())?.data ?? "{}").split).toBeUndefined();
  });

  it("keeps what GitHub refused, and asks for the required sections first", async () => {
    const { cookie, csrf, id } = await withSplit();
    const missing = await post(`/projects/${REPO}/cards/${id}/stories`, { csrf, action: "create", keep_0: "1", s_0_besoin: "" }, cookie);
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain("Fill in: Besoin.");

    const sent: Record<string, unknown>[] = [];
    mockIssues(sent, [301, 302], [302]);
    const response = await post(`/projects/${REPO}/cards/${id}/stories`, { csrf, action: "create", keep_0: "1", keep_1: "1" }, cookie);
    expect(response.headers.get("location")).toContain(`/projects/${REPO}/cards/${id}/stories?notice=partial&created=1`);
    expect(String(sent[0]?.["body"])).toContain("(story 1 sur 2)");
    const split = JSON.parse((await env.DB.prepare("SELECT data FROM cards WHERE id = ?").bind(id).first<{ data: string }>())?.data ?? "{}").split;
    expect(split.stories.map((story: { title: string }) => story.title)).toEqual(["Choisir une autre semaine"]);
    const page = await (await get(response.headers.get("location") ?? "", cookie)).text();
    expect(page).toContain("1 done on GitHub, then: GitHub refused to create the issue (HTTP 403). The rest is still here.");
  });

  it("discards the proposal", async () => {
    const { cookie, csrf, id } = await withSplit();
    const response = await post(`/projects/${REPO}/cards/${id}/stories`, { csrf, action: "discard" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=split_discarded#spec`);
    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    // In one row, the split first, starred; one story next to it.
    const row = page.slice(page.indexOf('<div class="spec-actions">'));
    expect(row).toMatch(/<summary class="button claude">Split into stories with Claude<\/summary>[\s\S]*Make one story on GitHub[\s\S]*<summary class="button quiet claude">Ask Claude for a change/);
    expect(row).toContain('<button type="submit" class="button claude" name="action" value="spec_split">Ask Claude</button>');
  });
});

describe("Once a card has stories", () => {
  // A card with a spec, validated, its story #7 already made.
  async function validatedWithStory(): Promise<{ cookie: string; csrf: string; id: number }> {
    const session = await writerWithCard();
    const fields = Object.fromEntries(Object.entries(SECTIONS).map(([key, value]) => [`s_${key}`, value]));
    await post(`/projects/${REPO}/cards/${session.id}`, { csrf: session.csrf, action: "spec_save", rev: "1", ...fields }, session.cookie);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '7')").bind(session.id),
      env.DB.prepare("UPDATE cards SET status = 'validated' WHERE id = ?").bind(session.id),
    ]);
    return session;
  }

  it("goes back to To validate when its feature changes, not when only its tags do", async () => {
    const { cookie, csrf, id } = await validatedWithStory();
    const rev = async () => (await env.DB.prepare("SELECT rev FROM cards WHERE id = ?").bind(id).first<{ rev: number }>())?.rev ?? 0;
    const form = { csrf, title: "Quick reorder", body: "Reorder last week's basket. {segment: pro}", kind: "feature", status: "validated" };
    await post(`/projects/${REPO}/cards/${id}`, { ...form, domain: "Basket", rev: String(await rev()) }, cookie);
    expect(await statusOf(id)).toBe("validated");
    await post(`/projects/${REPO}/cards/${id}`, { ...form, domain: "Basket", body: "Reorder any past basket.", rev: String(await rev()) }, cookie);
    expect(await statusOf(id)).toBe("to_validate");

    await env.DB.prepare("UPDATE cards SET status = 'validated' WHERE id = ?").bind(id).run();
    const fields = Object.fromEntries(Object.entries(SECTIONS).map(([key, value]) => [`s_${key}`, value]));
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_save", rev: String(await rev()), ...fields }, cookie);
    expect(await statusOf(id)).toBe("validated");
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_save", rev: String(await rev()), ...fields, s_besoin: "Reprendre n'importe quel panier." }, cookie);
    expect(await statusOf(id)).toBe("to_validate");
    const reason = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_moved' ORDER BY id DESC LIMIT 1").first<{ details: string }>();
    expect(JSON.parse(reason?.details ?? "{}").reason).toBe("the spec changed");
  });

  it("has Claude review them: a comment on a story to change, a new story, then validated again", async () => {
    const { cookie, csrf, id } = await validatedWithStory();
    const card = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(card).toContain('<summary class="button claude">Review the stories with Claude</summary>');
    expect(card).not.toContain("Make one story on GitHub");

    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_split" }, cookie);
    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, {
      existing: [{ number: 7, verdict: "change", comment: "Ajouter le cas hors ligne." }],
      stories: [TWO_STORIES.stories[1]],
      note: "Le choix de la semaine manque.",
    });
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });
    const user = (sent.body?.["messages"] as { content: string }[])[0]?.content ?? "";
    expect(user).toContain("#7 “Existing basket story” (Backlog)");
    expect(user).toContain("Review these stories against the specification.");
    const schema = (sent.body?.["output_config"] as { format: { schema: { required: string[] } } }).format.schema;
    expect(schema.required).toContain("existing");
    const log = (await env.DB.prepare("SELECT text FROM claude_job_events ORDER BY id").all<{ text: string }>()).results.map((row) => row.text);
    expect(log.at(-1)).toBe("Done: 0 of 1 story still fit, 1 to change; 1 new story proposed, to review before anything goes to GitHub. Cost $0.05.");

    const page = await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text();
    expect(page).toContain("<strong>Claude reviewed the 1 story</strong>: Le choix de la semaine manque.");
    expect(page).toContain('Existing basket story <span class="pill warn">To change</span>');
    const review = await (await get(`/projects/${REPO}/cards/${id}/stories`, cookie)).text();
    expect(review).toContain('name="comment_7" value="1" checked');
    expect(review).toContain("Après un changement de la fiche");
    expect(review).toContain("(story 2 sur 2)");

    const comments: string[] = [];
    fetchMock
      .get("https://api.github.com")
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/7/comments` })
      .reply((options) => {
        comments.push(String(JSON.parse(String(options.body)).body));
        return { statusCode: 201, data: "{}", responseOptions: { headers: JSON_HEADERS } };
      });
    const created: Record<string, unknown>[] = [];
    mockIssues(created, [302]);
    const response = await post(
      `/projects/${REPO}/cards/${id}/stories`,
      { csrf, action: "create", comment_7: "1", comment_text_7: "Ajouter le cas hors ligne, et la reprise.", keep_0: "1" },
      cookie,
    );
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=reviewed&created=1#stories`);
    expect(comments[0]).toMatch(/^Ajouter le cas hors ligne, et la reprise\.\n\nAprès un changement de la fiche \[C\d+, spec en version \d+\]\(.+\/c\/\d+\?rev=\d+\) : revue de @pe avec Claude/);
    expect(String(created[0]?.["body"])).toContain("(story 2 sur 2)");
    expect(await statusOf(id)).toBe("validated");
    const links = (await env.DB.prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = 'story' ORDER BY ref").bind(id).all()).results;
    expect(links).toEqual([{ ref: "302" }, { ref: "7" }]);
    const logged = await env.DB.prepare("SELECT details FROM activity_log WHERE action = 'card_stories_reviewed'").first<{ details: string }>();
    expect(JSON.parse(logged?.details ?? "{}")).toMatchObject({ card: id, commented: [7], created: 1 });
  });

  it("confirms when the stories still fit", async () => {
    const { cookie, csrf, id } = await validatedWithStory();
    await env.DB.prepare("UPDATE cards SET status = 'to_validate' WHERE id = ?").bind(id).run();
    await post(`/projects/${REPO}/cards/${id}`, { csrf, action: "spec_split" }, cookie);
    claudeStream({}, { existing: [{ number: 7, verdict: "fits", comment: "" }], stories: [], note: "Rien ne change." });
    await runQueue();
    const review = await (await get(`/projects/${REPO}/cards/${id}/stories`, cookie)).text();
    expect(review).toContain("Confirm: the stories still fit");
    const response = await post(`/projects/${REPO}/cards/${id}/stories`, { csrf, action: "create" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=reviewed&created=0#stories`);
    expect(await statusOf(id)).toBe("validated");
  });
});

describe("Settings: Claude", () => {
  it("shows the status, who may use it and the quotas; the spend and the key check to the super admin", async () => {
    await grantRole("pe", "product_engineer");
    const pe = await (await get("/settings", (await signIn("pe")).cookie)).text();
    expect(pe).toContain('<span class="pill ok">Ready</span>');
    expect(pe).toContain("3 calls per person and day · $1.00 a month");
    expect(pe).toContain("You today</dt><dd>0 of 3 calls");
    expect(pe).not.toContain("Check the key");

    const admin = await signIn("admin-one");
    const page = await (await get("/settings", admin.cookie)).text();
    expect(page).toContain("Check the key");
    claudeReply({}, { status: "ok" });
    const checked = await SELF.fetch(`${BASE}/settings/claude-check`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
      body: new URLSearchParams({ csrf: admin.csrf }).toString(),
    });
    expect(checked.headers.get("location")).toBe("/settings?notice=claude_ok#claude");
    const after = await (await get("/settings", admin.cookie)).text();
    expect(after).toContain("This month</dt><dd>1 call · $0.05 of $1.00");
    expect(after).toContain("Key checked");
  });

  it("tells how to set the key when it is missing", async () => {
    const { settingsPage } = await import("../src/settings");
    const { usageReport, claudeSettings } = await import("../src/llm");
    const page = settingsPage(
      { login: "admin-one", role: "super_admin", csrfToken: "x" },
      {
        version: "0.1",
        commit: "abc",
        claude: { settings: claudeSettings({ ...env, ANTHROPIC_API_KEY: "" }), report: await usageReport(env.DB, "admin-one"), failure: null },
      },
    );
    expect(page).toContain('<span class="pill alert">Not set up</span>');
    expect(page).toContain("npx wrangler secret put ANTHROPIC_API_KEY");
  });
});

describe("kept answers (#227)", () => {
  it("fabrique.js keeps textarea[data-keep] drafts across a reload", async () => {
    const js = (await import("../site/fabrique.js")).default as string;
    expect(js).toContain("setUpKeptAnswers");
    expect(js).toContain("textarea[data-keep]");
    expect(js).toContain("localStorage.setItem(keepKey(field)");
  });
});

describe("An epic's document with Claude (#281)", () => {
  const EPIC_ANSWER = { sections: { why: "Themes live in two places.", decisions: "Epics are cards.", features: "C77 first.", questions: "" }, questions: ["Which project first?"], enough: false, note: "First draft." };

  async function epicCard(session: { cookie: string; csrf: string }, title = "F9 Epics"): Promise<number> {
    const response = await post(`/projects/${REPO}/cards`, { csrf: session.csrf, title, body: "A theme of work. {epic: F9 Epics}", kind: "epic", status: "draft" }, session.cookie);
    return Number(/cards\/(\d+)/.exec(response.headers.get("location") ?? "")?.[1]);
  }

  it("writes the document by La Fabrique's default sections, with questions, then its own cost and its features' cost", async () => {
    const { cookie, csrf, id: feature } = await writerWithCard();
    await env.DB.prepare("UPDATE cards SET epic = 'F9 Epics' WHERE id = ?").bind(feature).run();
    const epic = await epicCard({ cookie, csrf });
    await env.DB.prepare("INSERT INTO llm_calls (login, repo, card_id, purpose, cost_micros, outcome) VALUES ('pe', ?, ?, 'spec_draft', 7000, 'ok')").bind(REPO, feature).run();

    expect((await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "spec_draft" }, cookie)).status).toBe(303);
    expect(await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text()).toContain("data-live=");
    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, EPIC_ANSWER);
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });

    const system = ((sent.body?.["system"] as { text: string }[])[0]?.text) ?? "";
    expect(system).toContain("document of an epic");
    expect(system).toContain('"why": Why (required)');
    expect(system).not.toContain("Acceptance criteria");
    const user = (sent.body?.["messages"] as { content: string }[])[0]?.content ?? "";
    expect(user).toContain("Quick reorder");
    expect(await env.DB.prepare("SELECT purpose FROM llm_calls WHERE card_id = ?").bind(epic).first()).toEqual({ purpose: "epic_draft" });

    const page = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    expect(page).toContain("<h3>Why</h3>");
    expect(page).toContain('<label for="answer_0">Which project first?</label>');
    expect(page).toContain("Claude on this epic");
    expect(page).toContain("1 call · $0.05");
    expect(page).toContain("2 calls · $0.06");
    expect(page).not.toContain('value="spec_split"');
    expect(page).not.toContain('value="spec_tests"');
    // The feature's own page is unchanged.
    expect(await (await get(`/projects/${REPO}/cards/${feature}`, cookie)).text()).toContain("Write the spec with Claude");

    // Epics have no stories or test cases of their own.
    expect((await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "spec_split" }, cookie)).status).toBe(303);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM claude_jobs WHERE kind = 'spec_split'").first()).toEqual({ n: 0 });
  });

  it("writes by the sections the project declares, keeps the versions, and hides Claude from a tester", async () => {
    const { cookie, csrf } = await writerWithCard();
    const declared = { ...CONFIG, epiques: { rubriques: [{ cle: "vision", titre: "Vision", obligatoire: true }, { cle: "scope", titre: "Scope" }] } };
    await env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify(declared), REPO).run();
    const epic = await epicCard({ cookie, csrf }, "F10 Testing");
    await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "spec_draft" }, cookie);
    claudeStream({}, { sections: { vision: "Test by Claude.", scope: "Sprints." }, questions: [], enough: true, note: "Clear." });
    await runQueue();
    const page = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    expect(page).toContain("<h3>Vision</h3>");
    expect(page).not.toContain("<h3>Why</h3>");

    await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "spec_revise", instruction: "Add the loop." }, cookie);
    claudeStream({}, { sections: { vision: "Test by Claude, in a loop.", scope: "Sprints." }, questions: [], enough: true, note: "Revised." });
    await runQueue();
    const revised = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    expect(revised).toContain("in a loop");
    expect(revised).toContain("Version 2");
    expect(revised).toContain("Version 3");

    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    const seen = await (await get(`/projects/${REPO}/cards/${epic}`, tester.cookie)).text();
    expect(seen).not.toContain('value="spec_revise"');
    expect(seen).not.toContain("Revise the document with Claude");
  });
});

describe("An epic's features with Claude (#282)", () => {
  const PROPOSAL = {
    features: [
      { title: "Epic tab filters", synopsis: "Filter epics.", need: "Find an epic fast.", priority: "P1", depends: [] },
      { title: "Epic export", synopsis: "Export epics.", need: "Share epics.", priority: "P2", depends: ["P1", "C9999"] },
      { title: "Epic badges", synopsis: "Badges.", need: "See at a glance.", priority: "nonsense", depends: ["P3"] },
    ],
    note: "Three steps.",
  };

  async function epicWithDocument(): Promise<{ cookie: string; csrf: string; epic: number; existing: number }> {
    const { cookie, csrf, id: existing } = await writerWithCard();
    const cfg = { ...CONFIG, cycle: { priorites: ["P1", "P2", "P3"] } };
    await env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify(cfg), REPO).run();
    const made = await post(`/projects/${REPO}/cards`, { csrf, title: "F11 Epics", body: "Themes of work.", kind: "epic", status: "draft" }, cookie);
    const epic = Number(/cards\/(\d+)/.exec(made.headers.get("location") ?? "")?.[1]);
    await env.DB.prepare("UPDATE cards SET body = '## Why\n\nThemes of work.' WHERE id = ?").bind(epic).run();
    await env.DB.prepare("UPDATE cards SET epic = 'F11 Epics' WHERE id = ?").bind(existing).run();
    await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'feature', ?)").bind(epic, String(existing)).run();
    return { cookie, csrf, epic, existing };
  }

  it("proposes only the missing features, then creates the kept and edited ones as drafts attached to the epic", async () => {
    const { cookie, csrf, epic, existing } = await epicWithDocument();
    const page = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    expect(page).toContain("Propose features with Claude");

    expect((await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "epic_features", instruction: "Small ones." }, cookie)).status).toBe(303);
    const sent: { body?: Record<string, unknown> } = {};
    claudeStream(sent, PROPOSAL);
    expect(await runQueue()).toEqual({ retried: 0, acked: 1 });
    const user = (sent.body?.["messages"] as { content: string }[])[0]?.content ?? "";
    expect(user).toContain("Quick reorder");
    expect(user).toContain("propose none of them again");
    expect(await env.DB.prepare("SELECT purpose FROM llm_calls WHERE card_id = ?").bind(epic).first()).toEqual({ purpose: "epic_features" });

    const preview = await (await get(`/projects/${REPO}/cards/${epic}/features`, cookie)).text();
    for (const text of ["Epic tab filters", "Filter epics.", "Find an epic fast.", 'name="priority_0"', 'name="depends_1"', "P1 Epic tab filters"]) expect(preview).toContain(text);
    expect(preview).not.toContain("C9999");
    expect(preview).not.toContain("P3 Epic badges</p>");

    // Leave the 3rd out, edit the 2nd, depend on the existing feature.
    const created = await post(
      `/projects/${REPO}/cards/${epic}/features`,
      {
        csrf, action: "create",
        keep_0: "1", title_0: "Epic tab filters", synopsis_0: "Filter epics.", need_0: "Find an epic fast.", priority_0: "P1", depends_0: `C${existing}`,
        keep_1: "1", title_1: "Epic export, edited", synopsis_1: "Edited synopsis.", need_1: "Edited need.", priority_1: "P3", depends_1: "P1, P3",
        title_2: "Epic badges", synopsis_2: "Badges.", need_2: "See.", priority_2: "", depends_2: "",
      },
      cookie,
    );
    expect(created.status).toBe(303);
    const cards = (await env.DB.prepare("SELECT id, kind, status, title, body, epic, release, priority FROM cards WHERE title LIKE 'Epic %' ORDER BY id").all()).results as Record<string, unknown>[];
    expect(cards.map((c) => c["title"])).toEqual(["Epic tab filters", "Epic export, edited"]);
    expect(cards.every((c) => c["kind"] === "feature" && c["status"] === "draft" && c["epic"] === "F11 Epics" && c["release"] === null)).toBe(true);
    expect(cards[1]).toMatchObject({ priority: "P3", body: expect.stringContaining("Edited need.") });
    const [first, second] = cards.map((c) => c["id"] as number);
    const links = (await env.DB.prepare("SELECT card_id, kind, ref FROM card_links WHERE kind IN ('depends', 'feature') AND card_id IN (?, ?, ?)").bind(first, second, epic).all()).results;
    expect(links).toEqual(expect.arrayContaining([
      { card_id: first, kind: "depends", ref: String(existing) },
      { card_id: second, kind: "depends", ref: String(first) },
      { card_id: epic, kind: "feature", ref: String(first) },
      { card_id: epic, kind: "feature", ref: String(second) },
    ]));
    expect((await logActions()).map((entry) => entry.action)).toContain("epic_features_created");

    const after = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    expect(after).toContain("Epic tab filters");
    expect(after).toContain("Epic export, edited");
    expect(after).not.toContain("Epic badges");
    expect((await get(`/projects/${REPO}/cards/${epic}/features`, cookie)).status).toBe(303);
  });

  it("creates nothing when no feature is kept, and not for a tester", async () => {
    const { cookie, csrf, epic } = await epicWithDocument();
    await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "epic_features" }, cookie);
    claudeStream({}, PROPOSAL);
    await runQueue();
    const none = await post(`/projects/${REPO}/cards/${epic}/features`, { csrf, action: "create", title_0: "Epic tab filters" }, cookie);
    expect(none.status).toBe(422);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE title LIKE 'Epic %'").first()).toEqual({ n: 0 });
    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    expect((await get(`/projects/${REPO}/cards/${epic}/features`, tester.cookie)).status).toBe(403);
  });

  it("reviews the epic against its features: findings by kind, nothing changed until one is applied (#283)", async () => {
    const { cookie, csrf, epic, existing } = await epicWithDocument();
    const second = Number((await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, author, epic, position) VALUES (?, 'feature', 'draft', 'Reorder twice', 'Same.', 'x', 'F11 Epics', 99) RETURNING id").bind(REPO).first<{ id: number }>())?.id);
    await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'feature', ?)").bind(epic, String(second)).run();
    expect((await get(`/projects/${REPO}/cards/${epic}`, cookie).then((r) => r.text()))).toContain("Review with Claude");
    expect((await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "epic_review" }, cookie)).status).toBe(303);
    const empty = { draft_title: "", draft_synopsis: "", draft_need: "", draft_priority: "" };
    claudeStream({}, {
      findings: [
        { kind: "uncovered", title: "No export", detail: "The document asks for export.", features: [], draft_title: "Export", draft_synopsis: "Export.", draft_need: "Share.", draft_priority: "P1" },
        { kind: "overlap", title: "Twice the same", detail: "Both reorder.", features: [`C${existing}`, `C${second}`], ...empty },
        { kind: "conflict", title: "Against a decision", detail: "Decision 2.", features: [`C${second}`], ...empty },
        { kind: "dependency", title: "Needs the first", detail: "Order.", features: [`C${second}`, `C${existing}`], ...empty },
        { kind: "dependency", title: "Unknown card", detail: "x", features: ["C9999", `C${existing}`], ...empty },
      ],
      note: "Mostly fine.",
    });
    await runQueue();
    expect(await env.DB.prepare("SELECT purpose FROM llm_calls WHERE card_id = ?").bind(epic).first()).toEqual({ purpose: "epic_review" });
    const page = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    for (const text of ["Uncovered needs", "Overlaps", "Conflicts with a decision", "Missing dependencies", "No export", "Twice the same", "Against a decision", "Needs the first"]) expect(page).toContain(text);
    expect(page).not.toContain("Unknown card");
    // Nothing changed yet.
    const counts = async () => (await env.DB.prepare("SELECT (SELECT COUNT(*) FROM cards) AS cards, (SELECT COUNT(*) FROM card_links WHERE kind = 'depends') AS deps").first()) as { cards: number; deps: number };
    const before = await counts();
    expect(before.deps).toBe(0);
    expect(page).not.toContain('id="notes"');

    // The dependency: only that link is added.
    const dep = await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "review_apply", finding: "3" }, cookie);
    expect(dep.status).toBe(303);
    expect(await counts()).toEqual({ cards: before.cards, deps: 1 });
    expect(await env.DB.prepare("SELECT card_id, ref FROM card_links WHERE kind = 'depends'").first()).toEqual({ card_id: second, ref: String(existing) });
    // Applying twice is refused.
    expect((await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "review_apply", finding: "3" }, cookie)).status).toBe(409);

    // An overlap becomes a note on the epic, nothing else.
    await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "review_apply", finding: "1" }, cookie);
    expect(await counts()).toEqual({ cards: before.cards, deps: 1 });
    const noted = await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text();
    expect(noted).toContain('id="notes"');
    expect(noted).toContain("Both reorder.");

    // An uncovered need opens the preview with the draft; no card yet.
    const open = await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "review_apply", finding: "0" }, cookie);
    expect(open.headers.get("location")).toContain("/features");
    expect(await counts()).toEqual({ cards: before.cards, deps: 1 });
    expect(await (await get(`/projects/${REPO}/cards/${epic}/features`, cookie)).text()).toContain("Export");

    // Dismiss the conflict.
    await post(`/projects/${REPO}/cards/${epic}`, { csrf, action: "review_dismiss", finding: "2" }, cookie);
    expect(await (await get(`/projects/${REPO}/cards/${epic}`, cookie)).text()).toContain("Dismissed");
    const actions = (await logActions()).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["epic_reviewed", "epic_finding_applied", "epic_finding_dismissed"]));

    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    expect((await post(`/projects/${REPO}/cards/${epic}`, { csrf: tester.csrf, action: "review_apply", finding: "2" }, tester.cookie)).status).toBe(403);
  });

  it("does not review an epic without features", async () => {
    const { cookie, epic, existing } = await epicWithDocument();
    await env.DB.prepare("DELETE FROM card_links WHERE card_id = ?").bind(epic).run();
    await env.DB.prepare("UPDATE cards SET epic = NULL WHERE id = ?").bind(existing).run();
    expect((await get(`/projects/${REPO}/cards/${epic}`, cookie).then((r) => r.text()))).not.toContain("Review with Claude");
  });
});
