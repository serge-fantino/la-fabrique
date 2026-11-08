import { activityStatement } from "./activity-log";
import { type Card, listCards } from "./cards";
import { setFeatureEpic } from "./card-epics";
import type { Story } from "./stories";

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
export async function startFromIssue(db: D1Database, epic: Card, issue: number, stories: Story[], login: string): Promise<EpicIssueResult> {
  const found = epicIssuesOf(stories).find((story) => story.number === issue);
  if (!found) return { linked: false, reason: "unknown", attached: [], kept: [] };
  if ((await takenEpicIssues(db, epic.repo)).has(issue)) return { linked: false, reason: "taken", attached: [], kept: [] };
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, ?, ?)").bind(epic.id, EPIC_ISSUE_KIND, String(issue)),
    activityStatement(db, { actor: login, action: "epic_issue_linked", repo: epic.repo, details: { card: epic.id, issue } }),
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
