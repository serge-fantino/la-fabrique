import { activityStatement } from "./activity-log";
import { integrationConfig } from "./defects";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { githubFetch, githubPost, githubPut, installationToken } from "./github-app";
import { KIT_CHANGES, KIT_SOURCES, KIT_VERSION } from "./kit";
import { productionBranch, type Project } from "./projects";
import { userToken } from "./session";
import { isFresh, markStale, readSnapshot, writeSnapshot } from "./snapshots";

// The project's copy of the report kit (application.kit in .fabrique.json):
// which version it is, and a pull request that brings it to La Fabrique's.
// La Fabrique never writes on a branch of the project: it proposes.

const KIT_SNAPSHOT = "kit";
const KIT_MAX_AGE_MS = 10 * 60 * 1000;
const VERSIONED = /^fabrique-report(-early)?-\d+\.\d+\.\d+\.(js|css)$/;

export interface ProjectKit {
  // The folder declared, or null.
  folder: string | null;
  // Where the copy is read, and where an update goes.
  branch: string;
  // Kit files found under their stable names.
  files: { name: string; path: string; sha: string }[];
  // Kit files with a version in their name: La Fabrique cannot follow them.
  versioned: string[];
  version: string | null;
  failure?: string;
}

// -1, 0 or 1, version against version (x.y.z).
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function versionOf(text: string): string | null {
  return /FabriqueReport (\d+\.\d+\.\d+)/.exec(text.slice(0, 400))?.[1] ?? null;
}

async function declaredFolder(env: Env, project: Project): Promise<string | null> {
  return project.check?.config?.application?.kit ?? (await integrationConfig(env, project))?.application?.kit ?? null;
}

function baseBranch(project: Project): string {
  return project.check?.config?.branches?.integration ?? productionBranch(project) ?? "main";
}

export async function projectKit(env: Env, project: Project): Promise<ProjectKit> {
  const folder = await declaredFolder(env, project);
  const branch = baseBranch(project);
  if (!folder) return { folder: null, branch, files: [], versioned: [], version: null };
  const snapshot = await readSnapshot<ProjectKit>(env.DB, project.repo, KIT_SNAPSHOT);
  if (snapshot && isFresh(snapshot, KIT_MAX_AGE_MS) && snapshot.data.folder === folder && snapshot.data.branch === branch) {
    return snapshot.data;
  }
  let kit: ProjectKit;
  try {
    const token = await installationToken(env, project.installationId);
    const listing = await githubFetch(token, `/repos/${project.repo}/contents/${folder}?ref=${encodeURIComponent(branch)}`);
    if (listing.status === 404) {
      kit = { folder, branch, files: [], versioned: [], version: null };
    } else if (!listing.ok) {
      return { folder, branch, files: [], versioned: [], version: null, failure: `GitHub answered ${listing.status} for ${folder}.` };
    } else {
      const entries = ((await listing.json()) as { name: string; path: string; sha: string; type: string }[]).filter((entry) => entry.type === "file");
      const files = entries.filter((entry) => entry.name in KIT_SOURCES).map(({ name, path, sha }) => ({ name, path, sha }));
      const versioned = entries.filter((entry) => VERSIONED.test(entry.name)).map((entry) => entry.name);
      const script = files.find((file) => file.name === "fabrique-report.js")?.path
        ?? entries.find((entry) => /^fabrique-report-\d+\.\d+\.\d+\.js$/.test(entry.name))?.path;
      let version: string | null = null;
      if (script) {
        const raw = await githubFetch(token, `/repos/${project.repo}/contents/${script}?ref=${encodeURIComponent(branch)}`, "application/vnd.github.raw+json");
        if (raw.ok) version = versionOf(await raw.text());
      }
      kit = { folder, branch, files, versioned, version };
    }
  } catch (error) {
    return { folder, branch, files: [], versioned: [], version: null, failure: error instanceof Error ? error.message : String(error) };
  }
  await writeSnapshot(env.DB, project.repo, KIT_SNAPSHOT, kit);
  return kit;
}

