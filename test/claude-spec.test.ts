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
    expect(page).toContain("0 of 1 in production.");
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
    expect(page).toContain("1 story created, then: GitHub refused to create the issue (HTTP 403). The others are still here.");
  });

  it("discards the proposal", async () => {
    const { cookie, csrf, id } = await withSplit();
    const response = await post(`/projects/${REPO}/cards/${id}/stories`, { csrf, action: "discard" }, cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=split_discarded#spec`);
    expect(await (await get(`/projects/${REPO}/cards/${id}`, cookie)).text()).toContain("Split into stories with Claude");
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
