import { activityStatement } from "./activity-log";
import { cardProgress } from "./card-progress";
import type { Progress } from "./progress-stages";
import { type Card, listCards } from "./cards";
import type { Env } from "./env";
import type { Project } from "./projects";
import { activeSprint } from "./sprints";

// The status of an epic card (la-fabrique#286): it follows its features,
// never typed. Ideation (no feature), Open (features, none in the sprint,
// not all out), Active (one is in the sprint), Done (all shipped or
// dropped). Dropped is the one status set by hand, while in Ideation
// (`cards.status = 'dropped'`); archiving (`archived_at`) is by hand too,
// when Done or Dropped. A feature is shipped when its progress is
// *In production*. Each change is written in the log, dated, with its reason.
export const EPIC_STATUSES = ["ideation", "open", "active", "done", "dropped"] as const;
export type EpicStatus = (typeof EPIC_STATUSES)[number];

export const EPIC_STATUS_LABELS: Record<EpicStatus, string> = {
  ideation: "Ideation",
  open: "Open",
  active: "Active",
  done: "Done",
  dropped: "Dropped",
};

export const EPIC_STATUS_TONES: Record<EpicStatus, string> = { ideation: "", open: "warn", active: "", done: "ok", dropped: "alert" };

export interface EpicState {
  status: EpicStatus;
  features: number;
  reason: string;
}

const IN_SPRINT = new Set(["in_sprint", "in_dev", "to_test"]);

export function epicStateOf(epic: Pick<Card, "status">, features: Card[], progress: Map<number, Progress>, sprintLane: string | null): EpicState {
  const mine = features.filter((feature) => !feature.archivedAt);
  const count = mine.length;
  if (epic.status === "dropped") return { status: "dropped", features: count, reason: "dropped by hand" };
  if (!count) return { status: "ideation", features: 0, reason: "no feature yet" };
  const isShipped = (feature: Card) => progress.get(feature.id)?.stage === "in_production";
  const isDropped = (feature: Card) => feature.status === "dropped";
  if (mine.every((feature) => isShipped(feature) || isDropped(feature))) {
    return { status: "done", features: count, reason: `all ${count} feature${count === 1 ? "" : "s"} shipped or dropped` };
  }
  const inSprint = mine.filter((feature) => !isShipped(feature) && !isDropped(feature)).filter((feature) => {
    const stage = progress.get(feature.id)?.stage;
    return (stage && IN_SPRINT.has(stage)) || (sprintLane !== null && feature.release === sprintLane);
  });
  if (inSprint.length) return { status: "active", features: count, reason: `C${inSprint[0]?.id} is in the sprint` };
  return { status: "open", features: count, reason: `${count} feature${count === 1 ? "" : "s"}, none in the sprint` };
}

// The state of each epic, from its features; a change since the last one
// written in the log is written, dated, with its reason.
export async function epicStates(env: Env, project: Project, epics: Card[]): Promise<Map<number, EpicState>> {
  const found = new Map<number, EpicState>();
  if (!epics.length) return found;
  const cards = await listCards(env.DB, project.repo);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const links = await env.DB
    .prepare("SELECT l.card_id AS epic, l.ref AS ref FROM card_links l JOIN cards c ON c.id = l.card_id WHERE c.repo = ? AND c.kind = 'epic' AND l.kind = 'feature' ORDER BY l.rowid")
    .bind(project.repo)
    .all<{ epic: number; ref: string }>();
  const featuresOf = (epic: Card): Card[] =>
    links.results.filter((row) => row.epic === epic.id).map((row) => byId.get(Number(row.ref))).filter((card): card is Card => Boolean(card && card.kind === "feature"));
  const all = new Set<Card>();
  for (const epic of epics) for (const feature of featuresOf(epic)) all.add(feature);
  const [progress, sprint] = await Promise.all([all.size ? cardProgress(env, project, [...all]) : Promise.resolve(new Map<number, Progress>()), activeSprint(env.DB, project.repo)]);
  const logged = await lastLogged(env.DB, project.repo);
  const changes: D1PreparedStatement[] = [];
  for (const epic of epics) {
    const state = epicStateOf(epic, featuresOf(epic), progress, sprint?.release ?? null);
    found.set(epic.id, state);
    if (epic.archivedAt || logged.get(epic.id) === state.status) continue;
    changes.push(
      activityStatement(env.DB, {
        actor: "la-fabrique",
        action: "epic_status_changed",
        repo: project.repo,
        details: { card: epic.id, title: epic.title, from: logged.get(epic.id) ?? null, to: state.status, reason: state.reason },
      }),
    );
  }
  if (changes.length) await env.DB.batch(changes);
  return found;
}

