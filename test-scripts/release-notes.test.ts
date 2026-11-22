// Run by `npm test` with node:test. kit/release-notes.js is the release-notes tool of every project (La Fabrique's own
// merge and release workflows, and the copy each project keeps): the merge of a pull request's entries, numbered or
// not, and the release of a sprint.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { VERSION, bump, formatEntry, mergeReleaseNotes, publishRelease } from "../kit/release-notes.js";
import { formatEntry as workerFormatEntry } from "../src/release-entry.ts";

type Entry = Record<string, unknown>;
const entry = (version: string, titre: string, extra: Entry = {}): Entry => ({ version, date: "2026-10-30", heure: "10:00", titre, changements: [titre], stories: [], liens: null, ...extra });
const file = (...entries: Entry[]) => `[\n${entries.map(formatEntry).join(",\n")}\n]\n`;
const NOW = { date: "2026-10-31", time: "18:05" };
const KIT = new URL("../kit/release-notes.js", import.meta.url).pathname;
const parse = (text: string) => JSON.parse(text) as Entry[];

describe("The merge of a pull request's release notes", () => {
  test("release: puts the pull request's entries on top of the target's, numbered after its newest and dated now", () => {
    const base = file(entry("0.65", "Runs"));
    // Both took 0.66 while they were written; main merged its own first.
    const branch = file(entry("0.66", "The go", { stories: [102] }), entry("0.65", "Runs"));
    const main = file(entry("0.67", "What's new"), entry("0.66", "Live sprint"), entry("0.65", "Runs"));
    const merged = mergeReleaseNotes(base, branch, main, NOW, { mode: "release" });
    assert.deepEqual(merged.versions, ["0.68"]);
    const result = parse(merged.text);
    assert.deepEqual(result.map((e) => e["version"]), ["0.68", "0.67", "0.66", "0.65"]);
    assert.deepEqual(result[0], { ...entry("0.68", "The go", { stories: [102] }), date: "2026-10-31", heure: "18:05" });
    // The target's text is kept as it is, below.
    assert.ok(merged.text.endsWith(main.slice(2)));
    assert.ok(merged.text.includes('    "stories": [102],\n'));
  });

  test("numbers several entries in order, applies an older entry edited on the branch, leaves the target alone when nothing changes", () => {
    const base = file(entry("v1.169", "A"));
    const branch = file(entry("v1.171", "C"), entry("v1.170", "B"), entry("v1.169", "A, edited on the branch"));
    const main = file(entry("v1.170", "Other"), entry("v1.169", "A"));
    const merged = mergeReleaseNotes(base, branch, main, NOW, { mode: "release" });
    assert.deepEqual(merged.versions, ["v1.172", "v1.171"]);
    assert.deepEqual(parse(merged.text).map((e) => e["titre"]), ["C", "B", "Other", "A, edited on the branch"]);
    assert.deepEqual(mergeReleaseNotes(base, base, main, NOW, { mode: "release" }), { text: main, versions: [], conflicts: [] });
  });

  test("an entry edited on both sides keeps the target's text, and says so", () => {
    const base = file(entry("0.70", "A"));
    const merged = mergeReleaseNotes(base, file(entry("0.70", "A, branch")), file(entry("0.70", "A, main")), NOW);
    assert.deepEqual(parse(merged.text).map((e) => e["titre"]), ["A, main"]);
    assert.deepEqual(merged.conflicts, ["0.70"]);
  });

  test("release: numbers the entries a pull request wrote as next, and puts the time after the date", () => {
    const base = file(entry("0.75", "Go"));
    const draft = { version: "next", date: "2026-11-01", titre: "One status", changements: ["One status."], stories: [113], liens: null };
    const merged = mergeReleaseNotes(base, file(draft, { ...draft, titre: "Two" }, entry("0.75", "Go")), file(entry("0.75", "Go")), NOW, { mode: "release" });
    assert.deepEqual(merged.versions, ["0.77", "0.76"]);
    assert.ok(merged.text.startsWith('[\n  {\n    "version": "0.77",\n    "date": "2026-10-31",\n    "heure": "18:05",\n    "titre": "One status",'));
  });

  test("next (the default): keeps the entries next on top of the target's, without a number", () => {
    const old = { version: "next", date: "2026-10-31", titre: "Already online", changements: ["Online."], stories: [1], liens: null };
    const draft = { version: "next", date: "2026-11-01", titre: "New", changements: ["New."], stories: [139], liens: null };
    const base = file(old, entry("0.78", "Go"));
    const merged = mergeReleaseNotes(base, file(draft, old, entry("0.78", "Go")), file(old, entry("0.78", "Go")), NOW);
    assert.deepEqual(merged.versions, []);
    const result = parse(merged.text);
    assert.deepEqual(result.map((e) => e["titre"]), ["New", "Already online", "Go"]);
    assert.deepEqual(result[0], draft);
  });

  test("number (into an integration branch): two stories that took the same number, numbered after it, dated, without a time", () => {
    const online = entry("1.175", "Online");
    const int = { version: "1.176", date: "2026-11-21", titre: "On int", changements: ["On int."], stories: [246] };
    const story = (n: number) => ({ version: "1.177", date: "2026-11-21", titre: `Story ${n}`, changements: [`Story ${n}.`], stories: [n] });
    const base = file(int, online);
    const integration = file(story(249), int, online);
    const merged = mergeReleaseNotes(base, file(story(251), int, online), integration, NOW, { mode: "number" });
    assert.deepEqual(merged.versions, ["1.178"]);
    const result = parse(merged.text);
    assert.deepEqual(result[0], { version: "1.178", date: "2026-10-31", titre: "Story 251", changements: ["Story 251."], stories: [251] });
    assert.deepEqual(result.map((e) => e["version"]), ["1.178", "1.177", "1.176", "1.175"]);
    assert.ok(merged.text.endsWith(integration.slice(2)));
    // Written next on the branch: numbered the same way.
    const next = mergeReleaseNotes(base, file({ ...story(252), version: "next" }, int, online), integration, NOW, { mode: "number" });
    assert.deepEqual(next.versions, ["1.178"]);
  });

  test("a major version written by hand is kept", () => {
    const base = file(entry("1.176", "A"));
    const merged = mergeReleaseNotes(base, file(entry("2.0", "Big"), entry("1.176", "A")), file(entry("1.177", "B"), entry("1.176", "A")), NOW, { mode: "number" });
    assert.deepEqual(merged.versions, ["2.0"]);
  });

  test("bumps the last number of a version", () => {
    assert.equal(bump("0.69", 1), "0.70");
    assert.equal(bump("v1.169", 3), "v1.172");
    assert.throws(() => bump("next", 1), /No number/);
  });

  test("runs as a command, as the projects' workflows run it", () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    const base = file(entry("0.10", "A"));
    writeFileSync(join(dir, "base.json"), base);
    writeFileSync(join(dir, "branch.json"), file(entry("0.11", "Mine"), entry("0.10", "A")));
    writeFileSync(join(dir, "target.json"), file(entry("0.11", "Theirs"), entry("0.10", "A")));
    const out = execFileSync("node", [KIT, "merge", ...["base", "branch", "target", "out"].map((name) => join(dir, `${name}.json`)), "--mode", "number"], { encoding: "utf8" });
    assert.equal(out.trim(), "0.12");
    assert.deepEqual(parse(readFileSync(join(dir, "out.json"), "utf8")).map((e) => e["titre"]), ["Mine", "Theirs", "A"]);
  });
});

