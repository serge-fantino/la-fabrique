import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import kitComponent from "../components/report-and-test-kit/component.json";
import notesComponent from "../components/release-notes/component.json";
import { readComponentJson, resolvePath } from "../src/components";
import { KIT_VERSION } from "../src/kit";
import { validateFabriqueConfig } from "../src/fabrique-config";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const SHA = "c0ffee1";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

const github = () => fetchMock.get("https://api.github.com");

const VALID = {
  nom: "Menu planner",
  nature: "produit",
  version: "1.2.0",
  resume: "Plan the week's meals.",
  apporte: ["A week of meals"],
  demande: [{ type: "table", description: "A menus table" }],
  dependances: ["design-tokens"],
  implementations: [{ stack: { langage: "typescript", hebergement: "cloudflare-workers" }, chemin: "impl/ts" }],
  donnees_personnelles: "privacy.md",
  origine: { depot: "https://github.com/acme/kitchen", chemin: "components/menu", version: "1.1.0", commit: "abc1234" },
};

describe("A component.json", () => {
  const exists = (path: string) => ["components/menu/impl/ts", "components/menu/privacy.md", "kit"].includes(path);

  it("is read with what it brings, asks, its implementations, personal data and origin", () => {
    const read = readComponentJson(JSON.stringify(VALID), "menu", "components/menu", exists);
    expect("meta" in read && read.meta).toMatchObject({
      id: "menu",
      nom: "Menu planner",
      nature: "produit",
      implementations: [{ stack: { langage: "typescript", hebergement: "cloudflare-workers" }, chemin: "components/menu/impl/ts" }],
      donnees_personnelles: "components/menu/privacy.md",
      origine: { depot: "https://github.com/acme/kitchen", version: "1.1.0" },
    });
    // From the repository's root with a leading "/".
    const root = readComponentJson(JSON.stringify({ ...VALID, implementations: [{ stack: { langage: "js" }, chemin: "/kit" }] }), "menu", "components/menu", exists);
    expect("meta" in root && root.meta.implementations[0]?.chemin).toBe("kit");
  });

  it("says each thing that is wrong", () => {
    expect(readComponentJson("{not json", "menu", "components/menu", exists)).toEqual({ errors: ["`component.json` is not valid JSON."] });
    const read = readComponentJson(
      JSON.stringify({ id: "other", nature: "widget", version: "one", apporte: "x", implementations: [{ stack: {}, chemin: "impl" }, { stack: { langage: "go" }, chemin: "../../etc" }, { stack: { langage: "go" }, chemin: "missing" }], origine: { depot: "ftp://x" } }),
      "menu",
      "components/menu",
      exists,
    );
    expect("errors" in read && read.errors).toEqual([
      "`id` must be the folder's name, `menu`.",
      "`nom` is required: the component's name.",
      "`nature` must be one of `produit`, `bibliotheque`, `design-system`.",
      "`version` must be a version, such as 1.6.0.",
      "`apporte` must be a list of texts.",
      '`implementations[0].stack` must say the stack, such as { "langage": "typescript" }.',
      '`implementations[1].chemin` must be a folder in the component, or from the repository\'s root ("/kit").',
      "`implementations[2].chemin`: `components/menu/missing` does not exist.",
      "`origine.depot` must be the address of the repository it was taken from (https://…).",
    ]);
    expect(resolvePath("components/menu", "../../secret")).toBeNull();
    expect(resolvePath("components/menu", "./impl/")).toBe("components/menu/impl");
  });

  it("is declared by .fabrique.json > composants, components by default, a folder that exists", () => {
    const tree = (folders: string[]) => ({ files: new Set([".fabrique.json"]), folders: new Set(folders), complete: true });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", composants: {} }), tree(["components"])).config?.composants).toEqual({ dossier: "components" });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", composants: { dossier: "./lib/parts/" } }), tree(["lib/parts"])).config?.composants).toEqual({ dossier: "lib/parts" });
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", composants: { dossier: "nowhere" } }), tree([])).errors).toEqual(["`composants.dossier`: `nowhere` does not exist."]);
    expect(validateFabriqueConfig(JSON.stringify({ nom: "W", composants: { dossier: "../x" } }), tree([])).errors[0]).toMatch(/^`composants` must be an object/);
  });

  it("La Fabrique's own components are valid", () => {
    const exists = () => true;
    for (const [id, raw] of [["report-and-test-kit", kitComponent], ["release-notes", notesComponent]] as const) {
      // Imported as text or as an object, depending on the bundler's rules.
      const read = readComponentJson(typeof raw === "string" ? raw : JSON.stringify(raw), id, `components/${id}`, exists);
      expect("errors" in read ? read.errors : [], id).toEqual([]);
    }
    // The kit's component says the kit's own version (la-fabrique#211).
    const kit = (typeof kitComponent === "string" ? JSON.parse(kitComponent) : kitComponent) as { version: string };
    expect(kit.version).toBe(KIT_VERSION);
  });
});

