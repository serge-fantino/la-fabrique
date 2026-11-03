import { activityStatement } from "./activity-log";
import { boardReleases, compareVersions, isFixedLane, NEXT_RELEASE, SPRINT_LANE, type BoardRelease } from "./card-releases";
import { hasIntegration, proposeVersion } from "./sprint-release";
import { PRODUCTION, type ProductionStatus } from "./production";
import { readSnapshot } from "./snapshots";
import { isNice, storyCards, type StoryCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import { listCards, moveCard, type Card } from "./cards";
import type { Env } from "./env";
import { isFinished, isInDevelopment, isToTest } from "./lifecycle";
import type { Project } from "./projects";
import { activeSprint, type Sprint } from "./sprints";

// The sprint's life (la-fabrique#109): it takes the cards of Next release,
// and has no version while it runs. It ends only when someone closes it:
// each finished card then takes the version that shipped it, and a card not
// finished stays in the Sprint lane for the next sprint.
const NO_VALUES = { epic: [], domain: [], segment: [], release: [] };

async function moveCards(db: D1Database, cards: Card[], to: string, login: string, reason: string): Promise<void> {
  for (const card of cards) await moveCard(db, card, login, { set: { release: to }, before: null, after: null }, NO_VALUES, reason);
}

// The versions a new sprint may take: the next minor and major after the
// project's newest release (la-fabrique#174).
export async function sprintVersions(env: Env, project: Project): Promise<{ newest: string | null; minor: string | null; major: string | null; releases: BoardRelease[] }> {
  const releases = await boardReleases(env, project, []);
  const newest = releases.filter((release) => release.state === "shipped" && !isFixedLane(release.version)).sort((a, b) => compareVersions(a.version, b.version))[0]?.version ?? null;
  return { newest, minor: proposeVersion(newest, "minor"), major: proposeVersion(newest, "major"), releases };
}

// Why a version cannot be the sprint's, or null.
export function sprintVersionProblem(_project: Project, version: string, releases: BoardRelease[]): string | null {
  if (!version) return "Give the sprint its version.";
  if (!/^[0-9A-Za-z.-]{1,30}$/.test(version)) return `"${version}" is not a version: letters, digits, dots and dashes.`;
  // Any numbering, a major jump included (0.81 → 1.0): only ahead of what
  // is out or on its way.
  const out = releases.find((release) => release.state !== "planned" && !isFixedLane(release.version) && compareVersions(version, release.version) >= 0);
  return out ? `${version} is not ahead of ${out.version}, already ${out.state === "shipped" ? "out" : "in progress"}.` : null;
}

export async function startSprint(
  env: Env,
  project: Project,
  login: string,
  wanted: { version?: string | null; name?: string | null } = {},
): Promise<{ ok: true; cards: number } | { ok: false; message: string; reason: "running" | "empty" | "version" }> {
  const running = await activeSprint(env.DB, project.repo);
  if (running) return { ok: false, message: "A sprint is in progress: close it first.", reason: "running" };
  // Its version: the one asked for, else the next minor (none without a release yet).
  const versions = await sprintVersions(env, project);
  const version = wanted.version?.trim() || versions.minor;
  if (version) {
    const problem = sprintVersionProblem(project, version, versions.releases);
    if (problem) return { ok: false, message: problem, reason: "version" };
  }
  const name = wanted.name?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
  const all = (await listCards(env.DB, project.repo)).filter((card) => !card.archivedAt);
  // The cards kept in the Sprint lane by the last close come with the new ones.
  const next = all.filter((card) => card.release === NEXT_RELEASE);
  const kept = all.filter((card) => card.release === SPRINT_LANE);
  if (!next.length && !kept.length) return { ok: false, message: "Next release has no card: place the cards of the next sprint in it first.", reason: "empty" };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sprints (repo, release, started_by, version, name) VALUES (?, ?, ?, ?, ?)").bind(project.repo, SPRINT_LANE, login, version, name),
    activityStatement(env.DB, { actor: login, action: "sprint_started", repo: project.repo, details: { cards: [...kept, ...next].map((card) => card.id), version, name } }),
  ]);
  await moveCards(env.DB, next, SPRINT_LANE, login, "sprint started");
  return { ok: true, cards: next.length + kept.length };
}

export interface SprintCard {
  card: Card;
  stories: number[];
  done: boolean;
}

function isDone(stories: Map<number, CardStory>, number: number): boolean {
  const story = stories.get(number);
  return isFinished(story);
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

async function endWith(env: Env, project: Project, sprint: Sprint, login: string, reason: "closed", version: string | null): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare("UPDATE sprints SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_by = ?, end_reason = ?, release = ? WHERE id = ? AND ended_at IS NULL")
      .bind(login, reason, version ?? sprint.release, sprint.id),
    activityStatement(env.DB, {
      actor: login,
      action: "sprint_shipped",
      repo: project.repo,
      details: { release: version, reason },
    }),
  ]);
}

