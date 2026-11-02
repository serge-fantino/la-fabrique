import { readMarkdown } from "./docs";
import type { Env } from "./env";
import { githubJson, installationToken } from "./github-app";
import type { ConfigCheck, Project } from "./projects";

// A project's components (la-fabrique#197, epic F6 #194): each one a folder
// that describes itself, in the project's own repository, under the folder
// its `.fabrique.json` declares (`composants.dossier`). La Fabrique only reads
// and shows them, at the commit it reads the project at; nothing is stored
// but the cache of the files, like the documentation.

export const NATURES = ["produit", "bibliotheque", "design-system"] as const;
export type Nature = (typeof NATURES)[number];

export const NATURE_LABELS: Record<Nature, string> = {
  produit: "Product",
  bibliotheque: "Library",
  "design-system": "Design system",
};

export interface ComponentMeta {
  id: string;
  nom: string;
  nature: Nature;
  version: string | null;
  resume: string | null;
  apporte: string[];
  demande: { type: string; description: string }[];
  dependances: string[];
  // The code for one stack: `chemin` in the component's folder, or from the
  // repository's root when it starts with "/".
  implementations: { stack: Record<string, string>; chemin: string }[];
  donnees_personnelles: string | null;
  // Taken from another project: where from, versioned.
  origine: { depot: string; chemin: string | null; version: string | null; commit: string | null } | null;
}

export interface ComponentEntry {
  id: string;
  // The component's folder in the repository.
  folder: string;
  meta: ComponentMeta | null;
  errors: string[];
  // The optional files found in its folder.
  files: { readme: string | null; spec: string | null; changelog: string | null; privacy: string | null; scenarios: string[] };
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_COMPONENTS = 60;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

// A path in the component (relative) or in the repository (from "/"), never
// out of it.
export function resolvePath(folder: string, path: string): string | null {
  const clean = path.trim();
  if (!clean || clean.includes("\\")) return null;
  const parts = (clean.startsWith("/") ? clean.slice(1) : `${folder}/${clean}`).split("/").filter((part) => part && part !== ".");
  if (parts.includes("..") || !parts.length) return null;
  return parts.join("/");
}

// component.json, checked: the component's description, or why it is not.
export function readComponentJson(raw: string, id: string, folder: string, exists: (path: string) => boolean): { meta: ComponentMeta } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: ["`component.json` is not valid JSON."] };
  }
  if (!isObject(parsed)) return { errors: ["`component.json` must be an object."] };
  const errors: string[] = [];
  if (parsed["id"] !== undefined && parsed["id"] !== id) errors.push(`\`id\` must be the folder's name, \`${id}\`.`);
  const nom = text(parsed["nom"], 120);
  if (!nom) errors.push("`nom` is required: the component's name.");
  const nature = parsed["nature"];
  if (typeof nature !== "string" || !(NATURES as readonly string[]).includes(nature)) {
    errors.push(`\`nature\` must be one of ${NATURES.map((value) => `\`${value}\``).join(", ")}.`);
  }
  const version = parsed["version"];
  if (version !== undefined && (typeof version !== "string" || !/^\d+(\.\d+){0,2}([-+][\w.]+)?$/.test(version))) errors.push("`version` must be a version, such as 1.6.0.");

  const list = (key: string): string[] => {
    const value = parsed[key as keyof typeof parsed];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
      errors.push(`\`${key}\` must be a list of texts.`);
      return [];
    }
    return value.map((item: string) => item.trim().slice(0, 300)).slice(0, 30);
  };
  const apporte = list("apporte");
  const dependances = list("dependances");

  const demande: ComponentMeta["demande"] = [];
  const rawDemande = parsed["demande"];
  if (rawDemande !== undefined) {
    if (!Array.isArray(rawDemande)) errors.push("`demande` must be a list of `{ type, description }`.");
    else
      rawDemande.forEach((item: unknown, index) => {
        const type = isObject(item) ? text(item["type"], 40) : null;
        const description = isObject(item) ? text(item["description"], 300) : null;
        if (!type || !description) errors.push(`\`demande[${index}]\` needs a \`type\` and a \`description\`.`);
        else demande.push({ type, description });
      });
  }

  const implementations: ComponentMeta["implementations"] = [];
  const rawImplementations = parsed["implementations"];
  if (rawImplementations !== undefined) {
    if (!Array.isArray(rawImplementations)) errors.push("`implementations` must be a list of `{ stack, chemin }`.");
    else
      rawImplementations.forEach((item: unknown, index) => {
        const stack = isObject(item) && isObject(item["stack"]) ? item["stack"] : null;
        const entries = stack ? Object.entries(stack).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "") : [];
        const chemin = isObject(item) && typeof item["chemin"] === "string" ? resolvePath(folder, item["chemin"]) : null;
        if (!entries.length) errors.push(`\`implementations[${index}].stack\` must say the stack, such as { "langage": "typescript" }.`);
        else if (!chemin) errors.push(`\`implementations[${index}].chemin\` must be a folder in the component, or from the repository's root ("/kit").`);
        else if (!exists(chemin)) errors.push(`\`implementations[${index}].chemin\`: \`${chemin}\` does not exist.`);
        else implementations.push({ stack: Object.fromEntries(entries.map(([key, value]) => [key.slice(0, 40), value.trim().slice(0, 60)])), chemin });
      });
  }

  let donnees: string | null = null;
  const rawDonnees = parsed["donnees_personnelles"];
  if (rawDonnees !== undefined && rawDonnees !== null) {
    const path = typeof rawDonnees === "string" ? resolvePath(folder, rawDonnees) : null;
    if (!path) errors.push("`donnees_personnelles` must be a file of the component, such as privacy.md.");
    else if (!exists(path)) errors.push(`\`donnees_personnelles\`: \`${path}\` does not exist.`);
    else donnees = path;
  }

  let origine: ComponentMeta["origine"] = null;
  const rawOrigine = parsed["origine"];
  if (rawOrigine !== undefined && rawOrigine !== null) {
    const depot = isObject(rawOrigine) ? text(rawOrigine["depot"], 300) : null;
    if (!depot || !/^https:\/\//.test(depot)) errors.push("`origine.depot` must be the address of the repository it was taken from (https://…).");
    else if (isObject(rawOrigine)) {
      origine = { depot, chemin: text(rawOrigine["chemin"], 300), version: text(rawOrigine["version"], 40), commit: text(rawOrigine["commit"], 64) };
    }
  }

  if (errors.length || !nom) return { errors };
  return {
    meta: {
      id,
      nom,
      nature: nature as Nature,
      version: typeof version === "string" ? version : null,
      resume: text(parsed["resume"], 400),
      apporte,
      demande,
      dependances,
      implementations,
      donnees_personnelles: donnees,
      origine,
    },
  };
}

