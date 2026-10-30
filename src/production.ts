import type { Env } from "./env";
import type { FabriqueConfig } from "./fabrique-config";
import { githubFetch, githubJson, installationToken } from "./github-app";
import { describeFailure, type Project } from "./projects";
import { isFresh, markStale, readSnapshot, writeSnapshot, onBranch } from "./snapshots";
import { branchIssue, issueRefs, STORIES, type Story } from "./stories";
import { githubContentsPath } from "./urls";

export const PRODUCTION = "production";
const MAX_AGE_MS = 60 * 1000;

export interface CompareCommit {
  sha: string;
  parents: string[];
  message: string;
  author: string | null;
  date: string;
  url: string;
}

export interface PendingGroup {
  branch: string | null;
  title: string;
  mergedAt: string | null;
  commits: CompareCommit[];
  issues: number[];
}

export interface WorkflowState {
  key: string;
  file: string;
  branch: string;
  status: "success" | "failure" | "running" | "none" | "other";
  conclusion: string | null;
  url: string | null;
  at: string | null;
  headSha: string | null;
}

export interface VersionState {
  environment: string;
  url: string;
  version: string | null;
  // The `environnement` the version path answers, when it says one.
  answers?: string | null;
}

export interface NextRelease {
  version: string;
  title: string | null;
  changes: string[];
}

