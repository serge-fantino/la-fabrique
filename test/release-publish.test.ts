import { describe, expect, it } from "vitest";
import releaseNotes from "../docs/release-notes.json";
import { formatEntry } from "../src/release-merge";
import { publishRelease } from "../src/release-publish";

const NOW = { date: "2026-11-01", time: "10:30" };
const draft = (titre: string, stories: number[]) => ({ version: "next", date: "2026-11-01", titre, changements: [`${titre}.`], stories, liens: null });
// An old entry written on one line per field, as the file has them.
const OLD = '  {\n    "version": "0.78",\n    "date": "2026-11-01",\n    "heure": "00:26",\n    "titre": "Old",\n    "changements": ["Old."],\n    "stories": [113],\n    "liens": null\n  }';
const file = (...drafts: Record<string, unknown>[]) => `[\n${[...drafts.map(formatEntry), OLD].join(",\n")}\n]\n`;

describe("The release made when the sprint closes", () => {
  it("turns the next entries that declare a story done into one entry, keeps the others next, and leaves the old entries as written", () => {
    const text = file(draft("Later", [140]), draft("Close the sprint", [137]), draft("Warn", [138, 139]));
    const out = publishRelease(text, { version: "0.79", title: "Releases at the sprint's close", stories: [137, 138], now: NOW, titles: { "139": "Hide released stories" } });
    expect(out).toMatchObject({ taken: 2, kept: 1 });
    const notes = JSON.parse(out.text) as Record<string, unknown>[];
    expect(notes.map((entry) => entry["version"])).toEqual(["next", "0.79", "0.78"]);
    expect(notes[1]).toEqual({
      version: "0.79",
      date: "2026-11-01",
      heure: "10:30",
      titre: "Releases at the sprint's close",
      changements: ["Close the sprint.", "Warn.", "Partial: not done yet, #139 Hide released stories."],
      stories: [137, 138],
      liens: null,
    });
    // The old entry keeps its text.
    expect(out.text.endsWith(`${OLD}\n]\n`)).toBe(true);
  });

  it("refuses a version already out, or a release with nothing in it", () => {
    const text = file(draft("Close the sprint", [137]));
    expect(() => publishRelease(text, { version: "0.78", title: "x", stories: [137], now: NOW })).toThrow("already in the release notes");
    expect(() => publishRelease(text, { version: "0.79", title: "x", stories: [999], now: NOW })).toThrow("nothing to release");
  });

  it("works on La Fabrique's own release notes", () => {
    const text = `${JSON.stringify(releaseNotes, null, 2)}\n`;
    const drafts = releaseNotes.filter((entry) => entry.version === "next");
    if (!drafts.length) return;
    const stories = [...new Set(drafts.flatMap((entry) => entry.stories ?? []))];
    const out = publishRelease(text, { version: "9.0", title: "Test", stories, now: NOW });
    expect(out.kept).toBe(0);
    expect((JSON.parse(out.text) as { version: string }[])[0]?.version).toBe("9.0");
  });
});
