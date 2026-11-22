import { activityStatement } from "./activity-log";
import { CAPABILITIES } from "./capabilities";
import type { JobKind } from "./jobs";

// One record per agent request (ADR 0006 § 3, epic F15, la-fabrique#415,
// after LimaLibri's demandes): its capability, the target's state when
// asked, and a person's decision on what it proposed. La Fabrique's own
// requests are its background jobs (claude_jobs); the runner's come with the
// agents' queue (C182).

export const DECISIONS = ["kept", "partly", "rejected", "replaced", "unrecorded"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Record<Decision, string> = {
  kept: "Kept",
  partly: "Partly kept",
  rejected: "Rejected",
  replaced: "Replaced by a newer one",
  unrecorded: "Before decisions were recorded",
};

// The capabilities whose proposals wait for a person.
export function waitsForDecision(capability: string): boolean {
  return CAPABILITIES.some((entry) => entry.id === capability && entry.ending === "decision");
}

// The capability a background job asks for: the same job writes a card's
// spec or an epic's document.
export function capabilityOfJob(kind: JobKind, epic: boolean): string {
  if (kind === "spec_draft" || kind === "spec_revise" || kind === "spec_answer") return epic ? "epic_document" : "spec";
  const found = CAPABILITIES.find((entry) => entry.jobs?.includes(kind));
  return found?.id ?? kind;
}

export interface Target {
  rev: number;
  spec_at: string | null;
}

export interface DecisionDetails {
  kept?: number;
  of?: number;
  reason?: string;
  // Decided while the spec had changed since the proposal.
  outdated?: boolean;
}

// The decision from what was kept out of what was proposed.
export function decisionOf(kept: number, of: number): Decision {
  if (of > 0 && kept >= of) return "kept";
  return kept > 0 ? "partly" : "rejected";
}

// A request of this capability has just proposed something on the card:
// the earlier ones never decided are replaced by it.
export function replacedStatement(db: D1Database, cardId: number, capability: string, jobId: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE claude_jobs SET decision = 'replaced', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE card_id = ? AND capability = ? AND id < ? AND status = 'done' AND (decision IS NULL OR decision = 'unrecorded')`,
    )
    .bind(cardId, capability, jobId);
}

// A person decided on the proposal waiting on the card: recorded on the
// request that made it (the latest one done, not decided yet) and logged.
// Nothing to record when the proposal was not made by a request (a draft
// added by hand): the decision is still logged.
export async function recordDecision(
  db: D1Database,
  data: { repo: string; cardId: number; capability: string; login: string; decision: Decision; details: DecisionDetails },
): Promise<number | null> {
  const job = await db
    .prepare(
      `SELECT id FROM claude_jobs WHERE card_id = ? AND capability = ? AND status = 'done' AND (decision IS NULL OR decision = 'unrecorded')
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(data.cardId, data.capability)
    .first<{ id: number }>();
  const details: DecisionDetails = { ...data.details, ...(data.details.reason ? { reason: data.details.reason.trim().slice(0, 1000) } : {}) };
  if (!details.reason) delete details.reason;
  await db.batch([
    ...(job
      ? [
          db
            .prepare("UPDATE claude_jobs SET decision = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), decision_details = ? WHERE id = ?")
            .bind(data.decision, data.login, JSON.stringify(details), job.id),
        ]
      : []),
    activityStatement(db, {
      actor: data.login,
      action: "request_decided",
      repo: data.repo,
      details: { card: data.cardId, capability: data.capability, decision: data.decision, ...(job ? { request: job.id } : {}), ...details },
    }),
  ]);
  return job?.id ?? null;
}

export interface Rejection {
  at: string;
  by: string;
  reason: string;
}

// The reasons the person gave when discarding earlier proposals of this
// capability on this card, newest first: Claude reads them before proposing
// again, as LimaLibri's rejected proposals teach it what the author does not
// want.
export async function rejectionsFor(db: D1Database, cardId: number, capability: string, limit = 3): Promise<Rejection[]> {
  const { results } = await db
    .prepare(
      `SELECT decided_at, decided_by, decision_details FROM claude_jobs
       WHERE card_id = ? AND capability = ? AND decision IN ('rejected', 'partly') AND decision_details LIKE '%"reason"%'
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(cardId, capability, limit)
    .all<{ decided_at: string | null; decided_by: string | null; decision_details: string | null }>();
  return results.flatMap((row) => {
    try {
      const details = JSON.parse(row.decision_details ?? "{}") as DecisionDetails;
      return details.reason ? [{ at: row.decided_at ?? "", by: row.decided_by ?? "", reason: details.reason }] : [];
    } catch {
      return [];
    }
  });
}

// The rejections, as Claude reads them in its request.
export function rejectionsForClaude(rejections: Rejection[], what: string): string {
  if (!rejections.length) return "";
  return `\nThe person discarded earlier proposals of ${what} on this card, and said why (newest first). Do not propose again what they refused:\n${rejections
    .map((rejection) => `<discarded>\n${rejection.reason}\n</discarded>`)
    .join("\n")}\n`;
}

export interface DecisionCounts {
  kept: number;
  partly: number;
  rejected: number;
  waiting: number;
}

// How the proposals of each capability were decided on a project. A proposal
// replaced by a newer one, or decided before decisions were recorded, is not
// counted.
export async function decisionCounts(db: D1Database, repo: string): Promise<Map<string, DecisionCounts>> {
  const { results } = await db
    .prepare(
      `SELECT capability, decision, COUNT(*) AS n FROM claude_jobs
       WHERE repo = ? AND status = 'done' AND capability IS NOT NULL GROUP BY capability, decision`,
    )
    .bind(repo)
    .all<{ capability: string; decision: string | null; n: number }>();
  const counts = new Map<string, DecisionCounts>();
  for (const row of results) {
    if (!waitsForDecision(row.capability)) continue;
    const entry = counts.get(row.capability) ?? { kept: 0, partly: 0, rejected: 0, waiting: 0 };
    if (row.decision === null) entry.waiting += row.n;
    else if (row.decision === "kept" || row.decision === "partly" || row.decision === "rejected") entry[row.decision] += row.n;
    counts.set(row.capability, entry);
  }
  return counts;
}
