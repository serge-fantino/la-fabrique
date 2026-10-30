// The `.fabrique.json` format is described in docs/fabrique-json.md. Its keys
// are French because the format is shared with the projects that use it.

export interface FabriqueConfig {
  nom: string;
  // The language La Fabrique writes in the project (issues, comments).
  langue?: "fr" | "en";
  description?: string;
  branches?: { production?: string; integration?: string; travail?: string[] };
  environnements?: Record<string, { url: string; version?: string }>;
  workflows?: Record<string, string | null>;
  version?: { fichier?: string; forme?: string };
  documentation?: { titre: string; chemin: string }[];
  demandes?: {
    etiquettes?: Record<string, string>;
    rubriques?: { cle: string; titre: string; obligatoire?: boolean; aide?: string }[];
  };
  // The lifecycle of a story: its Definition of Ready, and the priority
  // labels, highest first.
  cycle?: { pret?: ReadyCheck[]; priorites?: string[] };
  // Claude launched from La Fabrique: how many runs at once, at most.
  claude?: { plafond?: number };
}

export const READY_CHECKS = ["criteres", "epique", "priorite", "etiquette_prete"] as const;
export type ReadyCheck = (typeof READY_CHECKS)[number];

export interface RepoTree {
  files: Set<string>;
  folders: Set<string>;
  // GitHub truncates very large trees; path checks are then skipped.
  complete: boolean;
}