// Close the sprint, by hand: the cards done take the version that shipped
// them; the others stay in the Sprint lane for the next sprint.
// `released`: the version a go just put out (a project with integration):
// every finished card takes it.
export async function closeSprint(env: Env, project: Project, sprint: Sprint, login: string, released?: string): Promise<string | null> {
  const [cards, links, releases] = await Promise.all([listCards(env.DB, project.repo), storyCards(env.DB, project.repo), boardReleases(env, project, [])]);
  const mine = cards.filter((card) => card.release === SPRINT_LANE && !card.archivedAt);
  const stories = await cardStories(env, project, [...new Set(mine.flatMap((card) => links.order.get(card.id) ?? []))]);
  let newest: string | null = null;
  for (const card of mine) {
    const numbers = links.order.get(card.id) ?? [];
    const version = cardDone(links, stories, card.id) ? (released ?? shippedIn(releases, numbers)) : null;
    if (!version) continue;
    if (!newest || compareVersions(version, newest) < 0) newest = version;
    await moveCards(env.DB, [card], version, login, `shipped in ${version}`);
  }
  await endWith(env, project, sprint, login, "closed", newest);
  return newest;
}

// Reality first (la-fabrique#205): while a sprint runs, a card whose story
// is being developed or tested is in the sprint, even if nobody put it
// there: the work says where the card is. It joins the Sprint lane, with
// the reason in the card's history. A card on int under its own version
// keeps its lane, and so does a dropped or archived card. A shipped card
// comes back only for a story no shipped version declares, a new one or a
// nice to have taken up (la-fabrique#217); taking it out again is by hand.
// The cards given are updated in place.
export interface Joined {
  card: Card;
  stories: number[];
}

export interface JoinOutcome {
  // The sprint La Fabrique opened itself (la-fabrique#216), and why.
  opened: { version: string | null; stories: number[] } | null;
  joined: Joined[];
}

// No work on int without a sprint (la-fabrique#216): on a project with an
// integration branch, when int holds work production does not have (the
// last production read, not one marked stale) and no sprint runs, the
// sprint opens, with the next version after the newest release.
async function openForWorkOnInt(env: Env, project: Project, releases: Map<string, BoardRelease>): Promise<JoinOutcome["opened"]> {
  if (!hasIntegration(project)) return null;
  const snapshot = await readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION);
  if (!snapshot || snapshot.fetchedAt.startsWith("1970")) return null;
  const onInt = [...new Set((snapshot.data.groups ?? []).flatMap((group) => group.issues))].sort((a, b) => a - b);
  if (!onInt.length) return null;
  const newest = [...releases.values()].filter((release) => release.state === "shipped" && !isFixedLane(release.version)).sort((a, b) => compareVersions(a.version, b.version))[0]?.version ?? null;
  const version = proposeVersion(newest, "minor");
  const inserted = await env.DB.prepare(
    "INSERT INTO sprints (repo, release, started_by, version, name) SELECT ?, ?, 'la-fabrique', ?, NULL WHERE NOT EXISTS (SELECT 1 FROM sprints WHERE repo = ? AND ended_at IS NULL)",
  )
    .bind(project.repo, SPRINT_LANE, version, project.repo)
    .run();
  if (!inserted.meta.changes) return null;
  await activityStatement(env.DB, {
    actor: "la-fabrique",
    action: "sprint_started",
    repo: project.repo,
    details: { cards: [], version, name: null, forced: true, reason: "int holds work production does not", stories: onInt.slice(0, 20) },
  }).run();
  return { version, stories: onInt };
}

export async function joinSprint(
  env: Env,
  project: Project,
  cards: Card[],
  releases: Map<string, BoardRelease>,
  links?: StoryCards,
): Promise<JoinOutcome> {
  let sprint = await activeSprint(env.DB, project.repo);
  const opened = sprint ? null : await openForWorkOnInt(env, project, releases);
  if (opened) sprint = await activeSprint(env.DB, project.repo);
  if (!sprint || sprint.release !== SPRINT_LANE) return { opened, joined: [] };
  const storyLinks = links ?? (await storyCards(env.DB, project.repo));
  const shipped = (card: Card) => (card.release ? releases.get(card.release)?.state === "shipped" : false);
  // The stories a shipped version's notes declare: done, whatever their issue says.
  const declared = new Set([...releases.values()].filter((release) => release.state === "shipped").flatMap((release) => release.stories ?? []));
  const outside = (card: Card) => {
    if (card.archivedAt || card.status === "dropped" || card.release === SPRINT_LANE) return false;
    const release = card.release ? releases.get(card.release) : undefined;
    return !release || release.version === NEXT_RELEASE || release.state === "planned" || release.state === "shipped";
  };
  const candidates = cards.filter((card) => outside(card) && (storyLinks.order.get(card.id) ?? []).length);
  if (!candidates.length) return { opened, joined: [] };
  const stories = await cardStories(env, project, [...new Set(candidates.flatMap((card) => storyLinks.order.get(card.id) ?? []))]);
  const working = (number: number) => {
    const story = stories.get(number);
    return isInDevelopment(story) || isToTest(story);
  };
  const joined: Joined[] = [];
  for (const card of candidates) {
    const mine = (storyLinks.order.get(card.id) ?? []).filter((number) => working(number) && !(shipped(card) && declared.has(number)));
    if (!mine.length) continue;
    const why = mine.map((number) => `#${number} ${isToTest(stories.get(number)) ? "to test" : "in development"}`).join(", ");
    const from = shipped(card) ? ` (shipped in ${card.release})` : "";
    const moved = await moveCard(env.DB, card, "la-fabrique", { set: { release: SPRINT_LANE }, before: null, after: null }, NO_VALUES, `joined the sprint${from}: ${why}`);
    Object.assign(card, moved);
    joined.push({ card, stories: mine });
  }
  return { opened, joined };
}
