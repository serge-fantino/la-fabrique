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
    const releases = parseReleases(JSON.stringify(releaseNotes));
    expect(releases).toHaveLength(releaseNotes.length);
    expect(new Set(releases.map((release) => release.version)).size).toBe(releases.length);
    for (const release of releases) {
      expect(release.time, `version ${release.version} has no time`).toMatch(/^\d{2}:\d{2}$/);
      expect(release.changes.length, `version ${release.version} has no change`).toBeGreaterThan(0);
    }
    // From 0.45, each entry declares the stories it brings (possibly none).
    for (const release of releases.filter((candidate) => Number(candidate.version.split(".")[1]) >= 45)) {
      expect(release.stories, `version ${release.version} does not declare its stories`).not.toBeNull();
    }
    const stamps = releases.map((release) => `${release.date}T${release.time}`);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it("answers its version number with the deployed commit", async () => {
    const body = (await (await SELF.fetch("https://la-fabrique.test/api/version")).json()) as Record<string, unknown>;
    expect(body).toEqual({ numero: releaseNotes[0]?.version, commit: "test-commit" });
  });
});