// The files of the repository at a commit, cached with the documentation
// (one GitHub read per commit).
async function repositoryFiles(env: Env, project: Project, branch: string | null, sha: string): Promise<Set<string>> {
  const path = ":tree";
  const cached = await env.DB.prepare("SELECT markdown FROM doc_cache WHERE repo = ? AND commit_sha = ? AND path = ?").bind(project.repo, sha, path).first<string>("markdown");
  if (cached !== null) return new Set(JSON.parse(cached) as string[]);
  const token = await installationToken(env, project.installationId);
  const data = await githubJson<{ tree: { path: string; type: string }[] }>(token, `/repos/${project.repo}/git/trees/${sha}?recursive=1`);
  // Files and folders: a folder is known by a trailing "/".
  const files = data.tree.map((entry) => (entry.type === "tree" ? `${entry.path}/` : entry.path));
  await env.DB.prepare("INSERT OR REPLACE INTO doc_cache (repo, commit_sha, path, markdown, branch) VALUES (?, ?, ?, ?, ?)")
    .bind(project.repo, sha, path, JSON.stringify(files), branch)
    .run();
  return new Set(files);
}

export interface ComponentsView {
  // The folder the project declares; null when it declares none.
  folder: string | null;
  components: ComponentEntry[];
  sha: string | null;
}

// The components of a project at the commit of its check (the reference
// branch's when `branch` is given).
export async function loadComponents(env: Env, project: Project, check: ConfigCheck | null, branch: string | null): Promise<ComponentsView> {
  const folder = check?.config?.composants?.dossier ?? null;
  if (!check || !folder) return { folder, components: [], sha: check?.commitSha ?? null };
  const sha = check.commitSha;
  const files = await repositoryFiles(env, project, branch, sha);
  const exists = (path: string) => files.has(path) || files.has(`${path}/`);
  const prefix = `${folder}/`;
  const ids = [...new Set([...files].filter((path) => path.startsWith(prefix) && path.endsWith("/component.json")).map((path) => path.slice(prefix.length, -"/component.json".length)))]
    .filter((id) => !id.includes("/"))
    .sort()
    .slice(0, MAX_COMPONENTS);
  const components = await Promise.all(
    ids.map(async (id): Promise<ComponentEntry> => {
      const at = `${folder}/${id}`;
      const found = (name: string) => (files.has(`${at}/${name}`) ? `${at}/${name}` : null);
      const entry: ComponentEntry = {
        id,
        folder: at,
        meta: null,
        errors: [],
        files: {
          readme: found("README.md"),
          spec: found("spec.md"),
          changelog: found("CHANGELOG.md"),
          privacy: found("privacy.md"),
          scenarios: [...files].filter((path) => path.startsWith(`${at}/scenarios/`) && path.endsWith(".feature")).sort(),
        },
      };
      if (!ID.test(id)) {
        entry.errors.push("The folder's name is the component's id: lowercase letters, digits and dashes.");
        return entry;
      }
      let raw: string;
      try {
        raw = await readMarkdown(env, project, branch, sha, `${at}/component.json`);
      } catch {
        entry.errors.push("`component.json` could not be read.");
        return entry;
      }
      const read = readComponentJson(raw, id, at, exists);
      if ("errors" in read) entry.errors = read.errors;
      else entry.meta = read.meta;
      return entry;
    }),
  );
  return { folder, components, sha };
}

// The stacks a component's implementations cover, said in one line each:
// "typescript · cloudflare-workers".
export function stackLabel(stack: Record<string, string>): string {
  return Object.values(stack).join(" · ");
}
