import { activityStatement } from "./activity-log";
import { NEXT_RELEASE } from "./card-releases";
import { findEpicByTitle } from "./card-epics";
import { type Card, cardLinks, listCards } from "./cards";
import { EPIC_ISSUE_KIND, EPIC_LABEL } from "./epic-issue";
import type { Env } from "./env";
import { githubFetch, githubPost, installationToken } from "./github-app";
import type { Project } from "./projects";
import { cardPermalink } from "./card-views";

// An epic created from scratch lives only in La Fabrique (la-fabrique#288).
// Its `epique` issue is created, without a button, when the first feature
// attached to it enters refinement (is placed in Next release); the issue
// holds the title, a short abstract and a link to the card, never the
// document. From then on a story made from one of its features becomes a
// sub-issue of that issue. Both are done with the App's token, the body
// naming the person.

export const ABSTRACT_MAX = 400;

// The abstract: the Why section, else the first paragraph, cut short.
export function epicAbstract(body: string): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const why = /^##\s+Why\s*\n+([\s\S]*?)(?=\n##\s|(?![\s\S]))/im.exec(text)?.[1] ?? "";
  const first = (why.trim() || text.replace(/^##[^\n]*\n+/, "")).split(/\n\s*\n/)[0]?.trim() ?? "";
  const flat = first.replace(/\s+/g, " ");
  return flat.length > ABSTRACT_MAX ? `${flat.slice(0, ABSTRACT_MAX - 1).trimEnd()}…` : flat;
}

export function epicIssueBody(epic: Card, login: string, link: string): string {
  const abstract = epicAbstract(epic.body);
  return [abstract, `Epic card in La Fabrique: ${link}`, `_Created by La Fabrique for @${login}. The full document stays on the card._`].filter(Boolean).join("\n\n");
}

export async function epicIssueOf(db: D1Database, epic: Card): Promise<number | null> {
  const link = (await cardLinks(db, epic.id)).find((l) => l.kind === EPIC_ISSUE_KIND);
  return link ? Number(link.ref) || null : null;
}

// Called when a feature may have entered Next release. Returns the number of
// the issue created, if one was.
export async function ensureEpicIssue(env: Env, project: Project, feature: Card, login: string, base: string): Promise<number | null> {
  if (feature.kind !== "feature" || feature.release !== NEXT_RELEASE || !feature.epic?.trim() || feature.archivedAt) return null;
  const epic = findEpicByTitle(await listCards(env.DB, project.repo), feature.epic);
  if (!epic || (await epicIssueOf(env.DB, epic))) return null;
  try {
    const token = await installationToken(env, project.installationId);
    const response = await githubPost(token, `/repos/${project.repo}/issues`, {
      title: epic.title,
      body: epicIssueBody(epic, login, new URL(cardPermalink(epic.id), base).toString()),
      labels: [EPIC_LABEL],
    });
    if (!response.ok) return null;
    const issue = (await response.json()) as { number: number; html_url: string };
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, ?, ?)").bind(epic.id, EPIC_ISSUE_KIND, String(issue.number)),
      activityStatement(env.DB, { actor: login, action: "epic_issue_created", repo: project.repo, issueNumber: issue.number, details: { card: epic.id, issue: issue.number, url: issue.html_url, feature: feature.id } }),
    ]);
    return issue.number;
  } catch {
    return null;
  }
}

// A story made from `feature` becomes a sub-issue of its epic's issue.
export async function fileUnderEpic(env: Env, project: Project, feature: Card, story: number): Promise<boolean> {
  if (feature.kind !== "feature" || !feature.epic?.trim()) return false;
  const epic = findEpicByTitle(await listCards(env.DB, project.repo), feature.epic);
  const parent = epic ? await epicIssueOf(env.DB, epic) : null;
  if (!parent) return false;
  try {
    const token = await installationToken(env, project.installationId);
    const issue = await githubFetch(token, `/repos/${project.repo}/issues/${story}`);
    if (!issue.ok) return false;
    const { id } = (await issue.json()) as { id: number };
    const added = await githubPost(token, `/repos/${project.repo}/issues/${parent}/sub_issues`, { sub_issue_id: id });
    return added.ok;
  } catch {
    return false;
  }
}
