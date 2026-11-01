import { activityStatement } from "./activity-log";
import { compareVersions, SPRINT_LANE, type BoardRelease } from "./card-releases";
import { isNice, type StoryCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import { listCards, moveCard, type Card } from "./cards";
import type { Env } from "./env";
import { dispatchRefusal, githubFetch, githubPatch, githubPost, installationToken } from "./github-app";
import { productionBranch, type Project } from "./projects";
import type { Release } from "./roadmap";
import { storyChecks, type StoryChecks } from "./validation";
import { wordingFor } from "./wording";
import { applyIssueEvent, type RestIssue } from "./stories";
import type { RestWorkflowRun } from "./claude";
import { activeSprint, type Sprint } from "./sprints";
import { sprintLiveFor } from "./live";
import { runFailure } from "./sprint-pulls";

// Closing the sprint on a project without an integration branch makes the
// release (la-fabrique#137): one version, one release note, written by the
// project's own workflow (`workflows.publier`); La Fabrique writes nothing on
// a branch. For now a story is done when it is validated in To test.
export function publishWorkflow(project: Project): string | null {
  const file = project.check?.config?.workflows?.["publier"];
  return typeof file === "string" ? file : null;
}

export function hasIntegration(project: Project): boolean {
  const integration = project.check?.config?.branches?.integration;
  return typeof integration === "string" && integration !== productionBranch(project);
}

export type ReleaseKind = "minor" | "major";

// "0.78" → minor "0.79", major "1.0"; "v1.169" → "v1.170", "v2.0".
export function proposeVersion(newest: string | null, kind: ReleaseKind): string | null {
  if (!newest) return null;
  const digits = [...newest.matchAll(/\d+/g)];
  if (!digits.length) return null;
  if (kind === "minor") {
    const last = digits[digits.length - 1]!;
    return `${newest.slice(0, last.index)}${Number(last[0]) + 1}${newest.slice(last.index + last[0].length)}`;
  }
  const first = digits[0]!;
  let out = `${newest.slice(0, first.index)}${Number(first[0]) + 1}`;
  let cursor = first.index + first[0].length;
  for (const next of digits.slice(1)) {
    out += `${newest.slice(cursor, next.index)}0`;
    cursor = next.index + next[0].length;
  }
  return out + newest.slice(cursor);
}

export interface PlannedCard {
  card: Card;
  done: boolean;
  // Why it stays, when it does.
  reason: string | null;
  stories: { number: number; title: string; done: boolean; reason: string | null }[];
}

export interface PlannedEntry {
  title: string | null;
  stories: number[];
  taken: boolean;
  reason: string | null;
  // Taken, but some of its stories are not done: it goes out with a caveat.
  partial: boolean;
  missing: { number: number; title: string }[];
  caveat: string | null;
}

export interface ReleasePlan {
  newest: string | null;
  minor: string | null;
  major: string | null;
  title: string;
  cards: PlannedCard[];
  // The `next` release-note entries: released or kept.
  entries: PlannedEntry[];
  // The validated stories of the done cards: closed once the release is out.
  stories: number[];
  // Merged stories not done (their change is online but stays for a later release).
  notDone: { number: number; title: string }[];
}

function storyReason(story: CardStory | undefined, validated: boolean): string | null {
  if (validated) return null;
  if (!story) return "not found on GitHub";
  if (story.stage === "to_validate") return "merged, not validated in To test";
  return "not merged yet";
}

export function proposeTitle(cards: Card[]): string {
  const titles = cards.map((card) => card.title.trim()).filter(Boolean);
  const text = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}` : (titles[0] ?? "");
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

// What the release takes and what stays, each with its reason. Pure.
export function planRelease(input: {
  cards: Card[];
  links: StoryCards;
  stories: Map<number, CardStory>;
  checks: Map<number, StoryChecks>;
  notes: Release[];
  releases: BoardRelease[];
}): ReleasePlan {
  const validated = (number: number) => Boolean(input.checks.get(number)?.validated) || Boolean(input.stories.get(number)?.closed);
  const cards = input.cards.map((card): PlannedCard => {
    const numbers = input.links.order.get(card.id) ?? [];
    const stories = numbers.map((number) => {
      const ok = validated(number);
      return { number, title: input.stories.get(number)?.title ?? `#${number}`, done: ok, reason: storyReason(input.stories.get(number), ok) };
    });
    const needed = stories.filter((story) => !isNice(input.links, card.id, story.number));
    const done = stories.length > 0 && (needed.length ? needed : stories).every((story) => story.done);
    return {
      card,
      done,
      stories,
      reason: done ? null : stories.length ? `needed stories not validated in To test: ${(needed.length ? needed : stories).filter((story) => !story.done).map((story) => `#${story.number}`).join(", ")}` : "no story",
    };
  });
  const doneStories = new Set(cards.filter((planned) => planned.done).flatMap((planned) => planned.stories.filter((story) => story.done).map((story) => story.number)));
  // An entry is released when it declares a story done, even if its card is not finished.
  const validatedStories = new Set(cards.flatMap((planned) => planned.stories.filter((story) => story.done).map((story) => story.number)));
  const entries = input.notes
    .filter((note) => note.version === "next")
    .map((note): PlannedEntry => {
      const declared = note.stories ?? [];
      const taken = declared.some((number) => validatedStories.has(number));
      const missing = taken ? declared.filter((number) => !validatedStories.has(number)).map((number) => ({ number, title: input.stories.get(number)?.title ?? `#${number}` })) : [];
      return {
        title: note.title,
        stories: declared,
        taken,
        reason: taken ? null : declared.length ? "declares only stories not done" : "declares no story",
        partial: missing.length > 0,
        missing,
        caveat: missing.length ? `Partial: not done yet, ${missing.map((story) => `#${story.number} ${story.title}`).join("; ")}.` : null,
      };
    });
  const newest = input.releases.filter((release) => release.state === "shipped").sort((a, b) => compareVersions(a.version, b.version))[0]?.version ?? null;
  return {
    newest,
    minor: proposeVersion(newest, "minor"),
    major: proposeVersion(newest, "major"),
    title: proposeTitle(cards.filter((planned) => planned.done).map((planned) => planned.card)),
    cards,
    entries,
    stories: [...doneStories],
    notDone: cards.flatMap((planned) =>
      planned.stories
        .filter((story) => !story.done && input.stories.get(story.number)?.stage === "to_validate")
        .map((story) => ({ number: story.number, title: story.title })),
    ),
  };
}

