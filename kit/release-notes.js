// FabriqueReleaseNotes 1.0.0 — La Fabrique extraordinaire's release-notes tool, the same for every project
// (component release-notes; docs/release-notes-kit.md). La Fabrique uses this very file; a project copies it as it is,
// under the path its .fabrique.json declares (version.outil), and keeps the version on this first line.
// No dependency: Node 22 or later.
//
//   node release-notes.js merge <merge base> <branch> <target> <out> [--mode next|number|release] [--tz Europe/Paris]
//     At the merge of a pull request: the target's release notes (the branch it is merged into), with the pull request's
//     own entries on top. Two pull requests written at the same time both take "the next version" on top of the file:
//     merged line by line, the second always conflicts; rebuilt here, never. Its own entries: those the merge base does
//     not have. An entry of the merge base edited on the branch replaces the target's if the target left it as it was;
//     changed on both sides, the target's stays (and it is said). Modes:
//       next     a project without integration branch, merged into production (La Fabrique, RoadWise): entries written
//                "next" stay "next", without number nor time; the release at the close of the sprint numbers them.
//                Entries numbered by hand are numbered and dated now, as in "release".
//       number   merged into an integration branch (L'épicerie): numbered after the target's newest, dated today, no
//                time (the time says "in production"; the go gives it).
//       release  numbered after the target's newest, dated and timed now.
//     Prints the versions given (none: nothing).
//   node release-notes.js publish <notes file> <version> <title> <stories, comma-separated> [titles.json] [--tz …]
//     At the close of a sprint, on a project without integration branch: the "next" entries that declare a story done
//     become one entry (the version, the date and time, the title, every change, the stories done); an entry with a
//     story not done goes out marked partial; the other "next" entries stay on top. Prints how many it took and kept.
//
// The file: a JSON array, newest first, one entry per block (two spaces, then {). Only the entries that change are
// rewritten; the rest keeps its text.

export const VERSION = "1.0.0";

const NUMBER = /(\d+)(?!.*\d)/;

const versionOf = (entry) => String(entry.version ?? entry.numero ?? "");
const isNext = (entry) => versionOf(entry) === "next";

// "0.69" + 2 → "0.71"; "v1.169" + 1 → "v1.170": the last number moves.
export function bump(version, by) {
  const match = NUMBER.exec(version);
  if (!match) throw new Error(`No number in version "${version}"`);
  return `${version.slice(0, match.index)}${Number(match[1]) + by}${version.slice(match.index + match[1].length)}`;
}

// An entry written as the file writes them: two spaces, arrays of numbers on one line.
export function formatEntry(entry) {
  return JSON.stringify(entry, null, 2)
    .replace(/\[\s*((?:-?\d+(?:\.\d+)?\s*,\s*)*-?\d+(?:\.\d+)?)\s*\]/g, (_, numbers) => `[${numbers.split(/\s*,\s*/).join(", ")}]`)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function parse(text, name) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`${name}: not a JSON array`);
  return data.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

