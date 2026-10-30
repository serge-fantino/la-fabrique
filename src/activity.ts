import type { Env } from "./env";
import { githubJson, installationToken } from "./github-app";
import { describeFailure, type Project } from "./projects";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";

const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_COMMIT_PAGES = 6;
// Keeps a page view under the Workers subrequest limit.
const MAX_COMPARES_PER_VIEW = 30;
export const RANGES = [30, 90] as const;
export type Range = (typeof RANGES)[number];

export interface ActivityCommit {
  sha: string;
  parents: string[];
  author: string;
  authoredAt: string;
  committedAt: string;
}

interface ActivitySnapshot {
  branch: string;
  since: string;
  truncated: boolean;
  commits: ActivityCommit[];
}

export interface DayActivity {
  day: string;
  commits: number;
  additions: number | null;
  deletions: number | null;
}

export interface ActivityView {
  branch: string;
  range: Range;
  days: DayActivity[];
  authors: { author: string; commits: number }[];
  totals: { commits: number; activeDays: number; additions: number; deletions: number };
  pendingDays: number;
  truncated: boolean;
  fetchedAt: string | null;
  failure?: string;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function daysBetween(start: Date, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    return day.toISOString().slice(0, 10);
  });
}

// The branch as it stood at the end of each day: the newest commit of its
// first-parent line committed by then.
export function dayHeads(commits: ActivityCommit[], headSha: string, days: string[]): Map<string, string | null> {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const line: ActivityCommit[] = [];
  for (let current = bySha.get(headSha); current; current = bySha.get(current.parents[0] ?? "")) {
    if (line.includes(current)) break;
    line.push(current);
  }
  const heads = new Map<string, string | null>();
  for (const day of days) {
    const end = `${day}T23:59:59.999Z`;
    heads.set(day, line.find((commit) => commit.committedAt <= end)?.sha ?? null);
  }
  return heads;
}

async function readCommits(env: Env, project: Project, branch: string, since: string): Promise<ActivitySnapshot> {
  const token = await installationToken(env, project.installationId);
  const commits: ActivityCommit[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
    const batch = await githubJson<
      {
        sha: string;
        parents: { sha: string }[];
        author: { login: string } | null;
        commit: { author: { name: string; date: string } | null; committer: { date: string } | null };
      }[]
    >(token, `/repos/${project.repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}&per_page=100&page=${page}`);
    for (const item of batch) {
      commits.push({
        sha: item.sha,
        parents: item.parents.map((parent) => parent.sha),
        author: item.author?.login ?? item.commit.author?.name ?? "unknown",
        authoredAt: item.commit.author?.date ?? item.commit.committer?.date ?? "",
        committedAt: item.commit.committer?.date ?? item.commit.author?.date ?? "",
      });
    }
    if (batch.length < 100) break;
    if (page === MAX_COMMIT_PAGES) truncated = true;
  }
  return { branch, since, truncated, commits };
}

async function knownDiffs(env: Env, repo: string): Promise<Map<string, { additions: number; deletions: number }>> {
  const { results } = await env.DB.prepare("SELECT base, head, additions, deletions FROM diff_stats WHERE repo = ?")
    .bind(repo)
    .all<{ base: string; head: string; additions: number; deletions: number }>();
  return new Map(results.map((row) => [`${row.base}..${row.head}`, row]));
}

async function readDiff(
  env: Env,
  token: () => Promise<string>,
  repo: string,
  base: string,
  head: string,
): Promise<{ additions: number; deletions: number }> {
  const compare = await githubJson<{ files?: { additions: number; deletions: number }[] }>(
    await token(),
    `/repos/${repo}/compare/${base}...${head}`,
  );
  const files = compare.files ?? [];
  const stats = {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
  await env.DB.prepare(
    "INSERT OR REPLACE INTO diff_stats (repo, base, head, additions, deletions, files) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(repo, base, head, stats.additions, stats.deletions, files.length)
    .run();
  return stats;
}

function activityBranch(project: Project): string {
  const branches = project.check?.config?.branches;
  return branches?.integration ?? branches?.production ?? project.check?.branch ?? "main";
}

export async function loadActivity(env: Env, project: Project, range: Range, now = new Date()): Promise<ActivityView> {
  const branch = activityBranch(project);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (range - 1)));
  const days = daysBetween(start, range);
  // One more day, so the first day has a starting point.
  const since = new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const kind = `activity:${range}`;

  let snapshot = await readSnapshot<ActivitySnapshot>(env.DB, project.repo, kind);
  let failure: string | undefined;
  if (!snapshot || !isFresh(snapshot, MAX_AGE_MS) || snapshot.data.branch !== branch || snapshot.data.since > since) {
    try {
      const data = await readCommits(env, project, branch, since);
      snapshot = { data, fetchedAt: await writeSnapshot(env.DB, project.repo, kind, data) };
    } catch (error) {
      failure = describeFailure(error);
    }
  }
  const commits = snapshot?.data.commits ?? [];

  const counts = new Map<string, number>();
  const authors = new Map<string, number>();
  for (const commit of commits) {
    if (commit.parents.length > 1) continue;
    const day = dayOf(commit.authoredAt);
    if (!days.includes(day)) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
    authors.set(commit.author, (authors.get(commit.author) ?? 0) + 1);
  }

  const heads = commits.length ? dayHeads(commits, commits[0]?.sha ?? "", [dayOf(since), ...days]) : new Map();
  let cachedToken: string | null = null;
  const token = async () => (cachedToken ??= await installationToken(env, project.installationId));
  const known = await knownDiffs(env, project.repo);
  let compares = 0;
  let pendingDays = 0;
  const result: DayActivity[] = [];
  let previous: string | null = heads.get(dayOf(since)) ?? null;
  for (const day of days) {
    const head = heads.get(day) ?? null;
    let additions: number | null = null;
    let deletions: number | null = null;
    if (head && previous === head) {
      additions = 0;
      deletions = 0;
    } else if (head && previous) {
      const stored = known.get(`${previous}..${head}`);
      if (stored) {
        ({ additions, deletions } = stored);
      } else if (compares < MAX_COMPARES_PER_VIEW && !failure) {
        compares++;
        try {
          ({ additions, deletions } = await readDiff(env, token, project.repo, previous, head));
        } catch (error) {
          failure = describeFailure(error);
        }
      }
      if (additions === null) pendingDays++;
    }
    result.push({ day, commits: counts.get(day) ?? 0, additions, deletions });
    if (head) previous = head;
  }

  return {
    branch,
    range,
    days: result,
    authors: [...authors.entries()]
      .map(([author, count]) => ({ author, commits: count }))
      .sort((a, b) => b.commits - a.commits),
    totals: {
      commits: result.reduce((sum, day) => sum + day.commits, 0),
      activeDays: result.filter((day) => day.commits > 0).length,
      additions: result.reduce((sum, day) => sum + (day.additions ?? 0), 0),
      deletions: result.reduce((sum, day) => sum + (day.deletions ?? 0), 0),
    },
    pendingDays,
    truncated: snapshot?.data.truncated ?? false,
    fetchedAt: snapshot?.fetchedAt ?? null,
    ...(failure ? { failure } : {}),
  };
}

export async function activityChanged(env: Env, repo: string): Promise<void> {
  await Promise.all(RANGES.map((range) => markStale(env.DB, repo, `activity:${range}`)));
}
