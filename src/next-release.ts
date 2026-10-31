import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { githubFetch, githubPost, githubPut } from "./github-app";
import { formatEntry } from "./release-merge";
import type { Project } from "./projects";
import { userToken } from "./session";

export type NextKind = "minor" | "major";

export function readKind(value: unknown): NextKind {
  return value === "major" ? "major" : "minor";
}

// "1.4" → "1.5" (minor) or "2.0" (major); "v1.169" → "v1.170" / "v2.0";
// "0.71" → "0.72" / "1.0". Null when the version has no "major.minor".
export function nextVersion(version: string, kind: NextKind): string | null {
  const match = /^(.*?)(\d+)\.(\d+)(.*)$/.exec(version);
  if (!match) return null;
  const [, before, major, minor, after] = match;
  return kind === "major"
    ? `${before}${Number(major) + 1}.0${after}`
    : `${before}${major}.${Number(minor) + 1}${after}`;
}

// The notes with an empty entry (no `heure`: not released yet) on top.
export function addEmptyRelease(raw: string, version: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  if (data.some((entry) => typeof entry === "object" && entry && String((entry as Record<string, unknown>)["version"] ?? (entry as Record<string, unknown>)["numero"]) === version)) {
    return null;
  }
  const head = formatEntry({ version, titre: "", changements: [], stories: [], liens: null });
  const body = raw.trimStart();
  const rest = body.slice(1).replace(/^\s*\n/, "");
  return rest.trimStart().startsWith("]") ? `[\n${head}\n]\n` : `[\n${head},\n${rest}`;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type NextReleaseOutcome =
  | { ok: true; number: number; url: string; base: string }
  | { ok: false; message: string };

// A pull request on the integration branch, under the person's name, that
// adds the next release with an empty release note. Never a direct write.
export async function proposeNextRelease(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  from: string,
  next: string,
  kind: NextKind,
  now = new Date(),
): Promise<NextReleaseOutcome> {
  const config = project.check?.config;
  const path = config?.version?.fichier;
  const base = config?.branches?.integration;
  if (!path || !base) return { ok: false, message: "The project declares no integration branch or release-notes file (version.fichier): the next release was not proposed." };
  const token = await userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
  if (!token) return { ok: false, message: "Sign in again to propose the next release." };
  const repo = project.repo;
  const refused = (what: string, response: Response) => ({ ok: false as const, message: `GitHub refused ${what} (${response.status}): the next release was not proposed.` });

  const file = await githubFetch(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`);
  if (!file.ok) return refused("reading the release notes", file);
  const content = (await file.json()) as { content: string; sha: string };
  const raw = decoder.decode(Uint8Array.from(atob(content.content.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
  const text = addEmptyRelease(raw, next);
  if (text === null) return { ok: false, message: `The release notes already have ${next} or cannot be read: the next release was not proposed.` };

  const head = await githubFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  if (!head.ok) return refused("reading the integration branch", head);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const branch = `fabrique/next-release-${next.replace(/[^\w.-]/g, "")}-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const created = await githubPost(token, `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!created.ok) return refused("creating the branch", created);

  const marker = config?.version?.coulisses ? `${config.version.coulisses} ` : "";
  const title = `${marker}La Fabrique: open the next release ${next}`;
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  const commit = await githubPut(token, `/repos/${repo}/contents/${path}`, { message: title, content: btoa(binary), sha: content.sha, branch });
  if (!commit.ok) return refused("the commit", commit);
  const pull = await githubPost(token, `/repos/${repo}/pulls`, {
    title,
    head: branch,
    base,
    body: `Proposed from La Fabrique by @${login} with the go to production of ${from}: the next release is ${next} (${kind} increment), with an empty release note (no \`heure\`: not released yet) in \`${path}\`. Fill it in as the work lands.`,
  });
  if (!pull.ok) return refused("the pull request", pull);
  const opened = (await pull.json()) as { number: number; html_url: string };
  await activityStatement(env.DB, {
    actor: login,
    action: "next_release_proposed",
    repo,
    issueNumber: opened.number,
    details: { from, next, kind, base },
  }).run();
  return { ok: true, number: opened.number, url: opened.html_url, base };
}
