import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { READY_CHECKS, validateFabriqueConfig, type FabriqueConfig, type ReadyCheck } from "./fabrique-config";
import { refreshUserToken } from "./github";
import { githubFetch, githubPost, githubPut } from "./github-app";
import { productionBranch, type Project } from "./projects";
import { userToken } from "./session";

type Cycle = NonNullable<FabriqueConfig["cycle"]>;

interface Member {
  key: string;
  valueStart: number;
  valueEnd: number;
}

// The members of the top-level object, with where each value sits, so one
// can be replaced without reformatting the rest of the file.
function topLevelMembers(raw: string): { members: Member[]; close: number } | null {
  let i = raw.indexOf("{");
  if (i < 0) return null;
  const members: Member[] = [];
  const skipString = (start: number): number => {
    let j = start + 1;
    while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  i++;
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i] ?? "")) i++;
    if (raw[i] === "}") return { members, close: i };
    if (raw[i] !== '"') return null;
    const keyEnd = skipString(i);
    const key = JSON.parse(raw.slice(i, keyEnd)) as string;
    i = raw.indexOf(":", keyEnd) + 1;
    while (/\s/.test(raw[i] ?? "")) i++;
    const valueStart = i;
    let depth = 0;
    while (i < raw.length) {
      const char = raw[i];
      if (char === '"') {
        i = skipString(i);
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (depth === 0) break;
        depth--;
      } else if (char === "," && depth === 0) break;
      i++;
    }
    let valueEnd = i;
    while (/\s/.test(raw[valueEnd - 1] ?? "")) valueEnd--;
    members.push({ key, valueStart, valueEnd });
  }
  return null;
}

// Sets one top-level member of a JSON object file, keeping the rest of the
// text as it is (a new member goes last, with the file's indentation).
export function setTopLevelMember(raw: string, key: string, value: string): string {
  const parsed = topLevelMembers(raw);
  if (!parsed) throw new Error("The file is not a JSON object.");
  const existing = parsed.members.find((member) => member.key === key);
  if (existing) return raw.slice(0, existing.valueStart) + value + raw.slice(existing.valueEnd);
  const last = parsed.members.at(-1);
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
  const entry = `"${key}": ${value}`;
  if (!last) return `${raw.slice(0, parsed.close)}\n${indent}${entry}\n${raw.slice(parsed.close)}`;
  return `${raw.slice(0, last.valueEnd)},\n${indent}${entry}${raw.slice(last.valueEnd)}`;
}

export function cycleJson(cycle: Cycle): string {
  const list = (items: string[]) => `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
  return `{ "pret": ${list(cycle.pret ?? [])}, "priorites": ${list(cycle.priorites ?? [])} }`;
}

// The form's answer, checked: known checks, priority labels without
// duplicates or characters GitHub labels refuse.
export function readCycleForm(form: FormData): { cycle: Cycle } | { error: string } {
  const known = new Set<string>(READY_CHECKS);
  const pret = form.getAll("pret").map(String).filter((check): check is ReadyCheck => known.has(check));
  const priorites = [
    ...new Set(
      String(form.get("priorites") ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
  if (priorites.length > 6) return { error: "Six priority labels at most." };
  if (priorites.some((label) => label.length > 50)) return { error: "A priority label is 50 characters at most." };
  if (pret.includes("priorite") && !priorites.length) return { error: "A priority is required to be ready, but no priority label is given." };
  return { cycle: { pret, priorites } };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function fromBase64(text: string): string {
  return decoder.decode(Uint8Array.from(atob(text.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type ProposeOutcome =
  | { ok: true; number: number; url: string; base: string }
  | { ok: false; reason: "signed_out" | "unchanged" | "refused" | "invalid"; message?: string; status?: number };

// Proposes the new lifecycle as a pull request on the project, under the
// person's own GitHub name: a branch, one commit on .fabrique.json, a PR
// on integration (or production). Nothing reaches production without the
// project's own review and merge.
export async function proposeCycle(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  cycle: Cycle,
  now = new Date(),
): Promise<ProposeOutcome> {
  const token = await userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
  if (!token) return { ok: false, reason: "signed_out" };
  const repo = project.repo;
  const base = project.check?.config?.branches?.integration ?? productionBranch(project) ?? "main";
  const failed = (response: Response): ProposeOutcome =>
    response.status === 401 ? { ok: false, reason: "signed_out" } : { ok: false, reason: "refused", status: response.status };

  const fileResponse = await githubFetch(token, `/repos/${repo}/contents/.fabrique.json?ref=${encodeURIComponent(base)}`);
  if (!fileResponse.ok) return failed(fileResponse);
  const file = (await fileResponse.json()) as { content: string; sha: string };
  const raw = fromBase64(file.content);
  let next: string;
  try {
    next = setTopLevelMember(raw, "cycle", cycleJson(cycle));
    JSON.parse(next);
  } catch (error) {
    return { ok: false, reason: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  if (next === raw) return { ok: false, reason: "unchanged" };
  const errors = validateFabriqueConfig(next, { files: new Set(), folders: new Set(), complete: false }).errors.filter((error) =>
    error.includes("cycle"),
  );
  if (errors.length) return { ok: false, reason: "invalid", message: errors.join(" ") };

  const head = await githubFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  if (!head.ok) return failed(head);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const branch = `fabrique/cycle-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const created = await githubPost(token, `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!created.ok) return failed(created);

  // The project's marker for commits that change nothing a user sees.
  const coulisses = project.check?.config?.version?.coulisses;
  const marker = coulisses ? `${coulisses} ` : "";
  const summary = `Ready: ${(cycle.pret ?? []).join(", ") || "nothing required"}; priorities: ${(cycle.priorites ?? []).join(", ") || "none"}.`;
  const commit = await githubPut(token, `/repos/${repo}/contents/.fabrique.json`, {
    message: `${marker}La Fabrique: story lifecycle in .fabrique.json\n\n${summary}`,
    content: toBase64(next),
    sha: file.sha,
    branch,
  });
  if (!commit.ok) return failed(commit);
  const pull = await githubPost(token, `/repos/${repo}/pulls`, {
    title: `${marker}La Fabrique: story lifecycle (.fabrique.json)`,
    head: branch,
    base,
    body: `Proposed from La Fabrique's Setup tab by @${login}.\n\n${summary}\n\nThe Definition of Ready and the priority labels apply once this change reaches the production branch. Format: \`cycle\` in docs/fabrique-json.md of La Fabrique.`,
  });
  if (!pull.ok) return failed(pull);
  const opened = (await pull.json()) as { number: number; html_url: string };

  await activityStatement(env.DB, {
    actor: login,
    action: "config_change_proposed",
    repo,
    issueNumber: opened.number,
    details: { key: "cycle", base, cycle },
  }).run();
  return { ok: true, number: opened.number, url: opened.html_url, base };
}