describe("The release made when the sprint closes", () => {
  const draft = (titre: string, stories: number[]) => ({ version: "next", date: "2026-11-01", titre, changements: [`${titre}.`], stories, liens: null });
  // An old entry written on one line per field, as the file has them.
  const OLD = '  {\n    "version": "0.78",\n    "date": "2026-11-01",\n    "heure": "00:26",\n    "titre": "Old",\n    "changements": ["Old."],\n    "stories": [113],\n    "liens": null\n  }';
  const notes = (...drafts: Entry[]) => `[\n${[...drafts.map(formatEntry), OLD].join(",\n")}\n]\n`;
  const AT = { date: "2026-11-01", time: "10:30" };

  test("turns the next entries that declare a story done into one entry, keeps the others next, and leaves the old entries as written", () => {
    const text = notes(draft("Later", [140]), draft("Close the sprint", [137]), draft("Warn", [138, 139]));
    const out = publishRelease(text, { version: "0.79", title: "Releases at the sprint's close", stories: [137, 138], now: AT, titles: { "139": "Hide released stories" } });
    assert.equal(out.taken, 2);
    assert.equal(out.kept, 1);
    const result = parse(out.text);
    assert.deepEqual(result.map((e) => e["version"]), ["next", "0.79", "0.78"]);
    assert.deepEqual(result[1], {
      version: "0.79",
      date: "2026-11-01",
      heure: "10:30",
      titre: "Releases at the sprint's close",
      changements: ["Close the sprint.", "Warn.", "Partial: not done yet, #139 Hide released stories."],
      stories: [137, 138],
      liens: null,
    });
    assert.ok(out.text.endsWith(`${OLD}\n]\n`));
  });

  test("keeps the changes behind the scenes apart, public changes in changements, the others in coulisses", () => {
    const backstage = (titre: string, stories: number[]) => ({ version: "next", date: "2026-11-01", titre, changements: [], coulisses: [`${titre}.`], stories, liens: null });
    const result = parse(publishRelease(notes(draft("Visible", [140]), backstage("Hidden", [141, 142])), { version: "0.79", title: "Mixed", stories: [140, 141], now: AT }).text);
    assert.deepEqual(result[0]?.["changements"], ["Visible."]);
    assert.deepEqual(result[0]?.["coulisses"], ["Hidden.", "Partial: not done yet, #142."]);
    const plain = parse(publishRelease(notes(draft("Visible", [140])), { version: "0.79", title: "x", stories: [140], now: AT }).text);
    assert.ok(!("coulisses" in (plain[0] ?? {})));
  });

  test("refuses a version already out, or a release with nothing in it", () => {
    const text = notes(draft("Close the sprint", [137]));
    assert.throws(() => publishRelease(text, { version: "0.78", title: "x", stories: [137], now: AT }), /already in the release notes/);
    assert.throws(() => publishRelease(text, { version: "0.79", title: "x", stories: [999], now: AT }), /nothing to release/);
  });

  test("works on La Fabrique's own release notes", () => {
    const own = readFileSync(new URL("../docs/release-notes.json", import.meta.url), "utf8");
    const drafts = parse(own).filter((e) => e["version"] === "next");
    if (!drafts.length) return;
    const stories = [...new Set(drafts.flatMap((e) => (e["stories"] as number[] | undefined) ?? []))];
    const out = publishRelease(own, { version: "9.0", title: "Test", stories, now: AT });
    // An entry that declares no story stays next: nothing says it is done.
    assert.equal(out.kept, drafts.filter((e) => !((e["stories"] as number[] | undefined) ?? []).length).length);
    assert.equal(parse(out.text).find((e) => e["version"] !== "next")?.["version"], "9.0");
  });
});

describe("The tool itself", () => {
  test("says its version on its first line", () => {
    const first = readFileSync(KIT, "utf8").split("\n")[0] ?? "";
    assert.ok(first.startsWith(`// FabriqueReleaseNotes ${VERSION} `), first);
  });

  test("the Worker writes an entry as the tool does", () => {
    const sample = { version: "1.2", titre: "x", changements: [], stories: [1, 22], liens: null };
    assert.equal(workerFormatEntry(sample), formatEntry(sample));
  });

  test("a merge with no change of La Fabrique's own file gives it back as it is", () => {
    const own = readFileSync(new URL("../docs/release-notes.json", import.meta.url), "utf8");
    assert.equal(mergeReleaseNotes(own, own, own, NOW).text, own);
  });
});
