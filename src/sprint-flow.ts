import { activityStatement } from "./activity-log";
import { boardReleases, compareVersions, NEXT_RELEASE, SPRINT_LANE, type BoardRelease } from "./card-releases";
import { isNice, storyCards, type StoryCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import { listCards, moveCard, type Card } from "./cards";
import type { Env } from "./env";
import type { Project } from "./projects";
import { activeSprint, type Sprint } from "./sprints";

// The sprint's life (la-fabrique#109): it takes the cards of Next release,
// and has no version while it runs. It closes when every needed story of
// its cards is in production: each card then takes the version that
// shipped it, and what is not done goes back to Next release.
const NO_VALUES = { epic: [], domain: [], segment: [], release: [] };

async function moveCards(db: D1Database, cards: Card[], to: string, login: string, reason: string): Promise<void> {
  for (const card of cards) await moveCard(db, card, login, { set: { release: to }, before: null, after: null }, NO_VALUES, reason);
}

export async function startSprint(env: Env, project: Project, login: string): Promise<{ ok: true; cards: number } | { ok: false; message: string }> {
  const running = await activeSprint(env.DB, project.repo);
  if (running) return { ok: false, message: "A sprint is in progress: close or stop it first." };
  const next = (await listCards(env.DB, project.repo)).filter((card) => card.release === NEXT_RELEASE && !card.archivedAt);
  if (!next.length) return { ok: false, message: "Next release has no card: place the cards of the next sprint in it first." };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, ?, ?)").bind(project.repo, SPRINT_LANE, login),
    activityStatement(env.DB, { actor: login, action: "sprint_started", repo: project.repo, details: { cards: next.map((card) => card.id) } }),
  ]);
  await moveCards(env.DB, next, SPRINT_LANE, login, "sprint started");
  return { ok: true, cards: next.length };
}

export interface SprintCard {
  card: Card;
  stories: number[];
  done: boolean;
}

function isDone(stories: Map<number, CardStory>, number: number): boolean {
  const story = stories.get(number);
  return story?.stage === "done" || Boolean(story?.closed);
}

// A card is done when it has stories and every needed one (all of them when
// all are nice to have) is in production or closed.
export function cardDone(links: StoryCards, stories: Map<number, CardStory>, card: number): boolean {
  const mine = links.order.get(card) ?? [];
  const needed = mine.filter((number) => !isNice(links, card, number));
  return mine.length > 0 && (needed.length ? needed : mine).every((number) => isDone(stories, number));
}

// The version that shipped a card: the newest shipped release whose notes
// declare one of its stories, else the newest shipped release.
export function shippedIn(releases: BoardRelease[], stories: number[]): string | null {
  const shipped = releases.filter((release) => release.state === "shipped").sort((a, b) => compareVersions(a.version, b.version));
  return (shipped.find((release) => (release.stories ?? []).some((number) => stories.includes(number))) ?? shipped[0])?.version ?? null;
}

async function endWith(env: Env, project: Project, sprint: Sprint, login: string, reason: "shipped" | "closed" | "stopped", version: string | null): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare("UPDATE sprints SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_by = ?, end_reason = ?, release = ? WHERE id = ? AND ended_at IS NULL")
      .bind(login, reason, version ?? sprint.release, sprint.id),
    activityStatement(env.DB, {
      actor: login,
      action: reason === "stopped" ? "sprint_stopped" : "sprint_shipped",
      repo: project.repo,
      details: { release: version, reason },
    }),
  ]);
}

// Close the sprint: the cards done take the version that shipped them, the
// others go back to Next release. By hand ("closed"), or by itself once
// everything needed is out ("shipped").
export async function closeSprint(env: Env, project: Project, sprint: Sprint, login: string, reason: "shipped" | "closed"): Promise<string | null> {
  const [cards, links, releases] = await Promise.all([listCards(env.DB, project.repo), storyCards(env.DB, project.repo), boardReleases(env, project, [])]);
  const mine = cards.filter((card) => card.release === SPRINT_LANE && !card.archivedAt);
  const stories = await cardStories(env, project, [...new Set(mine.flatMap((card) => links.order.get(card.id) ?? []))]);
  let newest: string | null = null;
  for (const card of mine) {
    const numbers = links.order.get(card.id) ?? [];
    const version = cardDone(links, stories, card.id) ? shippedIn(releases, numbers) : null;
    if (version && (!newest || compareVersions(version, newest) < 0)) newest = version;
    await moveCards(env.DB, [card], version ?? NEXT_RELEASE, login, version ? `shipped in ${version}` : "not done when the sprint closed");
  }
  await endWith(env, project, sprint, login, reason, newest);
  return newest;
}

// Stop the sprint: it did not happen; its cards go back to Next release.
export async function stopSprint(env: Env, project: Project, sprint: Sprint, login: string): Promise<void> {
  const mine = (await listCards(env.DB, project.repo)).filter((card) => card.release === SPRINT_LANE && !card.archivedAt);
  await moveCards(env.DB, mine, NEXT_RELEASE, login, "sprint stopped");
  await endWith(env, project, sprint, login, "stopped", null);
}

// Read when the board or the sprint is shown: a sprint whose needed stories
// are all in production closes by itself.
export async function settleSprint(env: Env, project: Project): Promise<void> {
  const sprint = await activeSprint(env.DB, project.repo);
  if (!sprint || sprint.release !== SPRINT_LANE) return;
  const mine = (await listCards(env.DB, project.repo)).filter((card) => card.release === SPRINT_LANE && !card.archivedAt);
  if (!mine.length) return;
  const links = await storyCards(env.DB, project.repo);
  const stories = await cardStories(env, project, [...new Set(mine.flatMap((card) => links.order.get(card.id) ?? []))]);
  if (mine.every((card) => cardDone(links, stories, card.id))) await closeSprint(env, project, sprint, "la-fabrique", "shipped");
}
