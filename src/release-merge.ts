// The release notes of a pull request, numbered and dated when it is merged
// (la-fabrique#113): two pull requests written at the same time both take
// "the next version", and the second always conflicts. At the merge, the
// file is main's, with the pull request's own entries on top, numbered
// after main's newest and dated now. Its own entries: those whose version
// the merge base does not have (an older entry edited on the branch keeps
// main's text). No import: the merge workflow runs it with Node.

type Entry = Record<string, unknown>;

function parse(text: string, name: string): Entry[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`${name}: not a JSON array`);
  return data.filter((entry): entry is Entry => typeof entry === "object" && entry !== null);
}

const versionOf = (entry: Entry): string => String(entry["version"] ?? entry["numero"] ?? "");

// "0.69" + 2 → "0.71"; "v1.169" + 1 → "v1.170": the last number moves.
export function bump(version: string, by: number): string {
  const match = /(\d+)(?!.*\d)/.exec(version);
  if (!match) throw new Error(`No number in version "${version}"`);
  return `${version.slice(0, match.index)}${Number(match[1]) + by}${version.slice(match.index + match[1]!.length)}`;
}

// An entry written as the file writes them: two spaces, arrays of numbers
// on one line.
export function formatEntry(entry: Entry): string {
  return JSON.stringify(entry, null, 2)
    .replace(/\[\s*((?:-?\d+(?:\.\d+)?\s*,\s*)*-?\d+(?:\.\d+)?)\s*\]/g, (_, numbers: string) => `[${numbers.split(/\s*,\s*/).join(", ")}]`)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export interface MergedNotes {
  text: string;
  versions: string[];
}

export function mergeReleaseNotes(base: string, branch: string, main: string, now: { date: string; time: string }, options: { keepNext?: boolean } = { keepNext: true }): MergedNotes {
  const baseEntries = parse(base, "merge base");
  const known = new Set(baseEntries.map(versionOf));
  const knownNext = new Set(baseEntries.filter((entry) => versionOf(entry) === "next").map((entry) => JSON.stringify(entry)));
  // `next` entries are not unique by version: the merge base's own are told apart by content.
  const own = parse(branch, "branch").filter((entry) =>
    versionOf(entry) === "next" ? !knownNext.has(JSON.stringify(entry)) : !known.has(versionOf(entry)),
  );
  const mainEntries = parse(main, "main");
  if (!own.length) return { text: main, versions: [] };
  // A project without integration: merging puts the change online and gives it no number (la-fabrique#139).
  // The entries stay `next` on top of main's; the release at the close of the sprint numbers them.
  if (options.keepNext && own.every((entry) => versionOf(entry) === "next")) {
    const body = main.trimStart();
    if (!body.startsWith("[")) throw new Error("main's release notes do not start with [");
    const rest = body.slice(1).replace(/^\s*\n/, "");
    const head = own.map(formatEntry).join(",\n");
    return { text: rest.trimStart().startsWith("]") ? `[\n${head}\n]\n` : `[\n${head},\n${rest}`, versions: [] };
  }
  const top = mainEntries[0] ? versionOf(mainEntries[0]) : null;
  if (!top) throw new Error("main's release notes have no version to number after");
  const numbered = own.map((entry, index) => {
    const key = "version" in entry || !("numero" in entry) ? "version" : "numero";
    // version, date, heure first, as the file writes them.
    const { [key]: _version, date: _date, heure: _time, ...rest } = entry;
    return { [key]: bump(top, own.length - index), date: now.date, heure: now.time, ...rest };
  });
  const body = main.trimStart();
  if (!body.startsWith("[")) throw new Error("main's release notes do not start with [");
  const rest = body.slice(1).replace(/^\s*\n/, "");
  const head = numbered.map(formatEntry).join(",\n");
  const text = rest.trimStart().startsWith("]") ? `[\n${head}\n]\n` : `[\n${head},\n${rest}`;
  return { text, versions: numbered.map(versionOf) };
}