async function seed(config: Record<string, unknown>): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, committed_at, doc_pages) VALUES (?, 'main', ?, ?, '[]', '2026-11-02T08:00:00Z', '[]')",
    ).bind(REPO, SHA, JSON.stringify({ nom: "Widget", ...config })),
  ]);
}

// One installation token per GitHub read (the tree, then each file).
function mockRepository(tokens: number): void {
  github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).times(tokens);
  const tree = [
    "components",
    "components/menu",
    "components/menu/component.json",
    "components/menu/README.md",
    "components/menu/spec.md",
    "components/menu/privacy.md",
    "components/menu/scenarios",
    "components/menu/scenarios/plan.feature",
    "components/menu/impl",
    "components/menu/impl/ts",
    "components/menu/impl/ts/index.ts",
    "components/tokens",
    "components/tokens/component.json",
    "components/broken",
    "components/broken/component.json",
  ].map((path) => ({ path, type: /\.(json|md|feature|ts)$/.test(path) ? "blob" : "tree" }));
  github().intercept({ path: `/repos/${REPO}/git/trees/${SHA}?recursive=1` }).reply(200, JSON.stringify({ tree, truncated: false }), JSON_HEADERS);
  const file = (path: string, content: string) => github().intercept({ path: `/repos/${REPO}/contents/${path}?ref=${SHA}` }).reply(200, content);
  file("components/menu/component.json", JSON.stringify({ ...VALID, origine: null }));
  file("components/tokens/component.json", JSON.stringify({ nom: "Design tokens", nature: "design-system", resume: "Colours and fonts." }));
  file("components/broken/component.json", "{oops");
}

describe("The Components tab", () => {
  it("lists the project's components, filters them, and lists an invalid one with its reasons", async () => {
    await seed({ composants: { dossier: "components" } });
    mockRepository(4);
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/components`, cookie)).text();
    expect(page).toContain('aria-current="page">Components</a>');
    expect(page).toMatch(/<h3><a href="\/projects\/acme\/widget\/components\/menu">Menu planner<\/a><\/h3>/);
    expect(page).toContain('<span class="chip">typescript · cloudflare-workers</span>');
    expect(page).toContain("Design tokens");
    expect(page).toMatch(/broken<\/a> <span class="pill alert small">Invalid<\/span>/);
    expect(page).toContain("`component.json` is not valid JSON.".replace(/`/g, "`"));
    // Cached by commit: no second read of the repository.
    const designOnly = await (await get(`/projects/${REPO}/components?nature=design-system`, cookie)).text();
    expect(designOnly).toContain("Design tokens");
    expect(designOnly).not.toContain("Menu planner");
    const byStack = await (await get(`/projects/${REPO}/components?stack=${encodeURIComponent("typescript · cloudflare-workers")}`, cookie)).text();
    expect(byStack).toContain("Menu planner");
    expect(byStack).not.toContain("Design tokens");
  });

  it("shows a component: what it brings and asks, its implementations, README, spec, scenarios and personal data", async () => {
    await seed({ composants: { dossier: "components" } });
    mockRepository(8);
    const file = (path: string, content: string) => github().intercept({ path: `/repos/${REPO}/contents/${path}?ref=${SHA}` }).reply(200, content);
    file("components/menu/README.md", "# Menu\n\nPlans the **week**.");
    file("components/menu/spec.md", "## Criteria\n\n- [ ] A week");
    file("components/menu/privacy.md", "None kept.");
    file("components/menu/scenarios/plan.feature", "Feature: Plan\n  Scenario: A week");
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/components/menu`, cookie)).text();
    expect(page).toContain("<h3>It brings</h3><ul><li>A week of meals</li></ul>");
    expect(page).toContain('<span class="chip">table</span> A menus table');
    expect(page).toContain('href="/projects/acme/widget/components/design-tokens"');
    expect(page).toContain(`href="https://github.com/${REPO}/tree/${SHA}/components/menu/impl/ts"`);
    expect(page).toContain("Plans the <strong>week</strong>.");
    expect(page).toContain('<pre class="gherkin">Feature: Plan\n  Scenario: A week</pre>');
    expect(page).toContain("None kept.");
    expect((await get(`/projects/${REPO}/components/nothing`, cookie)).status).toBe(404);
  });

  it("says how to start when the project declares no components", async () => {
    await seed({});
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/components`, cookie)).text();
    expect(page).toContain("This project declares no components yet.");
    expect(page).toContain('href="/guide/fabrique-json#composants"');
  });
});
