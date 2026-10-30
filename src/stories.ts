import type { Env } from "./env";
import { githubAll, installationToken } from "./github-app";
import { describeFailure, type Project } from "./projects";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";

export const STORIES = "stories";
const MAX_AGE_MS = 10 * 60 * 1000;

export interface LinkedPull {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
}

export interface Story {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  author: string | null;
  labels: string[];
  parent: number | null;
  subTotal: number;
  subCompleted: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pullRequests: LinkedPull[];
  branches: string[];
  // Missing from snapshots written before acceptance criteria were read.
  criteria?: Criterion[];
}

export interface Criterion {
  text: string;
  done: boolean;
}

export interface RestIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  labels: (string | { name?: string })[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body?: string | null;
  pull_request?: unknown;
  parent_issue_url?: string | null;
  sub_issues_summary?: { total: number; completed: number };
}

interface RestPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
}

function parentNumber(url: string | null | undefined): number | null {
  const match = url ? /\/issues\/(\d+)$/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

export function issueRefs(text: string): number[] {
  return [...text.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
}

// Working branches carry their issue number (`.fabrique.json`, branches.travail).
export function branchIssue(name: string): number | null {
  const match = /(?:^|[/_-])(\d+)(?=$|[/_-])/.exec(name);
  return match ? Number(match[1]) : null;
}

const CRITERIA_HEADING = /^#{1,6}\s*(acceptance criteria|crit[eè]res d['’]acceptation)\b/i;
const MAX_CRITERIA = 30;

interface CriterionLine extends Criterion {
  line: number;
}

// The lines under the "Acceptance criteria" (or "Critères d'acceptation")
// heading of an issue: list items (task-list items keep their checked
// state) or plain lines, as a request form writes them.
function criteriaLines(lines: string[]): CriterionLine[] {
  const criteria: CriterionLine[] = [];
  let inside = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    if (/^#{1,6}\s/.test(line)) {
      if (inside) break;
      inside = CRITERIA_HEADING.test(line);
      continue;
    }
    if (!inside) continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) break;
    const item = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/.exec(line);
    const text = item ? item[2] : line.trim();
    if (!text || text === "—") continue;
    criteria.push({ line: index, text: text.slice(0, 300), done: (item?.[1] ?? " ").toLowerCase() === "x" });
    if (criteria.length >= MAX_CRITERIA) break;
  }
  return criteria;
}

export function acceptanceCriteria(body: string | null | undefined): Criterion[] {
  return criteriaLines((body ?? "").split("\n")).map(({ text, done }) => ({ text, done }));
}

// The body with criterion `index` (whose text must still be `text`) ticked
// or not, written as a task-list item; null when the issue changed.
export function setCriterion(body: string, index: number, text: string, done: boolean): string | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const criterion = criteriaLines(lines)[index];
  if (!criterion || criterion.text !== text) return null;
  const line = lines[criterion.line] ?? "";
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const bullet = /^\s*([-*+])\s/.exec(line)?.[1] ?? "-";
  lines[criterion.line] = `${indent}${bullet} [${done ? "x" : " "}] ${criterion.text}`;
  return lines.join("\n");
}

export function toStory(issue: RestIssue, links?: Pick<Story, "pullRequests" | "branches">): Story {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state === "closed" ? "closed" : "open",
    url: issue.html_url,
    author: issue.user?.login.toLowerCase() ?? null,
    labels: issue.labels
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter((label) => label.length > 0),
    parent: parentNumber(issue.parent_issue_url),
    subTotal: issue.sub_issues_summary?.total ?? 0,
    subCompleted: issue.sub_issues_summary?.completed ?? 0,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    pullRequests: links?.pullRequests ?? [],
    branches: links?.branches ?? [],
    criteria: acceptanceCriteria(issue.body),
  };
}

