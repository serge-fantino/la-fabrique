import { activityStatement } from "./activity-log";
import { shownStatus, type Card } from "./cards";
import type { BoardRelease } from "./card-releases";
import { isAvailable, type DependencyLink } from "./dependency-warnings";
import { dependenciesIn, dependencyFirst } from "./sprint-dependencies";
import { refinementPlace } from "./to-refinement";

// The Roadmap's plan: the sprint running, Next release (the next sprint),
// then the sprints to come. A feature planned by hand stays where it was
// put; the others are proposed, in priority and board order, each one
// after what it depends on, so many per sprint. Nothing ships by this plan:
// the cards move into Next release only when someone moves them.

export const SPRINT_NOW = 0;
export const SPRINT_NEXT = 1;
// Beyond this many sprints to come, "Later".
export const HORIZONS = 6;
export const LATER = Number.POSITIVE_INFINITY;

export interface PlannedCard {
  card: Card;
  // Placed by a person (a row of card_plans), not proposed.
  manual: boolean;
  // Planned for the next sprint, still outside Next release: to move.
  toMove: boolean;
  // Its dependencies in the plan, and those planned after it (a warning).
  after: number[];
  late: number[];
}

export interface PlanColumn {
  // 0: the sprint running, 1: Next release, 2…: sprints to come; Infinity: later.
  offset: number;
  label: string;
  cards: PlannedCard[];
}

export interface PlanInput {
  cards: Card[];
  links: DependencyLink[];
  releases: ReadonlyMap<string, BoardRelease>;
  // The project's priority labels, highest first.
  priorities: string[];
  // Features per sprint to come.
  capacity: number;
  // Sprints started so far: a plan row's rank minus it is its offset.
  started: number;
  // card → rank of the sprint it is planned in.
  plans: ReadonlyMap<number, number>;
}

export function planLabel(offset: number): string {
  if (offset === SPRINT_NOW) return "Sprint";
  if (offset === SPRINT_NEXT) return "Next release";
  if (!Number.isFinite(offset)) return "Later";
  return `Sprint +${offset}`;
}

// Features per sprint when the person does not say: as many as Next
// release holds, else the sprint, else 3.
export function defaultCapacity(cards: Card[], releases: ReadonlyMap<string, BoardRelease>): number {
  const count = (place: string) => cards.filter((card) => refinementPlace(card, releases) === place).length;
  return clampCapacity(count("in_refinement") || count("in_sprint") || 3);
}

export function clampCapacity(value: number): number {
  return Number.isInteger(value) ? Math.min(12, Math.max(1, value)) : 3;
}

export function sprintPlan(input: PlanInput): PlanColumn[] {
  const capacity = clampCapacity(input.capacity);
  const features = input.cards.filter((card) => card.kind === "feature" && !card.archivedAt && card.status !== "dropped");
  // Where each feature is: a sprint offset, or -1 when on its way or shipped.
  const where = new Map<number, number>();
  const manual = new Set<number>();
  const toMove = new Set<number>();
  const open: Card[] = [];
  for (const card of features) {
    const place = refinementPlace(card, input.releases);
    if (place === "in_sprint") where.set(card.id, SPRINT_NOW);
    else if (place === "in_refinement") where.set(card.id, SPRINT_NEXT);
    else if (place === "under_way" || isAvailable(card)) where.set(card.id, -1);
    else if (place === "refinable") {
      const rank = input.plans.get(card.id);
      if (rank === undefined) open.push(card);
      else {
        const offset = Math.max(SPRINT_NEXT, rank - input.started);
        where.set(card.id, offset > HORIZONS + 1 ? LATER : offset);
        manual.add(card.id);
        if (offset === SPRINT_NEXT) toMove.add(card.id);
      }
    }
  }
  const load = (offset: number) => [...where.values()].filter((value) => value === offset).length;
  const rank = (card: Card) => {
    const at = card.priority ? input.priorities.indexOf(card.priority) : -1;
    return at < 0 ? input.priorities.length : at;
  };
  const ordered = dependencyFirst(
    [...open].sort((a, b) => rank(a) - rank(b) || a.position - b.position || a.id - b.id),
    input.links,
  );
  for (const card of ordered) {
    const after = dependenciesIn(card, features, input.links).map((dependency) => where.get(dependency.id) ?? -1);
    let offset = Math.max(2, ...after);
    while (Number.isFinite(offset) && load(offset) >= capacity) offset++;
    where.set(card.id, offset > HORIZONS + 1 ? LATER : offset);
  }

  const offsets = [SPRINT_NOW, SPRINT_NEXT, ...Array.from({ length: HORIZONS }, (_, i) => i + 2), LATER];
  const lastUsed = Math.max(SPRINT_NEXT, ...[...where.values()].filter((value) => Number.isFinite(value)));
  return offsets
    .filter((offset) => offset <= SPRINT_NEXT || (Number.isFinite(offset) ? offset <= Math.max(lastUsed, 2) : load(LATER) > 0))
    .map((offset) => ({
      offset,
      label: planLabel(offset),
      cards: features
        .filter((card) => where.get(card.id) === offset)
        .sort((a, b) => order(ordered, a) - order(ordered, b) || a.position - b.position || a.id - b.id)
        .map((card) => {
          const dependencies = dependenciesIn(card, features, input.links).filter((dependency) => (where.get(dependency.id) ?? -1) >= 0);
          return {
            card,
            manual: manual.has(card.id),
            toMove: toMove.has(card.id),
            after: dependencies.map((dependency) => dependency.id),
            late: dependencies.filter((dependency) => (where.get(dependency.id) ?? -1) > offset).map((dependency) => dependency.id),
          };
        }),
    }));
}

