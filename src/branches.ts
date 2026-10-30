import type { Env } from "./env";
import { githubAll, installationToken } from "./github-app";
import { describeFailure, productionBranch, type Project } from "./projects";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";

export const BRANCHES = "branches";
const MAX_AGE_MS = 5 * 60 * 1000;

// Production first, then integration, then the others by name.
export function orderBranches(project: Project, names: Iterable<string>): string[] {
  const production = productionBranch(project);
  const integration = project.check?.config?.branches?.integration;
  const first = [production, integration].filter((name): name is string => Boolean(name));
  const rest = [...new Set(names)].filter((name) => !first.includes(name)).sort((a, b) => a.localeCompare(b));
  return [...new Set(first), ...rest];
}

// Every branch of the repository, read from GitHub at most every few minutes.
export async function loadBranches(env: Env, project: Project): Promise<{ branches: string[]; failure?: string }> {
  const snapshot = await readSnapshot<string[]>(env.DB, project.repo, BRANCHES);
  if (snapshot && isFresh(snapshot, MAX_AGE_MS)) return { branches: orderBranches(project, snapshot.data) };
  try {
    const token = await installationToken(env, project.installationId);
    const names = (await githubAll<{ name: string }>(token, `/repos/${project.repo}/branches?per_page=100`, 3)).map(
      (branch) => branch.name,
    );
    await writeSnapshot(env.DB, project.repo, BRANCHES, names);
    return { branches: orderBranches(project, names) };
  } catch (error) {
    return { branches: orderBranches(project, snapshot?.data ?? []), failure: describeFailure(error) };
  }
}

// Branches known without asking GitHub: the last list read, or those the
// stories board links to; the page's menu fetches the full list when opened.
export async function knownBranches(env: Env, project: Project, ref: string | null): Promise<string[]> {
  const listed = await readSnapshot<string[]>(env.DB, project.repo, BRANCHES);
  const names = listed
    ? listed.data
    : ((await readSnapshot<Story[]>(env.DB, project.repo, STORIES))?.data ?? []).flatMap((story) => story.branches ?? []);
  const valid = names.filter((name): name is string => typeof name === "string" && name.length > 0);
  return orderBranches(project, ref ? [...valid, ref] : valid);
}

export async function branchesChanged(env: Env, repo: string): Promise<void> {
  await markStale(env.DB, repo, BRANCHES);
}
