import { describe, expect, it } from "vitest";
import { validateFabriqueConfig, type RepoTree } from "../src/fabrique-config";
import { describeReview, reviewSettings } from "../src/review-settings";
import { setupChecklist } from "../src/setup";

const TREE: RepoTree = {
  files: new Set([".github/workflows/review.yml", ".github/review/securite.md"]),
  folders: new Set([".github", ".github/workflows", ".github/review"]),
  complete: true,
};

function read(revue: unknown, workflows: Record<string, string | null> = { revue: "review.yml" }) {
  return validateFabriqueConfig(JSON.stringify({ nom: "W", workflows, revue }), TREE);
}

describe("the review settings (la-fabrique#377)", () => {
  it("reads a full block", () => {
    const result = read({
      active: true,
      modele: "claude-sonnet-5-5",
      exigence: "normale",
      max_remarques: 8,
      focus: { securite: "bloquant", architecture: "off", accessibilite: "conseil" },
      consignes: ".github/review/",
    });
    expect(result.errors).toEqual([]);
    expect(result.config?.revue).toEqual({
      active: true,
      modele: "claude-sonnet-5-5",
      exigence: "normale",
      max_remarques: 8,
      focus: { securite: "bloquant", architecture: "off", accessibilite: "conseil" },
      consignes: ".github/review",
    });
  });

  it("gives the defaults: off, lenient, five remarks, security blocking, the project's own areas after the standard ones", () => {
    expect(reviewSettings(undefined)).toEqual({
      active: false,
      model: null,
      pickiness: "souple",
      maxRemarks: 5,
      focus: [
        { area: "securite", level: "bloquant" },
        { area: "architecture", level: "conseil" },
        { area: "performance", level: "conseil" },
        { area: "craftsmanship", level: "off" },
        { area: "compliance", level: "off" },
      ],
      guidelines: null,
    });
    const own = reviewSettings({ focus: { accessibilite: "conseil", performance: "off" } });
    expect(own.focus.map((entry) => `${entry.area}:${entry.level}`)).toEqual([
      "securite:bloquant",
      "architecture:conseil",
      "performance:off",
      "craftsmanship:off",
      "compliance:off",
      "accessibilite:conseil",
    ]);
  });

  it("says what is wrong, key by key, and keeps the rest", () => {
    const result = read({
      active: "yes",
      exigence: "picky",
      max_remarques: 0,
      focus: { securite: "always", "Bad Name": "off", performance: "conseil" },
      consignes: "docs/review",
      modele: "two words",
    });
    expect(result.errors).toEqual([
      "`revue.active` must be true or false.",
      "`revue.modele` must be a model's identifier, such as \"claude-sonnet-5-5\".",
      '`revue.exigence` must be "souple", "normale", "stricte".',
      "`revue.max_remarques` must be a whole number from 1 to 20.",
      '`revue.focus.securite` must be "off", "conseil", "bloquant".',
      "`revue.focus`: `Bad Name` is not a valid area name (lowercase letters, digits, - and _).",
      "`revue.consignes`: `docs/review` does not exist.",
    ]);
    expect(result.config?.nom).toBe("W");
    expect(result.config?.revue?.focus).toEqual({ performance: "conseil" });
  });

  it("refuses a review on without a workflow to run it", () => {
    expect(read({ active: true }, {}).errors).toEqual([
      "`revue.active` is true but no `workflows.revue` names the review workflow: nothing can start the review.",
    ]);
    expect(read({ active: false }, {}).errors).toEqual([]);
  });

  it("refuses a block that is not an object", () => {
    expect(read(true).errors).toEqual(["`revue` must be an object."]);
  });

  it("is described in Setup, optional", () => {
    const off = setupChecklist({ check: null, releases: [], stories: [], branches: [] }).find((entry) => entry.key === "review");
    expect(off).toMatchObject({ state: "optional", found: "No `workflows.revue`: pull requests are not reviewed by Claude from La Fabrique." });

    const result = read({ active: true, modele: "claude-sonnet-5-5", consignes: ".github/review" });
    const check = { branch: "main", commitSha: "abc", committedAt: null, checkedAt: "2026-11-16T00:00:00Z", config: result.config, errors: result.errors };
    const on = setupChecklist({ check, releases: [], stories: [], branches: [] } as never).find((entry) => entry.key === "review");
    expect(on?.state).toBe("done");
    expect(on?.found).toBe(
      "`review.yml`, on: every pull request is reviewed when it is opened or updated; model `claude-sonnet-5-5`; lenient (`souple`), at most 5 remarks; focus: `securite` blocking, `architecture` advice, `performance` advice; guidelines in `.github/review/`.",
    );
    expect(describeReview(reviewSettings({}), "review.yml")).toContain("off: a review starts only on Review with Claude; model the workflow's default");
  });
});