async function fetchStories(env: Env, project: Project): Promise<Story[]> {
  const token = await installationToken(env, project.installationId);
  const repo = project.repo;
  const [issues, pulls, branches] = await Promise.all([
    githubAll<RestIssue>(token, `/repos/${repo}/issues?state=all&per_page=100`),
    githubAll<RestPull>(token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`, 3),
    githubAll<{ name: string }>(token, `/repos/${repo}/branches?per_page=100`, 3),
  ]);

  const pullsByIssue = new Map<number, LinkedPull[]>();
  for (const pull of pulls) {
    const refs = new Set(issueRefs(`${pull.title}\n${pull.body ?? ""}`));
    const fromBranch = branchIssue(pull.head.ref);
    if (fromBranch !== null) refs.add(fromBranch);
    const linked: LinkedPull = {
      number: pull.number,
      url: pull.html_url,
      state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
    };
    for (const ref of refs) pullsByIssue.set(ref, [...(pullsByIssue.get(ref) ?? []), linked]);
  }
  const branchesByIssue = new Map<number, string[]>();
  for (const branch of branches) {
    const ref = branchIssue(branch.name);
    if (ref !== null) branchesByIssue.set(ref, [...(branchesByIssue.get(ref) ?? []), branch.name]);
  }

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) =>
      toStory(issue, {
        pullRequests: pullsByIssue.get(issue.number) ?? [],
        branches: branchesByIssue.get(issue.number) ?? [],
      }),
    );
}

export interface StoriesView {
  stories: Story[];
  fetchedAt: string | null;
  failure?: string;
}

export async function loadStories(env: Env, project: Project): Promise<StoriesView> {
  const snapshot = await readSnapshot<Story[]>(env.DB, project.repo, STORIES);
  if (snapshot && isFresh(snapshot, MAX_AGE_MS)) return { stories: snapshot.data, fetchedAt: snapshot.fetchedAt };
  try {
    const stories = await fetchStories(env, project);
    const fetchedAt = await writeSnapshot(env.DB, project.repo, STORIES, stories);
    return { stories, fetchedAt };
  } catch (error) {
    return {
      stories: snapshot?.data ?? [],
      fetchedAt: snapshot && snapshot.fetchedAt.startsWith("1970") ? null : (snapshot?.fetchedAt ?? null),
      failure: describeFailure(error),
    };
  }
}

// Webhook `issues`: the snapshot follows GitHub without waiting for a resync.
export async function applyIssueEvent(env: Env, repo: string, action: string, issue: RestIssue): Promise<void> {
  if (issue.pull_request) return;
  const snapshot = await readSnapshot<Story[]>(env.DB, repo, STORIES);
  if (!snapshot) return;
  const others = snapshot.data.filter((story) => story.number !== issue.number);
  if (action === "deleted" || action === "transferred") {
    await writeSnapshot(env.DB, repo, STORIES, others, snapshot.fetchedAt);
    return;
  }
  const previous = snapshot.data.find((story) => story.number === issue.number);
  const updated = toStory(issue, previous);
  if (issue.parent_issue_url === undefined && previous) updated.parent = previous.parent;
  if (issue.sub_issues_summary === undefined && previous) {
    updated.subTotal = previous.subTotal;
    updated.subCompleted = previous.subCompleted;
  }
  if (issue.body === undefined && previous?.criteria) updated.criteria = previous.criteria;
  await writeSnapshot(env.DB, repo, STORIES, [...others, updated], snapshot.fetchedAt);
}

export async function storiesChanged(env: Env, repo: string): Promise<void> {
  await markStale(env.DB, repo, STORIES);
}

export interface StoryFilters {
  epic: number | null;
  label: string | null;
  state: "open" | "closed" | "all";
  mine: boolean;
  stage?: string | null;
}

export interface StoryGroup {
  epic: Story | null;
  items: Story[];
}

export function groupStories(
  stories: Story[],
  filters: StoryFilters,
  viewerLogin: string,
  stages: Map<number, string> = new Map(),
): StoryGroup[] {
  const byNumber = new Map(stories.map((story) => [story.number, story]));
  const isEpic = (story: Story) => story.subTotal > 0;
  const matches = (story: Story) =>
    (!filters.stage || stages.get(story.number) === filters.stage) &&
    (filters.state === "all" || story.state === filters.state) &&
    (!filters.label || story.labels.includes(filters.label)) &&
    (!filters.mine || story.author === viewerLogin);

  const epics = stories
    .filter(isEpic)
    .sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === "open" ? -1 : 1));
  const groups: StoryGroup[] = epics.map((epic) => ({
    epic,
    items: stories.filter((story) => story.parent === epic.number && matches(story)).sort((a, b) => a.number - b.number),
  }));
  const loose = stories
    .filter((story) => !isEpic(story) && (story.parent === null || !byNumber.has(story.parent)) && matches(story))
    .sort((a, b) => a.number - b.number);

  if (filters.epic !== null) return groups.filter((group) => group.epic?.number === filters.epic);
  const filtering = filters.label !== null || filters.mine || filters.state !== "all" || Boolean(filters.stage);
  return [
    ...groups.filter((group) => group.items.length > 0 || (!filtering && group.epic !== null)),
    ...(loose.length ? [{ epic: null, items: loose }] : []),
  ];
}
