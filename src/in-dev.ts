import { loadBranches } from "./branches";
import type { Env } from "./env";
import { githubAll, githubJson, installationToken } from "./github-app";
import { globToRegExp } from "./production";
import { describeFailure, productionBranch, type Project } from "./projects";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";
import { branchIssue, issueRefs } from "./stories";

export const IN_DEV = "in_dev";
const MAX_AGE_MS = 3 * 60 * 1000;
// Branches read one by one for their last commit: GitHub calls stay bounded.
const MAX_BRANCHES = 20;
export const STALLED_DAYS = 3;

export type CiState = "success" | "failure" | "running" | "other";

export interface WorkItem {
  branch: string;
  stories: number[];
  pull: { number: number; url: string; title: string; draft: boolean; openedAt: string } | null;
  lastCommit: { sha: string; date: string; author: string | null; message: string; url: string } | null;
  ci: { state: CiState; url: string; at: string } | null;
}

export interface InDevData {
  items: WorkItem[];
  // More working branches than were read.
  truncated: boolean;
}

export interface InDevView {
  data: InDevData | null;
  fetchedAt: string | null;
  failure?: string;
}

interface RestPull {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  html_url: string;
  created_at: string;
  head: { ref: string };
}

interface RestRun {
  head_branch: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

interface RestBranch {
  commit: {
    sha: string;
    html_url: string;
    author: { login: string } | null;
    commit: { message: string; author: { name: string; date: string } | null; committer: { date: string } | null };
  };
}

function ciState(run: RestRun): CiState {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "failure" || run.conclusion === "timed_out") return "failure";
  return "other";
}

// Working branches: those matching branches.travail, or, without patterns,
// every branch but production and integration.
export function workingBranches(project: Project, branches: string[]): string[] {
  const patterns = (project.check?.config?.branches?.travail ?? []).map(globToRegExp);
  const reserved = new Set([productionBranch(project), project.check?.config?.branches?.integration].filter(Boolean));
  return branches.filter(
    (branch) => !reserved.has(branch) && (patterns.length === 0 || patterns.some((pattern) => pattern.test(branch))),
  );
}

async function fetchInDev(env: Env, project: Project): Promise<InDevData> {
  const { branches } = await loadBranches(env, project);
  const working = workingBranches(project, branches);
  const token = await installationToken(env, project.installationId);
  const repo = project.repo;
  const ci = project.check?.config?.workflows?.["ci"];

  const [pulls, runs] = await Promise.all([
    githubAll<RestPull>(token, `/repos/${repo}/pulls?state=open&per_page=100`, 2),
    typeof ci === "string"
      ? githubJson<{ workflow_runs: RestRun[] }>(token, `/repos/${repo}/actions/workflows/${encodeURIComponent(ci)}/runs?per_page=100`)
          .then((data) => data.workflow_runs)
          .catch(() => [] as RestRun[])
      : Promise.resolve([] as RestRun[]),
  ]);
  const pullByBranch = new Map(pulls.map((pull) => [pull.head.ref, pull]));
  // Runs come newest first: the first one per branch is its latest.
  const runByBranch = new Map<string, RestRun>();
  for (const run of runs) if (run.head_branch && !runByBranch.has(run.head_branch)) runByBranch.set(run.head_branch, run);

  const read = working.slice(0, MAX_BRANCHES);
  const items = await Promise.all(
    read.map(async (branch): Promise<WorkItem> => {
      const pull = pullByBranch.get(branch);
      const stories = new Set<number>(pull ? issueRefs(`${pull.title}\n${pull.body ?? ""}`) : []);
      const fromName = branchIssue(branch);
      if (fromName !== null) stories.add(fromName);
      let lastCommit: WorkItem["lastCommit"] = null;
      try {
        const head = (await githubJson<RestBranch>(token, `/repos/${repo}/branches/${encodeURIComponent(branch)}`)).commit;
        lastCommit = {
          sha: head.sha,
          date: head.commit.committer?.date ?? head.commit.author?.date ?? "",
          author: head.author?.login ?? head.commit.author?.name ?? null,
          message: head.commit.message.split("\n")[0] ?? "",
          url: head.html_url,
        };
      } catch {
        // A branch deleted meanwhile: listed without its last commit.
      }
      const run = runByBranch.get(branch);
      return {
        branch,
        stories: [...stories].sort((a, b) => a - b),
        pull: pull
          ? { number: pull.number, url: pull.html_url, title: pull.title, draft: Boolean(pull.draft), openedAt: pull.created_at }
          : null,
        lastCommit,
        ci: run ? { state: ciState(run), url: run.html_url, at: run.created_at } : null,
      };
    }),
  );
  items.sort((a, b) => (b.lastCommit?.date ?? "").localeCompare(a.lastCommit?.date ?? ""));
  return { items, truncated: working.length > read.length };
}

export async function inDevReady(env: Env, project: Project): Promise<boolean> {
  return isFresh(await readSnapshot<InDevData>(env.DB, project.repo, IN_DEV), MAX_AGE_MS);
}

export async function loadInDev(env: Env, project: Project): Promise<InDevView> {
  const snapshot = await readSnapshot<InDevData>(env.DB, project.repo, IN_DEV);
  if (snapshot && isFresh(snapshot, MAX_AGE_MS)) return { data: snapshot.data, fetchedAt: snapshot.fetchedAt };
  try {
    const data = await fetchInDev(env, project);
    return { data, fetchedAt: await writeSnapshot(env.DB, project.repo, IN_DEV, data) };
  } catch (error) {
    return { data: snapshot?.data ?? null, fetchedAt: snapshot?.fetchedAt ?? null, failure: describeFailure(error) };
  }
}

export async function inDevChanged(env: Env, repo: string): Promise<void> {
  await markStale(env.DB, repo, IN_DEV);
}

export function isStalled(item: WorkItem, now = Date.now()): boolean {
  return item.lastCommit !== null && now - Date.parse(item.lastCommit.date) > STALLED_DAYS * 86_400_000;
}
