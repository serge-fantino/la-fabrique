import Anthropic from "@anthropic-ai/sdk";
import type { Role } from "./accounts";
import type { Env } from "./env";
import { can } from "./rights";

// Claude in La Fabrique (la-fabrique#74): La Fabrique's own API key, a
// secret of the Worker; who may call it (the rights ladder), quotas, and
// the cost of every call, kept per card. Never the content of a call.

export const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_DAILY_CALLS = 30;
const DEFAULT_MONTHLY_BUDGET_USD = 20;

export interface ClaudeSettings {
  configured: boolean;
  model: string;
  dailyCalls: number;
  monthlyBudgetUsd: number;
}

function positive(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function claudeSettings(env: Env): ClaudeSettings {
  return {
    configured: Boolean(env.ANTHROPIC_API_KEY),
    model: env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL,
    dailyCalls: Math.floor(positive(env.CLAUDE_DAILY_CALLS, DEFAULT_DAILY_CALLS)),
    monthlyBudgetUsd: positive(env.CLAUDE_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD),
  };
}

// Writing with Claude goes with writing requests and cards.
export function canUseClaude(role: Role): boolean {
  return can(role, "request");
}

// US dollars per million tokens (Anthropic API, October 2026). A cache
// read is billed at its own price, a cache write (5 minutes) at 1.25 times
// the input price.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function knownPrice(model: string): boolean {
  return model in PRICES;
}

export interface TokenUse {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Millionths of a dollar: a price per million tokens is a price in
// millionths per token. Null when a model's price is unknown.
export function costMicros(uses: TokenUse[]): number | null {
  let total = 0;
  for (const use of uses) {
    const price = PRICES[use.model];
    if (!price) return null;
    total += use.input * price.input + use.output * price.output + use.cacheRead * price.cacheRead + use.cacheWrite * price.input * 1.25;
  }
  return Math.round(total);
}

export function formatUsd(micros: number | null): string {
  if (micros === null) return "price unknown";
  const dollars = micros / 1_000_000;
  return `$${dollars < 0.01 && dollars > 0 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
}

// The tokens of a response, per model: with a fallback, each model that
// ran has its own line in `usage.iterations`.
export function usesOf(message: Anthropic.Beta.BetaMessage, requested: string): TokenUse[] {
  const iterations = message.usage.iterations ?? [];
  const lines = iterations.filter(
    (entry): entry is Anthropic.Beta.BetaMessageIterationUsage | Anthropic.Beta.BetaFallbackMessageIterationUsage =>
      entry.type === "message" || entry.type === "fallback_message",
  );
  if (lines.length) {
    return lines.map((entry) => ({
      model: entry.model ?? requested,
      input: entry.input_tokens,
      output: entry.output_tokens,
      cacheRead: entry.cache_read_input_tokens,
      cacheWrite: entry.cache_creation_input_tokens,
    }));
  }
  const usage = message.usage;
  return [
    {
      model: message.model || requested,
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  ];
}

// ---- Quotas ---------------------------------------------------------------

function startOfDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function startOfMonth(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

export type Allowance = { ok: true } | { ok: false; reason: string };

export async function allowance(env: Env, role: Role, login: string, now = new Date()): Promise<Allowance> {
  const settings = claudeSettings(env);
  if (!settings.configured) return { ok: false, reason: "Claude is not set up in La Fabrique yet (no API key): see Settings." };
  if (!canUseClaude(role)) return { ok: false, reason: "Your role does not let you use Claude." };
  const [today, month] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE login = ? AND at >= ?").bind(login, startOfDay(now)).first<{ n: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM llm_calls WHERE at >= ?").bind(startOfMonth(now)).first<{ micros: number }>(),
  ]);
  if ((today?.n ?? 0) >= settings.dailyCalls) {
    return { ok: false, reason: `You reached today's ${settings.dailyCalls} calls to Claude. Back tomorrow (UTC).` };
  }
  if ((month?.micros ?? 0) >= settings.monthlyBudgetUsd * 1_000_000) {
    return { ok: false, reason: `La Fabrique reached this month's Claude budget (${formatUsd(settings.monthlyBudgetUsd * 1_000_000)}). A super admin can raise it.` };
  }
  return { ok: true };
}