export interface ProductionStatus {
  production: string;
  integration: string;
  integrationHead: string | null;
  aheadBy: number;
  groups: PendingGroup[];
  workflows: WorkflowState[];
  versions: VersionState[];
  // Release-notes entries of the candidate branch that production lacks,
  // newest first.
  waiting: NextRelease[];
  /** @deprecated snapshots written before `waiting`. */
  next?: NextRelease | null;
  ready: boolean;
  blockers: { text: string; url: string | null }[];
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// Finds the working branch a merge commit integrated, from its message.
export function mergedBranch(message: string, patterns: string[]): string | null {
  const line = message.split("\n")[0] ?? "";
  const matchers = patterns.map(globToRegExp);
  const candidates = line.match(/[\w.-]+(?:\/[\w.-]+)+/g) ?? [];
  const declared = candidates.find((candidate) => matchers.some((matcher) => matcher.test(candidate)));
  if (declared) return declared;
  const pull = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(line);
  if (pull?.[1]) return pull[1];
  const branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(line);
  return branch?.[1] ?? null;
}

// Commits come oldest first, as the compare API returns them. Each merge
// on the integration line takes the commits it brought in; merges are
// listed newest first, then commits made directly on integration.
export function groupPending(commits: CompareCommit[], patterns: string[]): PendingGroup[] {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const mainline: CompareCommit[] = [];
  for (let current = commits.at(-1); current; current = bySha.get(current.parents[0] ?? "")) {
    if (mainline.includes(current)) break;
    mainline.push(current);
  }
  const assigned = new Set(mainline.map((commit) => commit.sha));
  const groups: PendingGroup[] = [];
  const direct: CompareCommit[] = [];

  for (const commit of [...mainline].reverse()) {
    if (commit.parents.length < 2) {
      direct.push(commit);
      continue;
    }
    const members: CompareCommit[] = [];
    const stack = commit.parents.slice(1);
    while (stack.length) {
      const sha = stack.pop() ?? "";
      const member = bySha.get(sha);
      if (!member || assigned.has(sha)) continue;
      assigned.add(sha);
      members.push(member);
      stack.push(...member.parents);
    }
    const branch = mergedBranch(commit.message, patterns);
    groups.push({
      branch,
      title: commit.message.split("\n")[0] ?? "",
      mergedAt: commit.date,
      commits: members.sort((a, b) => a.date.localeCompare(b.date)),
      issues: [],
    });
  }
  groups.reverse();
  direct.push(...commits.filter((commit) => !assigned.has(commit.sha)));
  if (direct.length) {
    groups.push({ branch: null, title: "Direct commits", mergedAt: null, commits: direct, issues: [] });
  }

  for (const group of groups) {
    const refs = new Set(group.commits.flatMap((commit) => issueRefs(commit.message)));
    const fromBranch = group.branch ? branchIssue(group.branch) : null;
    if (fromBranch !== null) refs.add(fromBranch);
    group.issues = [...refs].sort((a, b) => a - b);
  }
  return groups;
}

interface RestRun {
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  head_sha: string;
}

function runState(key: string, file: string, branch: string, run: RestRun | undefined): WorkflowState {
  if (!run) return { key, file, branch, status: "none", conclusion: null, url: null, at: null, headSha: null };
  const status =
    run.status !== "completed"
      ? "running"
      : run.conclusion === "success"
        ? "success"
        : run.conclusion === "failure" || run.conclusion === "timed_out"
          ? "failure"
          : "other";
  return {
    key,
    file,
    branch,
    status,
    conclusion: run.conclusion,
    url: run.html_url,
    at: run.created_at,
    headSha: run.head_sha,
  };
}

function releaseEntries(raw: string | null): (NextRelease & { time: boolean })[] {
  let data: unknown;
  try {
    data = raw === null ? [] : JSON.parse(raw);
  } catch {
    return [];
  }
  const entries: (NextRelease & { time: boolean })[] = [];
  for (const entry of Array.isArray(data) ? data : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const version = record["version"] ?? record["numero"];
    if (typeof version !== "string") continue;
    const changes = Array.isArray(record["changements"])
      ? record["changements"].filter((change): change is string => typeof change === "string")
      : [];
    entries.push({ version, title: typeof record["titre"] === "string" ? record["titre"] : null, changes, time: Boolean(record["heure"]) });
  }
  return entries;
}

// The first release-notes entry without an `heure`: not released yet.
export function nextRelease(raw: string): NextRelease | null {
  const entry = releaseEntries(raw).find((candidate) => !candidate.time);
  return entry ? { version: entry.version, title: entry.title, changes: entry.changes } : null;
}

// Every entry of the candidate branch's release notes that production's
// file does not have yet (an entry dated for its go is still waiting until
// it is in production). Without production's file, the entries without an
// `heure`.
export function waitingReleases(candidate: string, production: string | null): NextRelease[] {
  const released = production === null ? null : new Set(releaseEntries(production).map((entry) => entry.version));
  return releaseEntries(candidate)
    .filter((entry) => (released ? !released.has(entry.version) : !entry.time))
    .map(({ version, title, changes }) => ({ version, title, changes }));
}

export async function readVersion(environment: string, url: string, path: string): Promise<VersionState> {
  try {
    const response = await fetch(new URL(path, url).toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { environment, url, version: null };
    const data = (await response.json()) as Record<string, unknown>;
    const version = data["numero"] ?? data["version"];
    const answers = data["environnement"];
    return {
      environment,
      url,
      version: typeof version === "string" || typeof version === "number" ? String(version) : null,
      answers: typeof answers === "string" ? answers : null,
    };
  } catch {
    return { environment, url, version: null };
  }
}

function readiness(
  integrationHead: string | null,
  aheadBy: number,
  workflows: WorkflowState[],
): Pick<ProductionStatus, "ready" | "blockers"> {
  const blockers: { text: string; url: string | null }[] = [];
  const check = (key: string, label: string) => {
    const run = workflows.find((workflow) => workflow.key === key);
    if (!run) return;
    if (run.status === "failure") blockers.push({ text: `${label} failed on ${run.branch}.`, url: run.url });
    else if (run.status === "running") blockers.push({ text: `${label} is still running on ${run.branch}.`, url: run.url });
    else if (run.status === "none") blockers.push({ text: `${label} has not run on ${run.branch}.`, url: null });
    else if (run.status === "other") blockers.push({ text: `${label} ended as “${run.conclusion}” on ${run.branch}.`, url: run.url });
    else if (integrationHead && run.headSha !== integrationHead) {
      blockers.push({ text: `${label} has not run on the latest commit of ${run.branch} yet.`, url: run.url });
    }
  };
  check("ci", "CI");
  check("deploiement_int", "Deployment to int");
  return { ready: aheadBy > 0 && blockers.length === 0, blockers };
}

// What `candidate` (integration, or the reference branch chosen in the
// header) would bring to production.
async function fetchStatus(env: Env, project: Project, config: FabriqueConfig, candidate: string): Promise<ProductionStatus> {
  const production = config.branches?.production ?? project.check?.branch ?? "main";
  const integration = candidate;
  const token = await installationToken(env, project.installationId);
  const repo = project.repo;

  const compare = await githubJson<{
    ahead_by: number;
    commits: {
      sha: string;
      html_url: string;
      parents: { sha: string }[];
      author: { login: string } | null;
      commit: { message: string; committer: { date: string } | null; author: { name: string; date: string } | null };
    }[];
  }>(token, `/repos/${repo}/compare/${encodeURIComponent(production)}...${encodeURIComponent(integration)}`);

  const commits: CompareCommit[] = compare.commits.map((commit) => ({
    sha: commit.sha,
    parents: commit.parents.map((parent) => parent.sha),
    message: commit.commit.message,
    author: commit.author?.login ?? commit.commit.author?.name ?? null,
    date: commit.commit.committer?.date ?? commit.commit.author?.date ?? "",
    url: commit.html_url,
  }));
  const integrationHead = compare.commits.length
    ? (commits.at(-1)?.sha ?? null)
    : (await githubJson<{ commit: { sha: string } }>(token, `/repos/${repo}/branches/${encodeURIComponent(integration)}`)).commit.sha;

  const followed: [string, string][] = [
    ["ci", integration],
    ...(integration === config.branches?.integration ? [["deploiement_int", integration] as [string, string]] : []),
    ["migrations_production", production],
    // The go's own runs, dispatched on the production branch.
    ["promouvoir", production],
  ];
  const workflows = await Promise.all(
    followed
      .filter(([key]) => typeof config.workflows?.[key] === "string")
      .map(async ([key, branch]) => {
        const file = config.workflows?.[key] as string;
        const runs = await githubJson<{ workflow_runs: RestRun[] }>(
          token,
          `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
        );
        return runState(key, file, branch, runs.workflow_runs[0]);
      }),
  );

  const versions = await Promise.all(
    Object.entries(config.environnements ?? {})
      .filter(([, environment]) => environment.version)
      .map(([name, environment]) => readVersion(name, environment.url, environment.version ?? "")),
  );

  let waiting: NextRelease[] = [];
  if (config.version?.fichier) {
    const file = config.version.fichier;
    const read = async (branch: string) => {
      const response = await githubFetch(token, githubContentsPath(repo, file, encodeURIComponent(branch)), "application/vnd.github.raw+json");
      return response.ok ? response.text() : null;
    };
    const [candidateFile, productionFile] = await Promise.all([read(integration), read(production)]);
    if (candidateFile !== null) waiting = waitingReleases(candidateFile, productionFile);
  }

  return {
    production,
    integration,
    integrationHead,
    aheadBy: compare.ahead_by,
    groups: groupPending(commits, config.branches?.travail ?? []),
    workflows,
    versions,
    waiting,
    ...readiness(integrationHead, compare.ahead_by, workflows),
  };
}

export interface ProductionView {
  status: ProductionStatus | null;
  fetchedAt: string | null;
  failure?: string;
  storyTitles: Map<number, string>;
  stories: Story[];
}

// True when the page can be shown at once, without asking GitHub.
export async function productionReady(env: Env, project: Project, ref: string | null = null): Promise<boolean> {
  if (!(ref ?? project.check?.config?.branches?.integration)) return true;
  return isFresh(await readSnapshot<ProductionStatus>(env.DB, project.repo, onBranch(PRODUCTION, ref)), MAX_AGE_MS);
}

export async function loadProduction(env: Env, project: Project, ref: string | null = null): Promise<ProductionView> {
  const config = project.check?.config;
  const stories = await readSnapshot<Story[]>(env.DB, project.repo, STORIES);
  const storyList = stories?.data ?? [];
  const storyTitles = new Map(storyList.map((story) => [story.number, story.title]));
  const candidate = ref ?? config?.branches?.integration;
  if (!config || !candidate) return { status: null, fetchedAt: null, storyTitles, stories: storyList };

  const kind = onBranch(PRODUCTION, ref);
  const snapshot = await readSnapshot<ProductionStatus>(env.DB, project.repo, kind);
  if (snapshot && isFresh(snapshot, MAX_AGE_MS)) {
    return { status: snapshot.data, fetchedAt: snapshot.fetchedAt, storyTitles, stories: storyList };
  }
  try {
    const status = await fetchStatus(env, project, config, candidate);
    const fetchedAt = await writeSnapshot(env.DB, project.repo, kind, status);
    return { status, fetchedAt, storyTitles, stories: storyList };
  } catch (error) {
    return {
      status: snapshot?.data ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      failure: describeFailure(error),
      storyTitles,
      stories: storyList,
    };
  }
}

export async function productionChanged(env: Env, repo: string): Promise<void> {
  await markStale(env.DB, repo, PRODUCTION);
}
