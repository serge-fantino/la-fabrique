import type { Env } from "./env";
import type { Project } from "./projects";

// A project's monthly budget for Claude (ADR 0004 § 5, epic F15,
// la-fabrique#421), in dollars at the API's rates: what Claude's runs in the
// project's runner would cost on the API (runner_runs, even on the
// subscription), plus La Fabrique's own calls on the project (llm_calls).
// Past 80 %, La Fabrique warns; past 100 %, nothing is launched by itself any
// more (the sprint's run, a relaunch); a tech lead still launches by hand.

export const WARN_SHARE = 0.8;

export type BudgetLevel = "none" | "ok" | "warn" | "over";

export interface BudgetState {
  // Dollars per month, as .fabrique.json says; null without a budget.
  budgetUsd: number | null;
  // Since the first of the month (UTC), in millionths of a dollar.
  spentMicros: number;
  since: string;
  share: number | null;
  level: BudgetLevel;
}

export function monthStart(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function levelOf(spentMicros: number, budgetUsd: number | null): { share: number | null; level: BudgetLevel } {
  if (!budgetUsd) return { share: null, level: "none" };
  const share = spentMicros / (budgetUsd * 1_000_000);
  return { share, level: share >= 1 ? "over" : share >= WARN_SHARE ? "warn" : "ok" };
}

export async function budgetState(env: Pick<Env, "DB">, project: Project, now: Date = new Date()): Promise<BudgetState> {
  const since = monthStart(now);
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(api_cost_micros), 0) FROM runner_runs WHERE repo = ? AND finished_at >= ?) AS runs,
       (SELECT COALESCE(SUM(cost_micros), 0) FROM llm_calls WHERE repo = ? AND at >= ?) AS calls`,
  )
    .bind(project.repo, since, project.repo, since)
    .first<{ runs: number; calls: number }>();
  const spentMicros = (row?.runs ?? 0) + (row?.calls ?? 0);
  const budgetUsd = project.check?.config?.claude?.budget ?? null;
  return { budgetUsd, spentMicros, since, ...levelOf(spentMicros, budgetUsd) };
}

export function budgetRefusal(state: BudgetState): string {
  const spent = (state.spentMicros / 1_000_000).toFixed(2);
  return `This month's Claude budget is spent: $${spent} at API rates of $${state.budgetUsd} (claude.budget). Nothing is launched by itself any more; a tech lead can still launch Claude by hand.`;
}
