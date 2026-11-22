import { activityStatement } from "./activity-log";
import { integrationConfig } from "./defects";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { githubFetch, githubPost, githubPut, installationToken } from "./github-app";
import { RELEASE_NOTES_KIT_VERSION, RELEASE_NOTES_TOOL } from "./kit";
import { compareVersions } from "./kit-update";
import { productionBranch, type Project } from "./projects";
import { userToken } from "./session";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";

// The project's copy of La Fabrique's release-notes tool (version.outil in
// .fabrique.json, docs/release-notes-kit.md): which version it is, and a pull
// request that brings it to La Fabrique's. As for the report kit, La Fabrique
// never writes on a branch of the project: it proposes.

const SNAPSHOT = "release_tool";
const MAX_AGE_MS = 10 * 60 * 1000;

export interface ReleaseTool {
  // The path declared, or null.
  path: string | null;
  // Where the copy is read, and where an update goes: the integration branch
  // (the merge workflow takes the tool from there), else production.
  branch: string;
  // The copy's blob, when it exists on that branch.
  sha: string | null;
  version: string | null;
  failure?: string;
}

function versionOf(text: string): string | null {
  return /FabriqueReleaseNotes (\d+\.\d+\.\d+)/.exec(text.slice(0, 400))?.[1] ?? null;
}

function baseBranch(project: Project): string {
  return project.check?.config?.branches?.integration ?? productionBranch(project) ?? "main";
}

async function declaredPath(env: Env, project: Project): Promise<string | null> {
  return project.check?.config?.version?.outil ?? (await integrationConfig(env, project))?.version?.outil ?? null;
}

export function isCurrent(tool: Pick<ReleaseTool, "version">): boolean {
  return Boolean(tool.version && compareVersions(tool.version, RELEASE_NOTES_KIT_VERSION) >= 0);
}

export async function projectReleaseTool(env: Env, project: Project): Promise<ReleaseTool> {
  const path = await declaredPath(env, project);
  const branch = baseBranch(project);
  if (!path) return { path: null, branch, sha: null, version: null };
  const snapshot = await readSnapshot<ReleaseTool>(env.DB, project.repo, SNAPSHOT);
  if (snapshot && isFresh(snapshot, MAX_AGE_MS) && snapshot.data.path === path && snapshot.data.branch === branch) return snapshot.data;
  let tool: ReleaseTool;
  try {
    const token = await installationToken(env, project.installationId);
    const meta = await githubFetch(token, `/repos/${project.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (meta.status === 404) {
      tool = { path, branch, sha: null, version: null };
    } else if (!meta.ok) {
      return { path, branch, sha: null, version: null, failure: `GitHub answered ${meta.status} for ${path}.` };
    } else {
      const sha = ((await meta.json()) as { sha: string }).sha;
      const raw = await githubFetch(token, `/repos/${project.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, "application/vnd.github.raw+json");
      tool = { path, branch, sha, version: raw.ok ? versionOf(await raw.text()) : null };
    }
  } catch (error) {
    return { path, branch, sha: null, version: null, failure: error instanceof Error ? error.message : String(error) };
  }
  await writeSnapshot(env.DB, project.repo, SNAPSHOT, tool);
  return tool;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type ReleaseToolOutcome =
  | { ok: true; number: number; url: string; base: string }
  | { ok: false; reason: "signed_out" | "refused" | "undeclared" | "current"; status?: number };

// A pull request on the integration branch (or production), under the
// person's name: the copy replaced by La Fabrique's tool (or added), with the
// project's marker for commits that change nothing a user sees.
export async function proposeReleaseToolUpdate(request: Request, env: Env, project: Project, login: string, now = new Date()): Promise<ReleaseToolOutcome> {
  const tool = await projectReleaseTool(env, project);
  if (!tool.path) return { ok: false, reason: "undeclared" };
  if (isCurrent(tool)) return { ok: false, reason: "current" };

  const token = await userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
  if (!token) return { ok: false, reason: "signed_out" };
  const repo = project.repo;
  const failed = (response: Response): ReleaseToolOutcome =>
    response.status === 401 ? { ok: false, reason: "signed_out" } : { ok: false, reason: "refused", status: response.status };

  const head = await githubFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(tool.branch)}`);
  if (!head.ok) return failed(head);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const branch = `fabrique/release-notes-${RELEASE_NOTES_KIT_VERSION}-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const created = await githubPost(token, `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!created.ok) return failed(created);

  const marker = project.check?.config?.version?.coulisses ?? null;
  const title = `${marker ? `${marker} ` : ""}La Fabrique: release-notes tool ${RELEASE_NOTES_KIT_VERSION}`;
  const commit = await githubPut(token, `/repos/${repo}/contents/${tool.path}`, {
    message: `${title}\n\n${tool.path}, from ${tool.version ?? "nothing"} to ${RELEASE_NOTES_KIT_VERSION}.`,
    content: toBase64(RELEASE_NOTES_TOOL),
    ...(tool.sha ? { sha: tool.sha } : {}),
    branch,
  });
  if (!commit.ok) return failed(commit);

  const pull = await githubPost(token, `/repos/${repo}/pulls`, {
    title,
    head: branch,
    base: tool.branch,
    body: [
      `Proposed from La Fabrique's Setup tab by @${login}: the release-notes tool in \`${tool.path}\`, from ${tool.version ?? "nothing"} to ${RELEASE_NOTES_KIT_VERSION}, the same file La Fabrique runs.`,
      "The merge and release workflows run it as they are; nothing else changes. Guide: `/guide/release-notes-kit` in La Fabrique (docs/release-notes-kit.md).",
    ].join("\n\n"),
  });
  if (!pull.ok) return failed(pull);
  const opened = (await pull.json()) as { number: number; html_url: string };

  await markStale(env.DB, repo, SNAPSHOT);
  await activityStatement(env.DB, {
    actor: login,
    action: "release_tool_update_proposed",
    repo,
    issueNumber: opened.number,
    details: { from: tool.version, to: RELEASE_NOTES_KIT_VERSION, base: tool.branch, path: tool.path },
  }).run();
  return { ok: true, number: opened.number, url: opened.html_url, base: tool.branch };
}
