// Used by the release and merge workflows (.github/workflows/release.yml, merge.yml), once the merge to main is done:
//   node --experimental-strip-types scripts/tag-releases.ts [--dry-run] [--since <rev>] [--notes <file>] [--remote <name>]
// Tags every version that reached main with the annotated tag v<version> (message: the release title), on the first
// commit of main (first-parent history) whose release notes carry it, then pushes the tags. Which versions: those of the
// notes at HEAD numbered after the newest version already tagged; with no tag yet, only those the notes gained since
// `--since` (default HEAD^), so history before this script is never tagged. A tag that exists stays where it is. A failed
// push never fails the run: the tags stay local, and the next run sets what is missing. `next` entries get nothing.
import { execFileSync } from "node:child_process";

type Entry = { version: string; titre?: string };

const numbered = /^\d+(\.\d+)+$/;
export const compareVersions = (a: string, b: string): number => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

export const parseNotes = (text: string | null): Entry[] => {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as Entry[];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.version === "string" && numbered.test(e.version)) : [];
  } catch {
    return [];
  }
};

export type Options = { cwd: string; notes: string; since: string; remote: string; dryRun: boolean };
export type Planned = { tag: string; commit: string; message: string };

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd: string, ...args: string[]): string | null => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export const plan = (o: Options): Planned[] => {
  const at = (rev: string) => parseNotes(tryGit(o.cwd, "show", `${rev}:${o.notes}`));
  const head = at("HEAD");
  const tags = new Set(git(o.cwd, "tag", "--list", "v*").split("\n").filter(Boolean));
  const tagged = [...tags].map((t) => t.slice(1)).filter((v) => numbered.test(v));
  let candidates: Entry[];
  if (tagged.length) {
    const floor = tagged.sort(compareVersions).at(-1)!;
    candidates = head.filter((e) => compareVersions(e.version, floor) > 0);
  } else {
    const before = new Set(at(o.since).map((e) => e.version));
    candidates = head.filter((e) => !before.has(e.version));
  }
  const commits = git(o.cwd, "rev-list", "--first-parent", "HEAD").split("\n").filter(Boolean);
  const out: Planned[] = [];
  for (const entry of candidates) {
    const tag = `v${entry.version}`;
    if (tags.has(tag)) continue;
    // The oldest commit, walking back from HEAD, that still carries the version.
    let found: string | null = null;
    for (const c of commits) {
      if (!at(c).some((e) => e.version === entry.version)) break;
      found = c;
    }
    if (found) out.push({ tag, commit: found, message: entry.titre?.trim() || `Release ${entry.version}` });
  }
  return out.sort((a, b) => compareVersions(a.tag.slice(1), b.tag.slice(1)));
};

export const run = (o: Options, log: (line: string) => void = console.log): Planned[] => {
  const planned = plan(o);
  if (o.dryRun) {
    for (const p of planned) log(`would tag ${p.tag} on ${p.commit.slice(0, 7)}: ${p.message}`);
    if (!planned.length) log("no tag to set");
    return planned;
  }
  for (const p of planned) {
    git(o.cwd, "tag", "-a", p.tag, p.commit, "-m", p.message);
    log(`tagged ${p.tag} on ${p.commit.slice(0, 7)}`);
  }
  if (planned.length) {
    try {
      git(o.cwd, "push", o.remote, ...planned.map((p) => `refs/tags/${p.tag}`));
    } catch (error) {
      log(`::warning title=Tags not pushed::${(error as Error).message.split("\n")[0]}; the next run sets them.`);
    }
  }
  return planned;
};

if (process.argv[1]?.endsWith("tag-releases.ts")) {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? fallback) : fallback);
  try {
    run({ cwd: process.cwd(), notes: value("--notes", "docs/release-notes.json"), since: value("--since", "HEAD^"), remote: value("--remote", "origin"), dryRun: args.includes("--dry-run") });
  } catch (error) {
    // Tagging never fails a release.
    console.log(`::warning title=Tagging skipped::${(error as Error).message.split("\n")[0]}`);
  }
}
