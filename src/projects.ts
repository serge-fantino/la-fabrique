import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { validateFabriqueConfig, type ConfigCheckResult, type FabriqueConfig, type RepoTree } from "./fabrique-config";
import { GitHubError, githubFetch, githubJson, installationToken } from "./github-app";
import { isFresh, readSnapshot, writeSnapshot } from "./snapshots";

export interface ConfigCheck {
  branch: string;
  commitSha: string;
  config: FabriqueConfig | null;
  errors: string[];
  checkedAt: string;
  committedAt: string | null;
  // Markdown files published by `documentation[]`; null on checks made
  // before pages were listed.
  docPages: string[] | null;
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
  committed_at: string | null;
  doc_pages: string | null;
}

const PROJECT_QUERY = `
  SELECT p.repo, p.installation_id, p.added_at, p.added_by,
         c.branch, c.commit_sha, c.config, c.errors, c.checked_at, c.committed_at, c.doc_pages
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
            committedAt: row.committed_at,
            docPages: row.doc_pages ? (JSON.parse(row.doc_pages) as string[]) : null,
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

interface Head {
  sha: string;
  committedAt: string | null;
}

async function branchHead(token: string, repo: string, branch: string): Promise<Head> {
  const data = await githubJson<{ commit: { sha: string; commit?: { committer?: { date?: string } } } }>(
    token,
    `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
  );
  return { sha: data.commit.sha, committedAt: data.commit.commit?.committer?.date ?? null };
}

function listDocPages(config: FabriqueConfig | null, tree: RepoTree): string[] {
  const pages = new Set<string>();
  for (const entry of config?.documentation ?? []) {
    if (!entry.chemin.endsWith("/")) {
      pages.add(entry.chemin);
      continue;
    }
    for (const file of tree.files) {
      if (file.startsWith(entry.chemin) && file.toLowerCase().endsWith(".md")) pages.add(file);
    }
  }
  return [...pages].sort();
}

async function cachedCheck(db: D1Database, repo: string, sha: string): Promise<ConfigCheck | null> {
  const row = await db
    .prepare(
      `UPDATE project_configs SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE repo = ? AND commit_sha = ?
       RETURNING branch, commit_sha, config, errors, checked_at, committed_at, doc_pages`,
    )
    .bind(repo, sha)
    .first<Omit<ProjectDbRow, "repo" | "installation_id" | "added_at" | "added_by">>();
  if (!row || row.doc_pages === null) return null;
  return toProject({ ...row, repo, installation_id: 0, added_at: "", added_by: "" }).check;
}

async function readConfigAt(
  token: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<{ result: ConfigCheckResult; docPages: string[] }> {
  const tree = await readTree(token, repo, sha);
  let result: ConfigCheckResult = {
    config: null,
    errors: [`There is no \`.fabrique.json\` at the root of \`${branch}\`.`],
  };
  if (tree.files.has(".fabrique.json") || !tree.complete) {
    const response = await githubFetch(
      token,
      `/repos/${repo}/contents/.fabrique.json?ref=${sha}`,
      "application/vnd.github.raw+json",
    );
    if (response.ok) result = validateFabriqueConfig(await response.text(), tree);
    else if (response.status !== 404) throw new GitHubError(response.status, "Could not read .fabrique.json");
  }
  return { result, docPages: listDocPages(result.config, tree) };
}

async function checkCommit(
  env: Env,
  token: string,
  repo: string,
  branch: string,
  head: Head,
  force: boolean,
): Promise<ConfigCheck> {
  const sha = head.sha;
  if (!force) {
    const cached = await cachedCheck(env.DB, repo, sha);
    if (cached) return cached;
  }

  const { result, docPages } = await readConfigAt(token, repo, branch, sha);
  const row = await env.DB.prepare(
    `INSERT INTO project_configs (repo, branch, commit_sha, config, errors, committed_at, doc_pages)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, commit_sha) DO UPDATE SET
       branch = excluded.branch, config = excluded.config, errors = excluded.errors,
       committed_at = excluded.committed_at, doc_pages = excluded.doc_pages,
       checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING checked_at`,
  )
    .bind(
      repo,
      branch,
      sha,
      result.config ? JSON.stringify(result.config) : null,
      JSON.stringify(result.errors),
      head.committedAt,
      JSON.stringify(docPages),
    )
    .first<{ checked_at: string }>();

  return {
    branch,
    commitSha: sha,
    config: result.config,
    errors: result.errors,
    checkedAt: row?.checked_at ?? "",
    committedAt: head.committedAt,
    docPages,
  };
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
  head: Head,
): Promise<CheckOutcome> {
  try {
    const token = await installationToken(env, project.installationId);
    return { ok: true, check: await checkCommit(env, token, project.repo, branch, head, false) };
  } catch (error) {
    return { ok: false, message: describeFailure(error) };
  }
}

const BRANCH_MAX_AGE_MS = 60 * 1000;

export function branchKind(branch: string): string {
  return `branch:${branch}`;
}

const BRANCH_PATTERN = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;

export function isBranchName(value: string): boolean {
  return BRANCH_PATTERN.test(value);
}

// Another branch than production: checked like production, cached per
// commit in its own snapshot, so the production reading never changes.
export async function checkOtherBranch(env: Env, project: Project, branch: string): Promise<CheckOutcome> {
  const snapshot = await readSnapshot<ConfigCheck>(env.DB, project.repo, branchKind(branch));
  if (snapshot && isFresh(snapshot, BRANCH_MAX_AGE_MS)) return { ok: true, check: snapshot.data };
  try {
    const token = await installationToken(env, project.installationId);
    const head = await branchHead(token, project.repo, branch);
    if (snapshot?.data.commitSha === head.sha) {
      await writeSnapshot(env.DB, project.repo, branchKind(branch), snapshot.data);
      return { ok: true, check: snapshot.data };
    }
    const { result, docPages } = await readConfigAt(token, project.repo, branch, head.sha);
    const check: ConfigCheck = {
      branch,
      commitSha: head.sha,
      config: result.config,
      errors: result.errors,
      checkedAt: new Date().toISOString(),
      committedAt: head.committedAt,
      docPages,
    };
    await writeSnapshot(env.DB, project.repo, branchKind(branch), check);
    return { ok: true, check };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return { ok: false, message: `There is no branch \`${branch}\` in ${project.repo}.` };
    }
    return { ok: false, message: describeFailure(error) };
  }
}

export function productionBranch(project: Project): string | null {
  return project.check?.config?.branches?.production ?? project.check?.branch ?? null;
}