function order(list: Card[], card: Card): number {
  const at = list.indexOf(card);
  return at < 0 ? -1 : at;
}

// ---- The dependency tree ------------------------------------------------

export interface EpicNode {
  epic: Card;
  level: number;
  dependsOn: number[];
  features: number;
  inProduction: number;
}

// The epics in levels: an epic comes one level after the epics it depends
// on (through its features' links); a loop is cut where it closes.
export function epicLevels(epics: Card[], dependsOn: ReadonlyMap<number, number[]>, cards: Card[]): EpicNode[] {
  const level = new Map<number, number>();
  const visiting = new Set<number>();
  const visit = (id: number): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(dependsOn.get(id) ?? []).map(visit)) + 1;
    visiting.delete(id);
    level.set(id, value);
    return value;
  };
  epics.forEach((epic) => visit(epic.id));
  return epics.map((epic) => {
    const name = epic.title.trim().toLowerCase();
    const own = cards.filter((card) => card.kind === "feature" && !card.archivedAt && card.status !== "dropped" && (card.epic ?? "").trim().toLowerCase() === name);
    return {
      epic,
      level: level.get(epic.id) ?? 0,
      dependsOn: dependsOn.get(epic.id) ?? [],
      features: own.length,
      inProduction: own.filter((card) => shownStatus(card) === "in_production").length,
    };
  });
}

// Each feature's wave: 1 when nothing it depends on is still to do, else
// one after the latest of what it waits for.
export function featureWaves(features: Card[], links: DependencyLink[]): Map<number, number> {
  const waves = new Map<number, number>();
  const visiting = new Set<number>();
  const visit = (card: Card): number => {
    const known = waves.get(card.id);
    if (known !== undefined) return known;
    if (visiting.has(card.id)) return 1;
    visiting.add(card.id);
    const waiting = dependenciesIn(card, features, links).filter((dependency) => !isAvailable(dependency) && dependency.status !== "dropped");
    const value = Math.max(0, ...waiting.map(visit)) + 1;
    visiting.delete(card.id);
    waves.set(card.id, value);
    return value;
  };
  features.forEach(visit);
  return waves;
}

// ---- Stored plans -------------------------------------------------------

export async function readPlans(db: D1Database, repo: string): Promise<Map<number, number>> {
  const { results } = await db.prepare("SELECT card_id, sprint FROM card_plans WHERE repo = ?").bind(repo).all<{ card_id: number; sprint: number }>();
  return new Map(results.map((row) => [row.card_id, row.sprint]));
}

export async function sprintsStarted(db: D1Database, repo: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM sprints WHERE repo = ?").bind(repo).first<{ n: number }>())?.n ?? 0;
}

// Plans (offset ≥ 2) or unplans (null) features; logged once.
export async function savePlans(db: D1Database, repo: string, started: number, wanted: { card: number; offset: number | null }[], login: string, action = "card_planned"): Promise<void> {
  if (!wanted.length) return;
  await db.batch([
    ...wanted.map(({ card, offset }) =>
      offset === null
        ? db.prepare("DELETE FROM card_plans WHERE card_id = ? AND repo = ?").bind(card, repo)
        : db
            .prepare(
              `INSERT INTO card_plans (card_id, repo, sprint, set_by) VALUES (?, ?, ?, ?)
               ON CONFLICT (card_id) DO UPDATE SET sprint = excluded.sprint, set_by = excluded.set_by, set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
            )
            .bind(card, repo, started + offset, login),
    ),
    activityStatement(db, {
      actor: login,
      action,
      repo,
      details: { plans: wanted.map(({ card, offset }) => ({ card, sprint: offset === null ? null : planLabel(offset) })) },
    }),
  ]);
}