export interface ConfigCheckResult {
  config: FabriqueConfig | null;
  errors: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateFabriqueConfig(raw: string, tree: RepoTree): ConfigCheckResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { config: null, errors: [`The file is not valid JSON: ${(error as Error).message}`] };
  }
  if (!isObject(parsed)) {
    return { config: null, errors: ["The file must hold a JSON object."] };
  }

  const errors: string[] = [];
  const fileExists = (path: string) => !tree.complete || tree.files.has(path);
  const folderExists = (path: string) => !tree.complete || tree.folders.has(path);

  if (!isText(parsed["nom"])) {
    errors.push("`nom` is required: the project's name.");
  }
  const config: FabriqueConfig = { nom: isText(parsed["nom"]) ? parsed["nom"].trim() : "" };

  const description = parsed["description"];
  if (description !== undefined) {
    if (typeof description === "string") config.description = description;
    else errors.push("`description` must be text.");
  }

  const branches = parsed["branches"];
  if (branches !== undefined) {
    if (!isObject(branches)) {
      errors.push("`branches` must be an object.");
    } else {
      config.branches = {};
      for (const key of ["production", "integration"] as const) {
        const value = branches[key];
        if (value === undefined) continue;
        if (isText(value)) config.branches[key] = value;
        else errors.push(`\`branches.${key}\` must be a branch name.`);
      }
      const travail = branches["travail"];
      if (travail !== undefined) {
        if (Array.isArray(travail) && travail.every(isText)) config.branches.travail = travail;
        else errors.push("`branches.travail` must be a list of branch patterns.");
      }
    }
  }

  const environnements = parsed["environnements"];
  if (environnements !== undefined) {
    if (!isObject(environnements)) {
      errors.push("`environnements` must be an object.");
    } else {
      config.environnements = {};
      for (const [name, environment] of Object.entries(environnements)) {
        if (!isObject(environment) || !isHttpUrl(environment["url"])) {
          errors.push(`\`environnements.${name}.url\` must be an http(s) address.`);
          continue;
        }
        const version = environment["version"];
        if (version !== undefined && !(typeof version === "string" && version.startsWith("/"))) {
          errors.push(`\`environnements.${name}.version\` must be a path starting with "/".`);
          config.environnements[name] = { url: environment["url"] };
          continue;
        }
        config.environnements[name] = version === undefined
          ? { url: environment["url"] }
          : { url: environment["url"], version };
      }
    }
  }

  const workflows = parsed["workflows"];
  if (workflows !== undefined) {
    if (!isObject(workflows)) {
      errors.push("`workflows` must be an object.");
    } else {
      config.workflows = {};
      for (const [key, file] of Object.entries(workflows)) {
        if (file === null) {
          config.workflows[key] = null;
        } else if (!isText(file)) {
          errors.push(`\`workflows.${key}\` must be a workflow file name or null.`);
        } else if (!fileExists(`.github/workflows/${file}`)) {
          errors.push(`\`workflows.${key}\`: \`${file}\` is not in .github/workflows/.`);
        } else {
          config.workflows[key] = file;
        }
      }
    }
  }

  const version = parsed["version"];
  if (version !== undefined) {
    if (!isObject(version)) {
      errors.push("`version` must be an object.");
    } else {
      config.version = {};
      const fichier = version["fichier"];
      if (fichier !== undefined) {
        if (!isText(fichier)) errors.push("`version.fichier` must be a file path.");
        else if (!fileExists(fichier)) errors.push(`\`version.fichier\`: \`${fichier}\` does not exist.`);
        else config.version.fichier = fichier;
      }
      if (typeof version["forme"] === "string") config.version.forme = version["forme"];
    }
  }

  const documentation = parsed["documentation"];
  if (documentation !== undefined) {
    if (!Array.isArray(documentation)) {
      errors.push("`documentation` must be a list.");
    } else {
      config.documentation = [];
      documentation.forEach((entry: unknown, index) => {
        if (!isObject(entry) || !isText(entry["titre"]) || !isText(entry["chemin"])) {
          errors.push(`\`documentation[${index}]\` needs a \`titre\` and a \`chemin\`.`);
          return;
        }
        const chemin = entry["chemin"];
        const exists = chemin.endsWith("/")
          ? folderExists(chemin.slice(0, -1))
          : fileExists(chemin);
        if (!exists) {
          errors.push(`\`documentation[${index}]\`: \`${chemin}\` does not exist.`);
          return;
        }
        config.documentation?.push({ titre: entry["titre"], chemin });
      });
    }
  }

  const demandes = parsed["demandes"];
  if (demandes !== undefined) {
    if (!isObject(demandes)) {
      errors.push("`demandes` must be an object.");
    } else {
      config.demandes = {};
      const etiquettes = demandes["etiquettes"];
      if (etiquettes !== undefined) {
        if (isObject(etiquettes) && Object.values(etiquettes).every(isText)) {
          config.demandes.etiquettes = etiquettes as Record<string, string>;
        } else {
          errors.push("`demandes.etiquettes` must map each step to a GitHub label.");
        }
      }
      const rubriques = demandes["rubriques"];
      if (rubriques !== undefined) {
        if (!Array.isArray(rubriques)) {
          errors.push("`demandes.rubriques` must be a list.");
        } else {
          const seen = new Set<string>();
          config.demandes.rubriques = [];
          rubriques.forEach((rubrique: unknown, index) => {
            if (!isObject(rubrique) || !isText(rubrique["cle"]) || !isText(rubrique["titre"])) {
              errors.push(`\`demandes.rubriques[${index}]\` needs a \`cle\` and a \`titre\`.`);
              return;
            }
            if (seen.has(rubrique["cle"])) {
              errors.push(`\`demandes.rubriques[${index}]\`: the key \`${rubrique["cle"]}\` is used twice.`);
              return;
            }
            seen.add(rubrique["cle"]);
            config.demandes?.rubriques?.push({
              cle: rubrique["cle"],
              titre: rubrique["titre"],
              obligatoire: rubrique["obligatoire"] === true,
              ...(typeof rubrique["aide"] === "string" ? { aide: rubrique["aide"] } : {}),
            });
          });
        }
      }
    }
  }

  const langue = parsed["langue"];
  if (langue !== undefined) {
    if (langue === "fr" || langue === "en") config.langue = langue;
    else errors.push("`langue` must be `fr` or `en`.");
  }

  const claude = parsed["claude"];
  if (claude !== undefined) {
    const plafond = isObject(claude) ? claude["plafond"] : undefined;
    if (!isObject(claude) || (plafond !== undefined && !(Number.isInteger(plafond) && (plafond as number) >= 1 && (plafond as number) <= 10))) {
      errors.push("`claude.plafond` must be a whole number from 1 to 10.");
    } else {
      config.claude = plafond === undefined ? {} : { plafond: plafond as number };
    }
  }

  const cycle = parsed["cycle"];
  if (cycle !== undefined) {
    if (!isObject(cycle)) {
      errors.push("`cycle` must be an object.");
    } else {
      config.cycle = {};
      const pret = cycle["pret"];
      if (pret !== undefined) {
        const known = new Set<string>(READY_CHECKS);
        if (!Array.isArray(pret) || !pret.every((check) => typeof check === "string" && known.has(check))) {
          errors.push(`\`cycle.pret\` must be a list among ${READY_CHECKS.map((check) => `\`${check}\``).join(", ")}.`);
        } else {
          config.cycle.pret = [...new Set(pret as ReadyCheck[])];
        }
      }
      const priorites = cycle["priorites"];
      if (priorites !== undefined) {
        if (!Array.isArray(priorites) || !priorites.every(isText)) {
          errors.push("`cycle.priorites` must be a list of GitHub labels, highest priority first.");
        } else {
          config.cycle.priorites = priorites as string[];
        }
      }
    }
  }

  return { config, errors };
}