// The text of each entry, as written, or null when the file is not written one entry per block.
function blocks(text, count) {
  const starts = [...text.matchAll(/^ {2}\{\s*$/gm)].map((match) => match.index ?? 0);
  if (starts.length !== count) return null;
  const end = text.trimEnd().lastIndexOf("]");
  return starts.map((start, i) => text.slice(start, i + 1 < starts.length ? starts[i + 1] : end).trimEnd().replace(/,$/, "").trimEnd());
}

const write = (parts) => (parts.length ? `[\n${parts.join(",\n")}\n]\n` : "[]\n");

// What tells an entry apart: its version, or, for a "next" entry, its title and stories.
const keyOf = (entry) => (isNext(entry) ? `next:${String(entry.titre ?? "")}:${JSON.stringify(entry.stories ?? [])}` : `v:${versionOf(entry)}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A version X.0 whose major is above the target's newest.
function majorAbove(version, top) {
  const parts = (value) => (/(\d+)\.(\d+)(?!.*\d)/.exec(value) ?? []).slice(1).map(Number);
  const [major, minor] = parts(version);
  const [topMajor] = parts(top);
  return major !== undefined && topMajor !== undefined && minor === 0 && major > topMajor;
}

/**
 * The target's release notes with the pull request's own entries on top.
 * `now`: { date: "YYYY-MM-DD", time: "HH:MM" }; `options.mode`: "next" (default), "number" or "release".
 */
export function mergeReleaseNotes(base, branch, target, now, options = {}) {
  const mode = options.mode ?? "next";
  if (!["next", "number", "release"].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
  const baseEntries = parse(base, "merge base");
  const branchEntries = parse(branch, "branch");
  const targetEntries = parse(target, "target");
  const known = new Map(baseEntries.map((entry) => [keyOf(entry), entry]));

  const own = branchEntries.filter((entry) => !known.has(keyOf(entry)));
  const edited = branchEntries.filter((entry) => known.has(keyOf(entry)) && !same(entry, known.get(keyOf(entry))));

  const result = [...targetEntries];
  const rewritten = new Set();
  const conflicts = [];
  for (const entry of edited) {
    const at = result.findIndex((candidate) => keyOf(candidate) === keyOf(entry));
    if (at < 0 || same(result[at], entry)) continue;
    if (!same(result[at], known.get(keyOf(entry)))) {
      conflicts.push(isNext(entry) ? String(entry.titre ?? "next") : versionOf(entry));
      continue;
    }
    result[at] = entry;
    rewritten.add(at);
  }
  if (!own.length && !rewritten.size) return { text: target, versions: [], conflicts };

  let fresh;
  let versions = [];
  if (mode === "next" && own.every(isNext)) {
    fresh = own;
  } else {
    const top = targetEntries.find((entry) => !isNext(entry));
    if (!top) throw new Error("The target's release notes have no version to number after");
    const topVersion = versionOf(top);
    const written = own.map(versionOf);
    // A major version written by hand (X.0 above the target's newest) is kept as written.
    const byHand = !written.includes("next") && new Set(written).size === written.length && majorAbove(written[written.length - 1], topVersion);
    versions = byHand ? written : own.map((_, i) => bump(topVersion, own.length - i));
    fresh = own.map((entry, i) => {
      const key = "version" in entry || !("numero" in entry) ? "version" : "numero";
      // version, date, heure first, as the file writes them.
      const { [key]: _version, date: _date, heure: _time, ...rest } = entry;
      return mode === "number"
        ? { [key]: versions[i], date: now.date, ...rest }
        : { [key]: versions[i], date: now.date, heure: now.time, ...rest };
    });
  }

  // `next` entries of the target stay on top of the numbered ones.
  const pending = result.filter(isNext).length;
  const head = mode === "next" ? 0 : pending;
  const texts = blocks(target, targetEntries.length);
  const body = result.map((entry, i) => (texts && !rewritten.has(i) ? texts[i] : formatEntry(entry)));
  const text = write([...body.slice(0, head), ...fresh.map(formatEntry), ...body.slice(head)]);
  JSON.parse(text);
  return { text, versions, conflicts };
}

const storiesOf = (entry) =>
  Array.isArray(entry.stories) ? entry.stories.map((value) => Number(String(value).replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0) : [];
const texts = (value) => (Array.isArray(value) ? value.filter((change) => typeof change === "string") : []);

/**
 * The release made when the sprint closes. `input`: { version, title, stories: number[], now: { date, time },
 * titles?: { "139": "Title of #139" } } (titles of the stories not done, for the caveat).
 */
export function publishRelease(text, input) {
  const entries = parse(text, "release notes");
  if (entries.some((entry) => versionOf(entry) === input.version)) throw new Error(`Version ${input.version} is already in the release notes`);
  const done = new Set(input.stories);
  const drafts = entries.filter(isNext);
  const released = entries.filter((entry) => !isNext(entry));
  const taken = drafts.filter((entry) => storiesOf(entry).some((number) => done.has(number)));
  const kept = drafts.filter((entry) => !taken.includes(entry));
  if (!taken.length) throw new Error("No `next` entry declares a story done: nothing to release");
  const caveat = (entry) => {
    const missing = storiesOf(entry).filter((number) => !done.has(number));
    if (!missing.length) return [];
    const named = missing.map((number) => (input.titles?.[String(number)] ? `#${number} ${input.titles[String(number)]}` : `#${number}`)).join("; ");
    return [`Partial: not done yet, ${named}.`];
  };
  // Public changes and changes behind the scenes (`coulisses`) stay apart; an entry with only the latter keeps its
  // caveat behind the scenes too.
  const changes = taken.flatMap((entry) => {
    const own = texts(entry.changements);
    return own.length ? [...own, ...caveat(entry)] : [];
  });
  const backstage = taken.flatMap((entry) => {
    const own = texts(entry.coulisses);
    return texts(entry.changements).length ? own : [...own, ...(own.length ? caveat(entry) : [])];
  });
  const release = {
    version: input.version,
    date: input.now.date,
    heure: input.now.time,
    titre: input.title,
    changements: changes,
    ...(backstage.length ? { coulisses: backstage } : {}),
    stories: [...done].sort((a, b) => a - b),
    liens: null,
  };
  // The released entries keep their text as it is: only the head changes.
  const all = blocks(text, entries.length);
  if (!all) throw new Error("The release notes are not written one entry per block (two spaces, then {)");
  const rest = entries.map((entry, i) => (isNext(entry) ? null : all[i])).filter((block) => block !== null);
  if (released.length && entries.findIndex((entry) => !isNext(entry)) < drafts.length) {
    throw new Error("The `next` entries are not all on top of the release notes");
  }
  return { text: write([...kept, release].map(formatEntry).concat(rest)), taken: taken.length, kept: kept.length };
}

// The date and the time now, in a time zone.
export function nowIn(timeZone = "Europe/Paris", date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function main(argv) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else args.push(argv[i]);
  }
  const now = nowIn(flags.tz);
  const [command, ...rest] = args;
  if (command === "merge" && rest.length === 4) {
    const [base, branch, target, out] = rest;
    const merged = mergeReleaseNotes(readFileSync(base, "utf8"), readFileSync(branch, "utf8"), readFileSync(target, "utf8"), now, { mode: flags.mode ?? "next" });
    writeFileSync(out, merged.text);
    for (const version of merged.conflicts) console.error(`${version}: edited on the branch and on the target; the target's text stays.`);
    console.log(merged.versions.join(" "));
    return;
  }
  if (command === "publish" && (rest.length === 4 || rest.length === 5)) {
    const [file, version, title, stories, titles] = rest;
    const published = publishRelease(readFileSync(file, "utf8"), {
      version,
      title,
      stories: stories.split(",").map((value) => Number(value.trim().replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0),
      now,
      ...(titles ? { titles: JSON.parse(readFileSync(titles, "utf8")) } : {}),
    });
    writeFileSync(file, published.text);
    console.log(`taken ${published.taken}, kept ${published.kept}`);
    return;
  }
  console.error("usage: release-notes.js merge <merge base> <branch> <target> <out> [--mode next|number|release] [--tz zone]\n"
    + "       release-notes.js publish <notes file> <version> <title> <stories, comma-separated> [titles.json] [--tz zone]");
  process.exit(2);
}

if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