async function lastLogged(db: D1Database, repo: string): Promise<Map<number, string>> {
  const { results } = await db
    .prepare("SELECT details FROM activity_log WHERE repo = ? AND action = 'epic_status_changed' ORDER BY id")
    .bind(repo)
    .all<{ details: string }>();
  const last = new Map<number, string>();
  for (const row of results) {
    const d = JSON.parse(row.details) as { card: number; to: string };
    last.set(d.card, d.to);
  }
  return last;
}

export type EpicRefusal = "has_features" | "not_in_ideation" | "not_done" | "not_archived" | "archived" | "not_an_epic";

// What can be done by hand now (the views offer exactly this).
export function epicChoices(epic: Pick<Card, "archivedAt">, state: EpicState): { drop: boolean; archive: boolean; unarchive: boolean } {
  if (epic.archivedAt) return { drop: false, archive: false, unarchive: true };
  return { drop: state.status === "ideation", archive: state.status === "done" || state.status === "dropped", unarchive: false };
}

export async function dropEpic(env: Env, project: Project, epic: Card, login: string): Promise<EpicRefusal | null> {
  if (epic.kind !== "epic") return "not_an_epic";
  if (epic.archivedAt) return "archived";
  const state = (await epicStates(env, project, [epic])).get(epic.id);
  if (!state || state.status !== "ideation") return state && state.features ? "has_features" : "not_in_ideation";
  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET status = 'dropped' WHERE id = ? AND repo = ?").bind(epic.id, project.repo),
    activityStatement(env.DB, {
      actor: login,
      action: "epic_status_changed",
      repo: project.repo,
      details: { card: epic.id, title: epic.title, from: "ideation", to: "dropped", reason: `dropped by @${login} while in Ideation` },
    }),
  ]);
  return null;
}

export async function archiveEpic(env: Env, project: Project, epic: Card, login: string, archive: boolean): Promise<EpicRefusal | null> {
  if (epic.kind !== "epic") return "not_an_epic";
  const state = (await epicStates(env, project, [epic])).get(epic.id);
  if (archive) {
    if (epic.archivedAt) return "archived";
    if (!state || !epicChoices(epic, state).archive) return "not_done";
  } else if (!epic.archivedAt) return "not_archived";
  await env.DB.batch([
    env.DB
      .prepare(`UPDATE cards SET archived_at = ${archive ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "NULL"} WHERE id = ? AND repo = ?`)
      .bind(epic.id, project.repo),
    activityStatement(env.DB, {
      actor: login,
      action: archive ? "epic_archived" : "epic_unarchived",
      repo: project.repo,
      details: {
        card: epic.id,
        title: epic.title,
        status: state?.status ?? null,
        reason: archive ? `archived by @${login} while ${EPIC_STATUS_LABELS[state?.status ?? "done"]}` : `unarchived by @${login}`,
      },
    }),
  ]);
  return null;
}

export interface EpicHistoryEntry {
  actor: string;
  action: string;
  at: string;
  from: string | null;
  to: string | null;
  reason: string;
}

export async function epicHistory(db: D1Database, repo: string, id: number): Promise<EpicHistoryEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT actor, action, occurred_at, details FROM activity_log WHERE repo = ?
       AND action IN ('epic_status_changed', 'epic_archived', 'epic_unarchived') AND json_extract(details, '$.card') = ? ORDER BY id DESC LIMIT 100`,
    )
    .bind(repo, id)
    .all<{ actor: string; action: string; occurred_at: string; details: string }>();
  return results.map((row) => {
    const d = JSON.parse(row.details) as { from?: string | null; to?: string | null; reason?: string };
    return { actor: row.actor, action: row.action, at: row.occurred_at, from: d.from ?? null, to: d.to ?? null, reason: d.reason ?? "" };
  });
}
