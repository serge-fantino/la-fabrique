import { activityStatement } from "./activity-log";
import { epicFeatures } from "./epic-progress";
import { ensureEpicIssue } from "./epic-github";
import { NEXT_RELEASE, SPRINT_LANE, type BoardRelease } from "./card-releases";
import { dimensionValues, listCards, moveCard, type Card } from "./cards";
import type { Env } from "./env";
import type { Project } from "./projects";

// Into refinement in one go: a feature, or every feature of an epic, put in
// Next release, where Refinement takes them up to GO / NO-GO.

export type RefinementPlace = "refinable" | "in_refinement" | "in_sprint" | "under_way" | "out";

// Where a feature stands for this move. Refinable: no release yet, or a
// release planned by number that has not started. Not moved: what is in
// the sprint, on its way or shipped (its release is the project's), and a
// dropped or archived card.
export function refinementPlace(card: Card, releases: ReadonlyMap<string, BoardRelease>): RefinementPlace {
  if (card.kind !== "feature" || card.archivedAt || card.status === "dropped") return "out";
  const release = card.release?.trim() ?? "";
  if (!release) return "refinable";
  if (release === NEXT_RELEASE) return "in_refinement";
  if (release === SPRINT_LANE) return "in_sprint";
  const known = releases.get(release);
  return !known || known.state === "planned" ? "refinable" : "under_way";
}

export interface RefinementCounts {
  // The features this move would take into Next release.
  refinable: Card[];
  inRefinement: number;
  inSprint: number;
  underWay: number;
}

export function refinementCounts(features: Card[], releases: ReadonlyMap<string, BoardRelease>): RefinementCounts {
  const out: RefinementCounts = { refinable: [], inRefinement: 0, inSprint: 0, underWay: 0 };
  for (const card of features) {
    const place = refinementPlace(card, releases);
    if (place === "refinable") out.refinable.push(card);
    else if (place === "in_refinement") out.inRefinement++;
    else if (place === "in_sprint") out.inSprint++;
    else if (place === "under_way") out.underWay++;
  }
  return out;
}

// The features a card's page would move: itself, or an epic's features.
export function refinementScope(card: Card, cards: Card[]): Card[] {
  return card.kind === "epic" ? epicFeatures(card, cards) : card.kind === "feature" ? [card] : [];
}

// Moves the refinable features into Next release, each one logged as a card
// moved (with its reason), the whole move once; the epic's GitHub issue is
// created when its first feature enters refinement.
export async function moveToRefinement(
  env: Env,
  project: Project,
  card: Card,
  releases: ReadonlyMap<string, BoardRelease>,
  login: string,
  origin: string,
): Promise<number[]> {
  const cards = await listCards(env.DB, project.repo);
  const { refinable } = refinementCounts(refinementScope(card, cards), releases);
  if (!refinable.length) return [];
  const known = await dimensionValues(env.DB, project.repo, cards);
  const reason = card.kind === "epic" ? `epic C${card.id} into refinement` : "into refinement";
  const moved: number[] = [];
  for (const feature of refinable) {
    const after = await moveCard(env.DB, feature, login, { set: { release: NEXT_RELEASE }, before: null, after: null }, known, reason);
    moved.push(after.id);
    await ensureEpicIssue(env, project, after, login, origin);
  }
  await env.DB.batch([
    activityStatement(env.DB, {
      actor: login,
      action: "cards_to_refinement",
      repo: project.repo,
      details: { cards: moved, ...(card.kind === "epic" ? { epic: card.id } : {}) },
    }),
  ]);
  return moved;
}
