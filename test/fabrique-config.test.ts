import { describe, expect, it } from "vitest";
import example from "../docs/exemples/epicerie.fabrique.json";
import { validateFabriqueConfig, type RepoTree } from "../src/fabrique-config";

function treeOf(paths: string[]): RepoTree {
  const files = new Set(paths);
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return { files, folders, complete: true };
}

const EXAMPLE_TREE = treeOf([
  ".fabrique.json",
  "CLAUDE.md",
  "README.md",
  "docs/architecture-synchro.md",
  "docs/store-v2.md",
  "docs/refactoring/plan.md",
  "site/static/nouveautes.json",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-int.yml",
  ".github/workflows/migrations-prod.yml",
]);

describe(".fabrique.json validation", () => {
  it("accepts the documented example", () => {
    const result = validateFabriqueConfig(JSON.stringify(example), EXAMPLE_TREE);
    expect(result.errors).toEqual([]);
    expect(result.config?.nom).toBe(example.nom);
    expect(result.config?.branches?.production).toBe("main");
    expect(result.config?.documentation).toHaveLength(5);
    expect(result.config?.demandes?.rubriques?.map((rubrique) => rubrique.cle)).toContain("donnees_personnelles");
  });

  it("reports broken JSON in a readable way", () => {
    const result = validateFabriqueConfig('{ "nom": "x", }', EXAMPLE_TREE);
    expect(result.config).toBeNull();
    expect(result.errors[0]).toMatch(/^The file is not valid JSON/);
  });

  it("requires a name", () => {
    expect(validateFabriqueConfig("{}", EXAMPLE_TREE).errors).toEqual(["`nom` is required: the project's name."]);
  });

  it("flags workflows and documentation paths missing from the repository, and keeps the rest", () => {
    const raw = JSON.stringify({
      nom: "Widget",
      workflows: { ci: "ci.yml", deploiement_int: "nope.yml", promouvoir: null },
      documentation: [
        { titre: "Readme", chemin: "README.md" },
        { titre: "Gone", chemin: "docs/gone.md" },
        { titre: "Guides", chemin: "docs/guides/" },
      ],
    });
    const result = validateFabriqueConfig(raw, EXAMPLE_TREE);
    expect(result.errors).toEqual([
      "`workflows.deploiement_int`: `nope.yml` is not in .github/workflows/.",
      "`documentation[1]`: `docs/gone.md` does not exist.",
      "`documentation[2]`: `docs/guides/` does not exist.",
    ]);
    expect(result.config?.workflows).toEqual({ ci: "ci.yml", promouvoir: null });
    expect(result.config?.documentation).toEqual([{ titre: "Readme", chemin: "README.md" }]);
  });

  it("accepts an existing documentation folder", () => {
    const raw = JSON.stringify({ nom: "W", documentation: [{ titre: "Refonte", chemin: "docs/refactoring/" }] });
    expect(validateFabriqueConfig(raw, EXAMPLE_TREE).errors).toEqual([]);
  });

  it("only keeps http(s) environment addresses", () => {
    const raw = JSON.stringify({
      nom: "W",
      environnements: { int: { url: "javascript:alert(1)" }, production: { url: "https://w.example" } },
    });
    const result = validateFabriqueConfig(raw, EXAMPLE_TREE);
    expect(result.errors).toEqual(["`environnements.int.url` must be an http(s) address."]);
    expect(result.config?.environnements).toEqual({ production: { url: "https://w.example" } });
  });

  it("reads an environment's type and whether the app may report from it", () => {
    const result = validateFabriqueConfig(
      JSON.stringify({
        nom: "W",
        environnements: {
          int: { url: "https://int.example", version: "/api/version", type: "integration", signalement: true },
          production: { url: "https://example", type: "production", signalement: true },
          staging: { url: "https://staging.example", type: "recette", signalement: "yes" },
        },
      }),
      EXAMPLE_TREE,
    );
    expect(result.config?.environnements?.["int"]).toEqual({ url: "https://int.example", version: "/api/version", type: "integration", signalement: true });
    expect(result.config?.environnements?.["production"]).toEqual({ url: "https://example", type: "production" });
    expect(result.errors).toEqual([
      "`environnements.production.signalement` cannot be true on production.",
      "`environnements.staging.type` must be \"integration\" or \"production\".",
      "`environnements.staging.signalement` must be true or false.",
    ]);
  });

  it("refuses duplicate request-form keys", () => {
    const raw = JSON.stringify({
      nom: "W",
      demandes: { rubriques: [{ cle: "a", titre: "A" }, { cle: "a", titre: "Again" }] },
    });
    expect(validateFabriqueConfig(raw, EXAMPLE_TREE).errors).toEqual([
      "`demandes.rubriques[1]`: the key `a` is used twice.",
    ]);
  });

  it("skips path checks when GitHub truncated the tree", () => {
    const raw = JSON.stringify({ nom: "W", workflows: { ci: "ci.yml" } });
    const result = validateFabriqueConfig(raw, { files: new Set(), folders: new Set(), complete: false });
    expect(result.errors).toEqual([]);
  });
});
