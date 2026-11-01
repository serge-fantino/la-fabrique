import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import ownConfig from "../.fabrique.json";
import releaseNotes from "../docs/release-notes.json";
import { validateFabriqueConfig } from "../src/fabrique-config";
import { parseReleases } from "../src/roadmap";

describe("La Fabrique as its own project", () => {
  it("has a valid .fabrique.json", () => {
    const files = [
      ".fabrique.json",
      "CLAUDE.md",
      "README.md",
      "docs/fabrique-json.md",
      "docs/release-notes.json",
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
      ".github/workflows/claude.yml",
      ".github/workflows/merge.yml",
    ];
    const result = validateFabriqueConfig(JSON.stringify(ownConfig), {
      files: new Set(files),
      folders: new Set(["docs", ".github", ".github/workflows"]),
      complete: true,
    });
    expect(result.errors).toEqual([]);
  });

  it("keeps release notes in the Fabrique format: newest first, unique, dated on main", () => {
    const all = parseReleases(JSON.stringify(releaseNotes));
    expect(all).toHaveLength(releaseNotes.length);
    // A pull request does not number its entry: "next", no time; the merge
    // workflow numbers and dates it (scripts/release-at-merge.ts). Only on
    // top, and never on main.
    const drafts = all.filter((release) => release.version === "next");
    expect(all.slice(0, drafts.length).every((release) => release.version === "next"), "the entries to number are on top").toBe(true);
    for (const draft of drafts) expect(draft.time, "an entry to number has no time yet").toBeNull();
    const releases = all.slice(drafts.length);
    expect(new Set(releases.map((release) => release.version)).size).toBe(releases.length);
    for (const release of all) {
      expect(release.changes.length, `version ${release.version} has no change`).toBeGreaterThan(0);
    }
    for (const release of releases) {
      expect(release.time, `version ${release.version} has no time`).toMatch(/^\d{2}:\d{2}$/);
    }
    // From 0.45, each entry declares the stories it brings (possibly none).
    for (const release of releases.filter((candidate) => Number(candidate.version.split(".")[1]) >= 45)) {
      expect(release.stories, `version ${release.version} does not declare its stories`).not.toBeNull();
    }
    for (const draft of drafts) {
      expect(draft.stories, "an entry to number declares its stories").not.toBeNull();
    }
    const stamps = releases.map((release) => `${release.date}T${release.time}`);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it("answers its version number with the deployed commit", async () => {
    const body = (await (await SELF.fetch("https://la-fabrique.test/api/version")).json()) as Record<string, unknown>;
    const drafts = releaseNotes.filter((note) => note.version === "next").length;
    const last = releaseNotes.find((note) => note.version !== "next")?.version;
    expect(body).toEqual({ numero: drafts ? `${last} + ${drafts} ${drafts === 1 ? "change" : "changes"}` : last, commit: "test-commit" });
  });
});
