import type { Env } from "./env";
import type { FabriqueConfig, ReadyCheck } from "./fabrique-config";
import { PRODUCTION, type ProductionStatus } from "./production";
import type { Project } from "./projects";
import { readSnapshot } from "./snapshots";
import type { Story } from "./stories";

// Where a story stands, computed from what GitHub says; never stored.
export type Stage = "backlog" | "ready" | "in_dev" | "on_int" | "done";

export const STAGES: { id: Stage; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_dev", label: "In development" },
  { id: "on_int", label: "On int" },
  { id: "done", label: "In production" },
];

export function isStage(value: string | null): value is Stage {
  return STAGES.some((stage) => stage.id === value);
}

const DEFAULT_READY: ReadyCheck[] = ["criteres", "epique"];

const MISSING: Record<ReadyCheck, string> = {
  criteres: "no acceptance criteria",
  epique: "not in an epic nor a card",
  priorite: "no priority",
  etiquette_prete: "not labelled ready",
};

export interface CycleRules {
  checks: ReadyCheck[];
  priorities: string[];
  readyLabel: string | null;
  // The stories made from a card: a card groups them as an epic would.
  inCard: Set<number>;
}

export function cycleRules(config: FabriqueConfig | null | undefined, inCard: Set<number> = new Set()): CycleRules {
  return {
    checks: config?.cycle?.pret ?? DEFAULT_READY,
    priorities: config?.cycle?.priorites ?? [],
    readyLabel: config?.demandes?.etiquettes?.["prete"] ?? null,
    inCard,
  };
}

// The project's rules, knowing which stories come from a card.
export async function projectRules(db: D1Database, project: Project): Promise<CycleRules> {
  const { results } = await db
    .prepare("SELECT DISTINCT l.ref FROM card_links l JOIN cards c ON c.id = l.card_id WHERE c.repo = ? AND l.kind = 'story' AND c.archived_at IS NULL")
    .bind(project.repo)
    .all<{ ref: string }>();
  return cycleRules(project.check?.config, new Set(results.map((row) => Number(row.ref))));
}

export function isEpic(story: Story): boolean {
  return story.subTotal > 0;
}

// The highest priority label the story carries, if any.
export function priorityOf(story: Story, rules: CycleRules): string | null {
  return rules.priorities.find((label) => story.labels.includes(label)) ?? null;
}

// What the Definition of Ready still lacks, in words; empty when ready.
export function missingForReady(story: Story, rules: CycleRules): string[] {
  const met: Record<ReadyCheck, boolean> = {
    criteres: (story.criteria?.length ?? 0) > 0,
    epique: story.parent !== null || rules.inCard.has(story.number),
    priorite: priorityOf(story, rules) !== null,
    etiquette_prete: rules.readyLabel !== null && story.labels.includes(rules.readyLabel),
  };
  return rules.checks.filter((check) => !met[check]).map((check) => MISSING[check]);
}

// `onInt`: the stories whose work is on integration and not in production.
export function stageOf(story: Story, rules: CycleRules, onInt: Set<number>): Stage | null {
  if (isEpic(story)) return null;
  if (onInt.has(story.number)) return "on_int";
  if (story.state === "closed") return "done";
  if (story.branches.length > 0 || story.pullRequests.some((pull) => pull.state !== "closed")) return "in_dev";
  return missingForReady(story, rules).length ? "backlog" : "ready";
}

// The stories the pending work refers to, from the last production read
// (no GitHub call).
export async function storiesOnInt(env: Env, project: Project): Promise<Set<number>> {
  const snapshot = await readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION);
  return new Set((snapshot?.data.groups ?? []).flatMap((group) => group.issues));
}

export function stagesOf(stories: Story[], rules: CycleRules, onInt: Set<number>): Map<number, Stage> {
  const stages = new Map<number, Stage>();
  for (const story of stories) {
    const stage = stageOf(story, rules, onInt);
    if (stage) stages.set(story.number, stage);
  }
  return stages;
}
