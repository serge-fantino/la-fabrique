import { activityStatement } from "./activity-log";
import { isNice, storyCards, type StoryCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import type { Card } from "./cards";
import type { Env } from "./env";
import type { Project } from "./projects";
import { activeSprint } from "./sprints";
import { storyChecks, type StoryChecks } from "./validation";
import type { Progress } from "./progress-stages";

export { PROGRESS_LABELS, PROGRESS_STAGES, isProgressStage, progressPill, type Progress, type ProgressStage } from "./progress-stages";

// A card's progress (la-fabrique#113): where its delivery stands, read from
// its stories (GitHub) and the sprint, never typed. The card's status says
// where the spec stands (Draft … Validated); its progress goes on from
// there, story by story, to production. Each change is written in the log
// with its date (principle 4); the stage last seen is kept on the card
// (`cards.progress`) to place it on the board and to notice the change.
const DEVELOPED = new Set(["on_int", "to_validate", "done"]);

// The stage, from the needed stories' stages: the furthest the whole card
// has reached. Null without a story, or for a dropped card.
export function progressOf(
  card: Pick<Card, "id" | "status" | "release">,
  links: StoryCards,
  stories: Map<number, CardStory>,
  checks: Map<number, StoryChecks>,
  sprintLane: string | null,
): Progress | null {
  if (card.status === "dropped") return null;
  const mine = links.order.get(card.id) ?? [];
  const needed = mine.filter((number) => !isNice(links, card.id, number));
  const counted = needed.length ? needed : mine;
  if (!counted.length) return null;
  const total = counted.length;
  const stageOf = (number: number) => {
    const story = stories.get(number);
    return story?.closed ? "done" : (story?.stage ?? null);
  };
  const out = counted.filter((number) => stageOf(number) === "done").length;
  if (out === total) return { stage: "in_production", done: out, total };
  const developed = counted.filter((number) => DEVELOPED.has(stageOf(number) ?? "")).length;
  if (developed === total) {
    const validated = counted.filter((number) => stageOf(number) === "done" || checks.get(number)?.validated).length;
    return { stage: "to_test", done: validated, total };
  }
  const started = counted.some((number) => stageOf(number) === "in_dev" || DEVELOPED.has(stageOf(number) ?? ""));
  if (started) return { stage: "in_dev", done: developed, total };
  const ready = counted.filter((number) => stageOf(number) === "ready").length;
  if (sprintLane !== null && card.release === sprintLane) return { stage: "in_sprint", done: ready, total };
  return ready === total ? { stage: "ready", done: ready, total } : { stage: "to_prepare", done: ready, total };
}

// The progress of each card, worked out from the stories; a change since
// the last time is kept on the card and written in the log, dated.
export async function cardProgress(env: Env, project: Project, cards: Card[], links?: StoryCards): Promise<Map<number, Progress>> {
  const found = new Map<number, Progress>();
  const storyLinks = links ?? (await storyCards(env.DB, project.repo));
  const live = cards.filter((card) => (storyLinks.order.get(card.id) ?? []).length || card.progress);
  if (!live.length) return found;
  const numbers = [...new Set(live.flatMap((card) => storyLinks.order.get(card.id) ?? []))];
  const [stories, checks, sprint] = await Promise.all([cardStories(env, project, numbers), storyChecks(env.DB, project.repo), activeSprint(env.DB, project.repo)]);
  const changes: D1PreparedStatement[] = [];
  for (const card of live) {
    const progress = progressOf(card, storyLinks, stories, checks, sprint?.release ?? null);
    if (progress) found.set(card.id, progress);
    const stage = progress?.stage ?? null;
    if (stage === card.progress) continue;
    changes.push(
      env.DB.prepare("UPDATE cards SET progress = ? WHERE id = ? AND repo = ?").bind(stage, card.id, project.repo),
      activityStatement(env.DB, {
        actor: "la-fabrique",
        action: "card_progress_changed",
        repo: project.repo,
        details: { card: card.id, title: card.title, from: card.progress, to: stage, done: progress?.done ?? 0, total: progress?.total ?? 0 },
      }),
    );
    card.progress = stage;
  }
  if (changes.length) await env.DB.batch(changes);
  return found;
}

// When a card reached its current stage, from the log.
export async function progressSince(db: D1Database, repo: string, card: number): Promise<{ to: string | null; at: string }[]> {
  const { results } = await db
    .prepare("SELECT occurred_at, details FROM activity_log WHERE repo = ? AND action = 'card_progress_changed' AND json_extract(details, '$.card') = ? ORDER BY id")
    .bind(repo, card)
    .all<{ occurred_at: string; details: string }>();
  return results.map((row) => ({ to: (JSON.parse(row.details) as { to: string | null }).to, at: row.occurred_at }));
}