export async function sprintCardsOf(env: Env, project: Project): Promise<Card[]> {
  const all = await listCards(env.DB, project.repo);
  return all.filter((card) => card.release === SPRINT_LANE && !card.archivedAt).sort((a, b) => a.position - b.position || a.id - b.id);
}

export async function loadPlan(env: Env, project: Project, links: StoryCards, notes: Release[], releases: BoardRelease[]): Promise<ReleasePlan> {
  const cards = await sprintCardsOf(env, project);
  const [stories, checks] = await Promise.all([
    cardStories(env, project, [...new Set(cards.flatMap((card) => links.order.get(card.id) ?? []))]),
    storyChecks(env.DB, project.repo),
  ]);
  return planRelease({ cards, links, stories, checks, notes, releases });
}

const NO_VALUES = { epic: [], domain: [], segment: [], release: [] };

// Confirmed: log the close and start the project's release workflow with the
// version, the title, the stories and the cards. The sprint stays open until
// the release is out.
export async function startRelease(
  env: Env,
  project: Project,
  login: string,
  plan: ReleasePlan,
  version: string,
  title: string,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const file = publishWorkflow(project);
  if (!file) return { ok: false, message: "This project declares no release workflow (workflows.publier).", status: 422 };
  const done = plan.cards.filter((planned) => planned.done);
  if (!done.length && !plan.entries.some((entry) => entry.taken)) return { ok: false, message: "No card is done: there is nothing to release.", status: 422 };
  const details = {
    version,
    title,
    workflow: file,
    cards: done.map((planned) => planned.card.id),
    stories: plan.stories,
    kept_cards: plan.cards.filter((planned) => !planned.done).map((planned) => planned.card.id),
    kept_entries: plan.entries.filter((entry) => !entry.taken).map((entry) => entry.title),
    partial_entries: plan.entries.filter((entry) => entry.partial).map((entry) => ({ title: entry.title, caveat: entry.caveat })),
    kept_stories: plan.notDone.map((story) => story.number),
  };
  try {
    const token = await installationToken(env, project.installationId);
    const ref = productionBranch(project) ?? "main";
    const response = await githubPost(token, `/repos/${project.repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
      ref,
      inputs: { version, titre: title, stories: plan.stories.join(","), par: login },
    });
    if (!response.ok) return { ok: false, message: dispatchRefusal(file, ref, response.status, "accept workflow_dispatch"), status: 502 };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }
  await env.DB.batch([
    activityStatement(env.DB, { actor: login, action: "sprint_close_requested", repo: project.repo, details }),
    activityStatement(env.DB, { actor: login, action: "release_started", repo: project.repo, details }),
  ]);
  return { ok: true };
}

// The release workflow ended well (webhook workflow_run): the sprint closes,
// each card done takes the version, its validated stories are closed with a
// word, all in the log. Once per release started.
export async function releaseRunEvent(env: Env, project: Project, action: string, run: RestWorkflowRun): Promise<boolean> {
  const file = publishWorkflow(project);
  if (!file || !run.path?.endsWith(`/${file}`)) return false;
  // The sprint page follows the run: started, in progress, ended.
  await sprintLiveFor(env, project.repo)?.notify({ kind: "pull_request", issue: null, status: `release ${action}`, conclusion: run.conclusion ?? null, url: run.html_url ?? "", at: new Date().toISOString() });
  if (action !== "completed") return false;
  const started = await env.DB.prepare("SELECT id, details FROM activity_log WHERE repo = ? AND action = 'release_started' ORDER BY id DESC LIMIT 1")
    .bind(project.repo)
    .first<{ id: number; details: string | null }>();
  if (!started) return false;
  const out = await env.DB.prepare("SELECT 1 AS found FROM activity_log WHERE repo = ? AND action IN ('release_published', 'release_failed') AND id > ?").bind(project.repo, started.id).first();
  if (out) return false;
  const details = started.details ? (JSON.parse(started.details) as Record<string, unknown>) : {};
  const version = typeof details["version"] === "string" ? details["version"] : null;
  if (!version) return false;
  // Refused or failed: why, from the run; the sprint stays open.
  if (run.conclusion !== "success") {
    const reason = run.id ? await runFailure(env, project, run.id, "Release refused") : null;
    await activityStatement(env.DB, { actor: "github", action: "release_failed", repo: project.repo, details: { version, reason, conclusion: run.conclusion ?? null, run: run.html_url ?? null } }).run();
    return true;
  }
  const numbers = (value: unknown) => (Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : []);
  const cardIds = numbers(details["cards"]);
  const stories = numbers(details["stories"]);
  const sprint = await activeSprint(env.DB, project.repo);
  await closeAfterRelease(env, project, sprint, version);
  await activityStatement(env.DB, { actor: "github", action: "release_published", repo: project.repo, details: { version, run: run.html_url ?? null, cards: cardIds, stories } }).run();
  const cards = (await listCards(env.DB, project.repo)).filter((card) => cardIds.includes(card.id));
  for (const card of cards) {
    await moveCard(env.DB, card, "github", { set: { release: version }, before: null, after: null }, NO_VALUES, `shipped in ${version}`);
    await activityStatement(env.DB, { actor: "github", action: "card_versioned", repo: project.repo, details: { card: card.id, version } }).run();
  }
  const words = wordingFor(project);
  const token = await installationToken(env, project.installationId);
  for (const number of stories) {
    const response = await githubFetch(token, `/repos/${project.repo}/issues/${number}`);
    if (!response.ok) continue;
    const issue = (await response.json()) as RestIssue;
    if (issue.state === "closed") continue;
    await githubPost(token, `/repos/${project.repo}/issues/${number}/comments`, { body: words.inVersion(version) });
    const patched = await githubPatch(token, `/repos/${project.repo}/issues/${number}`, { state: "closed", state_reason: "completed" });
    if (!patched.ok) continue;
    await applyIssueEvent(env, project.repo, "closed", { ...issue, state: "closed", closed_at: new Date().toISOString() });
    await activityStatement(env.DB, { actor: "github", action: "story_closed", repo: project.repo, issueNumber: number, details: { version } }).run();
  }
  return true;
}

async function closeAfterRelease(env: Env, project: Project, sprint: Sprint | null, version: string): Promise<void> {
  if (!sprint) return;
  await env.DB.prepare("UPDATE sprints SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_by = 'github', end_reason = 'closed', release = ? WHERE id = ? AND ended_at IS NULL")
    .bind(version, sprint.id)
    .run();
  await activityStatement(env.DB, { actor: "github", action: "sprint_shipped", repo: project.repo, details: { release: version, reason: "closed" } }).run();
}

export interface ReleaseAttempt {
  version: string | null;
  state: "running" | "published" | "failed";
  reason: string | null;
  run: string | null;
  at: string;
  by: string;
}

// The last release started from the sprint, and where it stands, from the log.
export async function lastReleaseAttempt(db: D1Database, repo: string): Promise<ReleaseAttempt | null> {
  const started = await db
    .prepare("SELECT id, occurred_at, actor, details FROM activity_log WHERE repo = ? AND action = 'release_started' ORDER BY id DESC LIMIT 1")
    .bind(repo)
    .first<{ id: number; occurred_at: string; actor: string; details: string | null }>();
  if (!started) return null;
  const details = started.details ? (JSON.parse(started.details) as Record<string, unknown>) : {};
  const after = await db
    .prepare("SELECT action, details FROM activity_log WHERE repo = ? AND action IN ('release_published', 'release_failed') AND id > ? ORDER BY id LIMIT 1")
    .bind(repo, started.id)
    .first<{ action: string; details: string | null }>();
  const end = after?.details ? (JSON.parse(after.details) as Record<string, unknown>) : {};
  return {
    version: typeof details["version"] === "string" ? details["version"] : null,
    state: !after ? "running" : after.action === "release_published" ? "published" : "failed",
    reason: typeof end["reason"] === "string" ? end["reason"] : null,
    run: typeof end["run"] === "string" ? end["run"] : null,
    at: started.occurred_at,
    by: started.actor,
  };
}