// ---- Calls ------------------------------------------------------------------

export interface CallRecord {
  login: string;
  repo: string | null;
  cardId: number | null;
  purpose: string;
}

export interface CallOutcome<T> {
  ok: boolean;
  value: T | null;
  // What the person reads when it failed.
  message: string | null;
  callId: number;
  costMicros: number | null;
}

async function record(
  env: Env,
  call: CallRecord,
  outcome: string,
  uses: TokenUse[],
  model: string | null,
  error: string | null,
): Promise<{ id: number; cost: number | null }> {
  const cost = uses.length ? costMicros(uses) : 0;
  const sum = (pick: (use: TokenUse) => number) => uses.reduce((total, use) => total + pick(use), 0);
  const row = await env.DB.prepare(
    `INSERT INTO llm_calls (login, repo, card_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, outcome, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      call.login,
      call.repo,
      call.cardId,
      call.purpose,
      model,
      sum((use) => use.input),
      sum((use) => use.output),
      sum((use) => use.cacheRead),
      sum((use) => use.cacheWrite),
      cost,
      outcome,
      error,
    )
    .first<{ id: number }>();
  return { id: row?.id ?? 0, cost };
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "The Anthropic API refused the key (401): check ANTHROPIC_API_KEY.";
  if (error instanceof Anthropic.PermissionDeniedError) return "The Anthropic API refused this key for this model (403).";
  if (error instanceof Anthropic.RateLimitError) return "The Anthropic API is busy for this key (429): try again in a minute.";
  if (error instanceof Anthropic.BadRequestError) return `The Anthropic API refused the request (400): ${error.message.slice(0, 200)}`;
  if (error instanceof Anthropic.APIError) return `The Anthropic API answered with an error (${error.status ?? "?"}).`;
  return "Could not reach the Anthropic API.";
}

export interface JsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

// One call that answers JSON in the given shape. The system prompt is
// cached: a second call within five minutes reads it at a tenth of the
// price. A refused request goes to Anthropic's recommended fallback.
export async function askJson<T>(env: Env, call: CallRecord, request: JsonRequest): Promise<CallOutcome<T>> {
  const settings = claudeSettings(env);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "", maxRetries: 1, timeout: 120_000 });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create({
      model: settings.model,
      max_tokens: request.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: request.schema } },
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.user }],
    });
  } catch (error) {
    const text = describeError(error);
    const saved = await record(env, call, "error", [], settings.model, text);
    return { ok: false, value: null, message: text, callId: saved.id, costMicros: saved.cost };
  }

  const uses = usesOf(message, settings.model);
  if (message.stop_reason === "refusal") {
    const text = "Claude declined this request. Rephrase the card or the request, or write it yourself.";
    const saved = await record(env, call, "refused", uses, message.model, message.stop_details?.category ?? null);
    return { ok: false, value: null, message: text, callId: saved.id, costMicros: saved.cost };
  }
  if (message.stop_reason === "max_tokens") {
    const text = "Claude's answer was cut off (too long). Try a shorter request.";
    const saved = await record(env, call, "error", uses, message.model, "max_tokens");
    return { ok: false, value: null, message: text, callId: saved.id, costMicros: saved.cost };
  }
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    const saved = await record(env, call, "error", uses, message.model, "unreadable answer");
    return { ok: false, value: null, message: "Claude's answer could not be read. Try again.", callId: saved.id, costMicros: saved.cost };
  }
  const saved = await record(env, call, "ok", uses, message.model, null);
  return { ok: true, value, message: null, callId: saved.id, costMicros: saved.cost };
}

// A tiny call to check the key and the model from Settings.
export async function checkKey(env: Env, login: string): Promise<CallOutcome<{ status: string }>> {
  return askJson<{ status: string }>(
    env,
    { login, repo: null, cardId: null, purpose: "key_check" },
    {
      system: "You check that the connection to the Anthropic API works.",
      user: 'Answer with the status "ok".',
      schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false },
      maxTokens: 1024,
    },
  );
}

// ---- What it cost -----------------------------------------------------------

export interface CallRow {
  id: number;
  at: string;
  login: string;
  repo: string | null;
  card_id: number | null;
  purpose: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micros: number | null;
  outcome: string;
  error: string | null;
}

export interface Spend {
  calls: number;
  micros: number;
  unknown: number;
}

const SPEND = "COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS micros, SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unknown";

function spendOf(row: { calls: number; micros: number; unknown: number | null } | null): Spend {
  return { calls: row?.calls ?? 0, micros: row?.micros ?? 0, unknown: row?.unknown ?? 0 };
}

export async function cardCalls(db: D1Database, cardId: number): Promise<CallRow[]> {
  const { results } = await db.prepare("SELECT * FROM llm_calls WHERE card_id = ? ORDER BY id DESC").bind(cardId).all<CallRow>();
  return results;
}

export async function cardSpends(db: D1Database, repo: string): Promise<Map<number, Spend>> {
  const { results } = await db
    .prepare(`SELECT card_id, ${SPEND} FROM llm_calls WHERE repo = ? AND card_id IS NOT NULL GROUP BY card_id`)
    .bind(repo)
    .all<{ card_id: number; calls: number; micros: number; unknown: number }>();
  return new Map(results.map((row) => [row.card_id, spendOf(row)]));
}

export interface UsageReport {
  month: Spend;
  today: Spend;
  mineToday: Spend;
  byProject: (Spend & { repo: string | null })[];
  byPerson: (Spend & { login: string })[];
  byCard: (Spend & { repo: string; cardId: number; title: string | null })[];
  recent: CallRow[];
}

export async function usageReport(db: D1Database, login: string, now = new Date()): Promise<UsageReport> {
  const month = startOfMonth(now);
  const day = startOfDay(now);
  const [monthRow, todayRow, mine, projects, people, cards, recent] = await Promise.all([
    db.prepare(`SELECT ${SPEND} FROM llm_calls WHERE at >= ?`).bind(month).first<{ calls: number; micros: number; unknown: number }>(),
    db.prepare(`SELECT ${SPEND} FROM llm_calls WHERE at >= ?`).bind(day).first<{ calls: number; micros: number; unknown: number }>(),
    db.prepare(`SELECT ${SPEND} FROM llm_calls WHERE at >= ? AND login = ?`).bind(day, login).first<{ calls: number; micros: number; unknown: number }>(),
    db
      .prepare(`SELECT repo, ${SPEND} FROM llm_calls WHERE at >= ? GROUP BY repo ORDER BY micros DESC`)
      .bind(month)
      .all<{ repo: string | null; calls: number; micros: number; unknown: number }>(),
    db
      .prepare(`SELECT login, ${SPEND} FROM llm_calls WHERE at >= ? GROUP BY login ORDER BY micros DESC`)
      .bind(month)
      .all<{ login: string; calls: number; micros: number; unknown: number }>(),
    db
      .prepare(
        `SELECT l.repo, l.card_id, c.title, COUNT(*) AS calls, COALESCE(SUM(l.cost_micros), 0) AS micros,
           SUM(CASE WHEN l.cost_micros IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM llm_calls l LEFT JOIN cards c ON c.id = l.card_id
         WHERE l.card_id IS NOT NULL GROUP BY l.repo, l.card_id ORDER BY micros DESC LIMIT 20`,
      )
      .all<{ repo: string; card_id: number; title: string | null; calls: number; micros: number; unknown: number }>(),
    db.prepare("SELECT * FROM llm_calls ORDER BY id DESC LIMIT 10").all<CallRow>(),
  ]);
  return {
    month: spendOf(monthRow),
    today: spendOf(todayRow),
    mineToday: spendOf(mine),
    byProject: projects.results.map((row) => ({ repo: row.repo, ...spendOf(row) })),
    byPerson: people.results.map((row) => ({ login: row.login, ...spendOf(row) })),
    byCard: cards.results.map((row) => ({ repo: row.repo, cardId: row.card_id, title: row.title, ...spendOf(row) })),
    recent: recent.results,
  };
}
