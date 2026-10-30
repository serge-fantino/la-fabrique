import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { validateFabriqueConfig, type ConfigCheckResult, type FabriqueConfig, type RepoTree } from "./fabrique-config";
import { GitHubError, githubFetch, githubJson, installationToken } from "./github-app";

export interface ConfigCheck {
  branch: string;
  commitSha: string;
  config: FabriqueConfig | null;
  errors: string[];
  checkedAt: string;
}

export interface Project {
  repo: string;
  installationId: number;
  addedAt: string;
  addedBy: string;
  check: ConfigCheck | null;
}

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isRepoName(value: string): boolean {
  return REPO_PATTERN.test(value);
}

interface ProjectDbRow {
  repo: string;
  installation_id: number;
  added_at: string;
  added_by: string;
  branch: string | null;
  commit_sha: string | null;
  config: string | null;
  errors: string | null;
  checked_at: string | null;
}

const PROJECT_QUERY = `
  SELECT p.repo, p.installation_id, p.added_at, p.added_by,
         c.branch, c.commit_sha, c.config, c.errors, c.checked_at
  FROM projects p
  LEFT JOIN project_configs c ON c.id = (
    SELECT id FROM project_configs WHERE repo = p.repo ORDER BY checked_at DESC, id DESC LIMIT 1
  )`;

function toProject(row: ProjectDbRow): Project {
  return {
    repo: row.repo,
    installationId: row.installation_id,
    addedAt: row.added_at,
    addedBy: row.added_by,
    check:
      row.commit_sha && row.branch && row.checked_at
        ? {
            branch: row.branch,
            commitSha: row.commit_sha,
            config: row.config ? (JSON.parse(row.config) as FabriqueConfig) : null,
            errors: JSON.parse(row.errors ?? "[]") as string[],
            checkedAt: row.checked_at,
          }
        : null,
  };
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db.prepare(`${PROJECT_QUERY} ORDER BY p.repo`).all<ProjectDbRow>();
  return results.map(toProject);
}

export async function findProject(db: D1Database, repo: string): Promise<Project | null> {
  const row = await db.prepare(`${PROJECT_QUERY} WHERE p.repo = ?`).bind(repo).first<ProjectDbRow>();
  return row ? toProject(row) : null;
}

export async function addProject(
  db: D1Database,
  repo: string,
  installationId: number,
  addedBy: string,
): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, ?, ?)").bind(repo, installationId, addedBy),
    activityStatement(db, {
      actor: addedBy,
      action: "project_added",
      repo,
      details: { installation_id: installationId },
    }),
  ]);
}

async function readTree(token: string, repo: string, sha: string): Promise<RepoTree> {
  const data = await githubJson<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    token,
    `/repos/${repo}/git/trees/${sha}?recursive=1`,
  );
  const tree: RepoTree = { files: new Set(), folders: new Set(), complete: !data.truncated };
  for (const entry of data.tree) {
    if (entry.type === "blob") tree.files.add(entry.path);
    if (entry.type === "tree") tree.folders.add(entry.path);
  }
  return tree;
}

async function branchHead(token: string, repo: string, branch: string): Promise<string> {
  const data = await githubJson<{ commit: { sha: string } }>(
    token,
    `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
  );
  return data.commit.sha;
}

async function cachedCheck(db: D1Database, repo: string, sha: string): Promise<ConfigCheck | null> {
  const row = await db
    .prepare(
      `UPDATE project_configs SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE repo = ? AND commit_sha = ?
       RETURNING branch, commit_sha, config, errors, checked_at`,
    )
    .bind(repo, sha)
    .first<Omit<ProjectDbRow, "repo" | "installation_id" | "added_at" | "added_by">>();
  if (!row) return null;
  return toProject({ ...row, repo, installation_id: 0, added_at: "", added_by: "" }).check;
}

async function checkCommit(
  env: Env,
  token: string,
  repo: string,
  branch: string,
  sha: string,
  force: boolean,
): Promise<ConfigCheck> {
  if (!force) {
    const cached = await cachedCheck(env.DB, repo, sha);
    if (cached) return cached;
  }

  const tree = await readTree(token, repo, sha);
  const missing: ConfigCheckResult = {
    config: null,
    errors: [`There is no \`.fabrique.json\` at the root of \`${branch}\`.`],
  };
  let result = missing;
  if (tree.files.has(".fabrique.json") || !tree.complete) {
    const response = await githubFetch(
      token,
      `/repos/${repo}/contents/.fabrique.json?ref=${sha}`,
      "application/vnd.github.raw+json",
    );
    if (response.ok) result = validateFabriqueConfig(await response.text(), tree);
    else if (response.status !== 404) throw new GitHubError(response.status, "Could not read .fabrique.json");
  }

  const row = await env.DB.prepare(
    `INSERT INTO project_configs (repo, branch, commit_sha, config, errors) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo, commit_sha) DO UPDATE SET
       branch = excluded.branch, config = excluded.config, errors = excluded.errors,
       checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING checked_at`,
  )
    .bind(repo, branch, sha, result.config ? JSON.stringify(result.config) : null, JSON.stringify(result.errors))
    .first<{ checked_at: string }>();

  return { branch, commitSha: sha, config: result.config, errors: result.errors, checkedAt: row?.checked_at ?? "" };
}

export type CheckOutcome = { ok: true; check: ConfigCheck } | { ok: false; message: string };

export function describeFailure(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 0) return error.message;
    if ([401, 403, 404].includes(error.status)) {
      return "La Fabrique extraordinaire cannot read this repository or branch. Is the GitHub App still installed on it?";
    }
    return `GitHub did not answer as expected (HTTP ${error.status}). Try again later.`;
  }
  return "GitHub could not be reached. Try again later.";
}

// Reads the production branch: the one the file declares, or the default
// branch until a file has been read.
export async function checkProject(env: Env, project: Project, force = false): Promise<CheckOutcome> {
  try {
    const token = await installationToken(env, project.installationId);
    let branch = project.check?.config?.branches?.production;
    if (!branch) {
      branch = (await githubJson<{ default_branch: string }>(token, `/repos/${project.repo}`)).default_branch;
    }
    let check = await checkCommit(env, token, project.repo, branch, await branchHead(token, project.repo, branch), force);
    const declared = check.config?.branches?.production;
    if (declared && declared !== branch) {
      check = await checkCommit(env, token, project.repo, declared, await branchHead(token, project.repo, declared), force);
    }
    return { ok: true, check };
  } catch (error) {
    return { ok: false, message: describeFailure(error) };
  }
}

export async function checkPushedCommit(
  env: Env,
  project: Project,
  branch: string,
  sha: string,
): Promise<CheckOutcome> {
  try {
    const token = await installationToken(env, project.installationId);
    return { ok: true, check: await checkCommit(env, token, project.repo, branch, sha, false) };
  } catch (error) {
    return { ok: false, message: describeFailure(error) };
  }
}