// What a project's relay needs between its version and La Fabrique's.
export function relayChanges(from: string | null): string[] {
  return KIT_CHANGES.filter((change) => change.relay && (!from || compareVersions(change.version, from) > 0) && compareVersions(change.version, KIT_VERSION) <= 0).map(
    (change) => `${change.version}: ${change.relay}`,
  );
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type KitOutcome =
  | { ok: true; number: number; url: string; base: string }
  | { ok: false; reason: "signed_out" | "refused" | "undeclared" | "versioned" | "current"; status?: number };

// A pull request on the integration branch (or production), under the
// person's name: the kit's files replaced (or added, the first time), with
// the project's marker for commits that change nothing a user sees.
export async function proposeKitUpdate(request: Request, env: Env, project: Project, login: string, now = new Date()): Promise<KitOutcome> {
  const kit = await projectKit(env, project);
  if (!kit.folder) return { ok: false, reason: "undeclared" };
  if (!kit.files.length && kit.versioned.length) return { ok: false, reason: "versioned" };
  if (kit.version && compareVersions(kit.version, KIT_VERSION) >= 0) return { ok: false, reason: "current" };

  const token = await userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
  if (!token) return { ok: false, reason: "signed_out" };
  const repo = project.repo;
  const failed = (response: Response): KitOutcome =>
    response.status === 401 ? { ok: false, reason: "signed_out" } : { ok: false, reason: "refused", status: response.status };

  const head = await githubFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(kit.branch)}`);
  if (!head.ok) return failed(head);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const branch = `fabrique/kit-${KIT_VERSION}-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const created = await githubPost(token, `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!created.ok) return failed(created);

  const marker = project.check?.config?.version?.coulisses ?? null;
  const title = `${marker ? `${marker} ` : ""}La Fabrique: report kit ${KIT_VERSION}`;
  // The files the project keeps, or all of them the first time.
  const targets = kit.files.length
    ? kit.files
    : Object.keys(KIT_SOURCES).map((name) => ({ name, path: `${kit.folder}/${name}`, sha: null as string | null }));
  for (const file of targets) {
    const body = KIT_SOURCES[file.name];
    if (body === undefined) continue;
    const commit = await githubPut(token, `/repos/${repo}/contents/${file.path}`, {
      message: `${title}\n\n${file.name}, from ${kit.version ?? "nothing"} to ${KIT_VERSION}.`,
      content: toBase64(body),
      ...(file.sha ? { sha: file.sha } : {}),
      branch,
    });
    if (!commit.ok) return failed(commit);
  }

  const relay = relayChanges(kit.version);
  const pull = await githubPost(token, `/repos/${repo}/pulls`, {
    title,
    head: branch,
    base: kit.branch,
    body: [
      `Proposed from La Fabrique's Setup tab by @${login}: the report kit in \`${kit.folder}\`, from ${kit.version ?? "nothing"} to ${KIT_VERSION}.`,
      `Files: ${targets.map((file) => `\`${file.name}\``).join(", ")}.`,
      relay.length
        ? `**The relay on the app's server has to follow**, in the same change or before:\n\n${relay.map((line) => `- ${line}`).join("\n")}`
        : "Nothing to change in the relay.",
      "Try it on the integration environment before it goes to production. Guide: `/guide/report-kit` in La Fabrique (docs/report-kit.md).",
    ].join("\n\n"),
  });
  if (!pull.ok) return failed(pull);
  const opened = (await pull.json()) as { number: number; html_url: string };

  await markStale(env.DB, repo, KIT_SNAPSHOT);
  await activityStatement(env.DB, {
    actor: login,
    action: "kit_update_proposed",
    repo,
    issueNumber: opened.number,
    details: { from: kit.version, to: KIT_VERSION, base: kit.branch, folder: kit.folder },
  }).run();
  return { ok: true, number: opened.number, url: opened.html_url, base: kit.branch };
}
