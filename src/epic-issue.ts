import { activityStatement } from "./activity-log";
import { type Card, listCards } from "./cards";
import { setFeatureEpic } from "./card-epics";
import type { Env } from "./env";
import { githubPatch, githubPost, installationToken } from "./github-app";
import type { Project } from "./projects";
import { applyIssueEvent, type RestIssue, type Story } from "./stories";

// An epic card started from an existing GitHub epic issue (la-fabrique#287).
// The card links to the issue (`card_links`, kind `epic_issue`); the issue's
// text is never copied. The issue's stories are its sub-issues: each one
// linked to a feature card attaches that feature to the epic; the others are
// shown under "No feature". A feature already in another epic is left there
// and reported. An issue is picked by one epic card at most.

export const EPIC_LABEL = "epique";
export const EPIC_ISSUE_KIND = "epic_issue";

export const epicIssuesOf = (stories: Story[]): Story[] => stories.filter((story) => story.labels.includes(EPIC_LABEL)).sort((a, b) => b.number - a.number);

export const subIssuesOf = (stories: Story[], issue: number): Story[] => stories.filter((story) => story.parent === issue).sort((a, b) => a.number - b.number);

// The epic issues no epic card has picked yet.
export async function takenEpicIssues(db: D1Database, repo: string): Promise<Map<number, number>> {
  const { results } = await db
    .prepare("SELECT l.ref AS ref, l.card_id AS card FROM card_links l JOIN cards c ON c.id = l.card_id WHERE c.repo = ? AND l.kind = ?")
    .bind(repo, EPIC_ISSUE_KIND)
    .all<{ ref: string; card: number }>();
  return new Map(results.map((row) => [Number(row.ref), row.card]));
}

// Story number -> the live feature cards it is linked to.
export async function featuresOfStories(db: D1Database, repo: string): Promise<Map<number, number[]>> {
  const { results } = await db
    .prepare(
      `SELECT l.ref AS ref, c.id AS id FROM card_links l JOIN cards c ON c.id = l.card_id
       WHERE c.repo = ? AND l.kind = 'story' AND c.kind = 'feature' AND c.archived_at IS NULL ORDER BY c.position, c.id`,
    )
    .bind(repo)
    .all<{ ref: string; id: number }>();
  const map = new Map<number, number[]>();
  for (const row of results) map.set(Number(row.ref), [...(map.get(Number(row.ref)) ?? []), row.id]);
  return map;
}

export interface EpicIssueView {
  number: number;
  title: string;
  url: string;
  noFeature: { number: number; title: string; url: string }[];
}

export async function epicIssueView(db: D1Database, repo: string, issue: number, stories: Story[]): Promise<EpicIssueView> {
  const found = stories.find((story) => story.number === issue);
  const features = await featuresOfStories(db, repo);
  return {
    number: issue,
    title: found?.title ?? `#${issue}`,
    url: found?.url ?? `https://github.com/${repo}/issues/${issue}`,
    noFeature: subIssuesOf(stories, issue)
      .filter((story) => !features.get(story.number)?.length)
      .map((story) => ({ number: story.number, title: story.title, url: story.url })),
  };
}

export interface EpicIssueResult {
  linked: boolean;
  reason?: "unknown" | "taken";
  attached: number[];
  // Features that keep another epic: [feature, its epic].
  kept: [number, string][];
}

// Links `epic` to the issue and attaches the features of its stories.
export async function startFromIssue(db: D1Database, epic: Card, issue: number, stories: Story[], login: string, via?: string): Promise<EpicIssueResult> {
  const found = epicIssuesOf(stories).find((story) => story.number === issue);
  if (!found) return { linked: false, reason: "unknown", attached: [], kept: [] };
  if ((await takenEpicIssues(db, epic.repo)).has(issue)) return { linked: false, reason: "taken", attached: [], kept: [] };
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, ?, ?)").bind(epic.id, EPIC_ISSUE_KIND, String(issue)),
    activityStatement(db, { actor: login, action: "epic_issue_linked", repo: epic.repo, details: { card: epic.id, issue, ...(via ? { via } : {}) } }),
  ]);
  const cards = await listCards(db, epic.repo);
  const features = await featuresOfStories(db, epic.repo);
  const attached: number[] = [];
  const kept: [number, string][] = [];
  for (const story of subIssuesOf(stories, issue)) {
    for (const id of features.get(story.number) ?? []) {
      const feature = cards.find((card) => card.id === id);
      if (!feature || attached.includes(id) || kept.some(([k]) => k === id)) continue;
      if (feature.epic?.trim() && feature.epic.trim().toLowerCase() !== epic.title.trim().toLowerCase()) {
        kept.push([id, feature.epic]);
        continue;
      }
      await setFeatureEpic(db, feature, epic.title, login, "document");
      attached.push(id);
    }
  }
  return { linked: true, attached, kept };
}

// The epic's technical GitHub issue, written through the MCP server (la-fabrique#310).
// The card holds the functional document; the issue holds how to build it. The
// issue's text is what Claude passes, never the card's document; it is signed with
// the person's login and links back to the card. A GitHub failure is reported,
// never thrown: the card is already written.
export interface EpicIssueWrite {
  number?: number;
  url?: string;
  created?: boolean;
  updated?: boolean;
  error?: string;
}

export function epicIssueBody(technical: string, epic: Card, permalink: string, login: string): string {
  return `${technical.trim()}\n\n---\nEpic card [C${epic.id}, document version ${epic.rev}](${permalink}) in La Fabrique extraordinaire (the functional document: what and why). Written by Claude for @${login}.`;
}

export async function writeEpicIssue(
  env: Env,
  project: Project,
  db: D1Database,
  epic: Card,
  technical: string,
  permalink: string,
  login: string,
): Promise<EpicIssueWrite> {
  try {
    const token = await installationToken(env, project.installationId);
    const body = epicIssueBody(technical, epic, permalink, login);
    const linked = await db
      .prepare("SELECT ref FROM card_links WHERE card_id = ? AND kind = ?")
      .bind(epic.id, EPIC_ISSUE_KIND)
      .first<{ ref: string }>();
    const existing = linked ? Number(linked.ref) : 0;
    if (existing) {
      const response = await githubPatch(token, `/repos/${project.repo}/issues/${existing}`, { body });
      if (!response.ok) return { number: existing, error: `GitHub refused to update the epic issue #${existing} (HTTP ${response.status}).` };
      const issue = (await response.json()) as RestIssue;
      await activityStatement(db, { actor: login, action: "epic_issue_updated", repo: epic.repo, issueNumber: existing, details: { card: epic.id, issue: existing, via: "claude" } }).run();
      await applyIssueEvent(env, project.repo, "edited", issue);
      return { number: existing, url: issue.html_url, updated: true };
    }
    const response = await githubPost(token, `/repos/${project.repo}/issues`, { title: epic.title, body, labels: [EPIC_LABEL] });
    if (!response.ok) return { error: `GitHub refused to create the epic issue (HTTP ${response.status}).` };
    const issue = (await response.json()) as RestIssue;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, ?, ?)").bind(epic.id, EPIC_ISSUE_KIND, String(issue.number)),
      activityStatement(db, { actor: login, action: "epic_issue_linked", repo: epic.repo, issueNumber: issue.number, details: { card: epic.id, issue: issue.number, via: "claude", created: true } }),
    ]);
    await applyIssueEvent(env, project.repo, "opened", issue);
    return { number: issue.number, url: issue.html_url, created: true };
  } catch (error) {
    return { error: `The epic issue was not written: ${error instanceof Error ? error.message : "GitHub error"}.` };
  }
}
