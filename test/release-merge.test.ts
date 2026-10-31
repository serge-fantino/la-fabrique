import { describe, expect, it } from "vitest";
import { bump, formatEntry, mergeReleaseNotes } from "../src/release-merge";

const entry = (version: string, titre: string, extra: Record<string, unknown> = {}) => ({ version, date: "2026-10-30", heure: "10:00", titre, changements: [titre], stories: [], liens: null, ...extra });
const file = (...entries: Record<string, unknown>[]) => `[\n${entries.map(formatEntry).join(",\n")}\n]\n`;
const NOW = { date: "2026-10-31", time: "18:05" };

describe("Release notes numbered at the merge", () => {
  it("puts the pull request's entries on top of main's, numbered after main's newest and dated now", () => {
    const base = file(entry("0.65", "Runs"));
    // Both took 0.66 while they were written; main merged its own first.
    const branch = file(entry("0.66", "The go", { stories: [102] }), entry("0.65", "Runs"));
    const main = file(entry("0.67", "What's new"), entry("0.66", "Live sprint"), entry("0.65", "Runs"));
    const merged = mergeReleaseNotes(base, branch, main, NOW);
    expect(merged.versions).toEqual(["0.68"]);
    const result = JSON.parse(merged.text) as Record<string, unknown>[];
    expect(result.map((e) => e["version"])).toEqual(["0.68", "0.67", "0.66", "0.65"]);
    expect(result[0]).toEqual({ ...entry("0.68", "The go", { stories: [102] }), date: "2026-10-31", heure: "18:05" });
    // main's text is kept as it is, below.
    expect(merged.text.endsWith(main.slice(2))).toBe(true);
    expect(merged.text).toContain('    "stories": [102],\n');
  });

  it("numbers several entries in order, and leaves main alone when the branch adds none", () => {
    const base = file(entry("v1.169", "A"));
    const branch = file(entry("v1.171", "C"), entry("v1.170", "B"), entry("v1.169", "A, edited on the branch"));
    const main = file(entry("v1.170", "Other"), entry("v1.169", "A"));
    const merged = mergeReleaseNotes(base, branch, main, NOW);
    expect(merged.versions).toEqual(["v1.172", "v1.171"]);
    expect((JSON.parse(merged.text) as { titre: string }[]).map((e) => e.titre)).toEqual(["C", "B", "Other", "A"]);
    expect(mergeReleaseNotes(base, base, main, NOW)).toEqual({ text: main, versions: [] });
  });

  it("numbers the entries a pull request wrote as next, without a time, and puts the time after the date", () => {
    const base = file(entry("0.75", "Go"));
    const draft = { version: "next", date: "2026-11-01", titre: "One status", changements: ["One status."], stories: [113], liens: null };
    const merged = mergeReleaseNotes(base, file(draft, draft, entry("0.75", "Go")), file(entry("0.75", "Go")), NOW);
    expect(merged.versions).toEqual(["0.77", "0.76"]);
    expect(merged.text.startsWith('[\n  {\n    "version": "0.77",\n    "date": "2026-10-31",\n    "heure": "18:05",\n    "titre": "One status",')).toBe(true);
  });

  it("bumps the last number of a version", () => {
    expect(bump("0.69", 1)).toBe("0.70");
    expect(bump("v1.169", 3)).toBe("v1.172");
    expect(() => bump("next", 1)).toThrow("No number");
  });
});
