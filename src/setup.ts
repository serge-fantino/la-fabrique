import { globToRegExp } from "./production";
import type { ConfigCheck } from "./projects";
import type { Release } from "./roadmap";
import { branchIssue, type Story } from "./stories";

export type SetupState = "done" | "missing" | "optional" | "unknown";

export type SetupKey =
  | "config"
  | "production"
  | "environments"
  | "ci"
  | "release_notes"
  | "documentation"
  | "requests"
  | "epics"
  | "working_branches"
  | "cycle"
  | "integration";

export interface SetupItem {
  key: SetupKey;
  state: SetupState;
  // What was found, in a sentence; quoted names are between backticks.
  found: string;
}

export interface SetupInput {
  check: ConfigCheck | null;
  releases: Release[] | null;
  stories: Story[] | null;
  branches: string[];
}

function item(key: SetupKey, ok: boolean, found: string, optional = false): SetupItem {
  return { key, state: ok ? "done" : optional ? "optional" : "missing", found };
}

// What a project needs for La Fabrique to follow it well, computed from
// its own files and what GitHub says; integration is optional.
export function setupChecklist({ check, releases, stories, branches }: SetupInput): SetupItem[] {
  const config = check?.config ?? null;
  const items: SetupItem[] = [];

  items.push(
    !check
      ? { key: "config", state: "unknown", found: "The file has not been read yet." }
      : !config
        ? item("config", false, check.errors[0] ?? "There is no `.fabrique.json` at the root of the repository.")
        : item(
            "config",
            check.errors.length === 0,
            check.errors.length ? `${check.errors.length} problem${check.errors.length > 1 ? "s" : ""}: ${check.errors[0]}` : "Valid.",
          ),
  );

  const production = config?.branches?.production;
  items.push(
    item(
      "production",
      Boolean(production),
      production ? `\`${production}\`.` : `Not declared: La Fabrique uses the default branch, \`${check?.branch ?? "main"}\`.`,
    ),
  );

  const environments = Object.entries(config?.environnements ?? {});
  const versioned = environments.filter(([, environment]) => environment.version).map(([name]) => name);
  items.push(
    item(
      "environments",
      versioned.length > 0,
      environments.length
        ? versioned.length
          ? `Version read on ${versioned.map((name) => `\`${name}\``).join(", ")}.`
          : `${environments.length} environment${environments.length > 1 ? "s" : ""}, none with a version path.`
        : "No environment declared.",
    ),
  );

  const ci = config?.workflows?.["ci"];
  items.push(item("ci", typeof ci === "string", typeof ci === "string" ? `\`${ci}\`.` : "No `workflows.ci`."));

  const file = config?.version?.fichier;
  if (!file) {
    items.push(item("release_notes", false, "No `version.fichier`."));
  } else if (releases === null) {
    items.push({ key: "release_notes", state: "unknown", found: `\`${file}\` could not be read.` });
  } else if (!releases.length) {
    items.push(item("release_notes", false, `\`${file}\` is missing, empty or not in the Fabrique format.`));
  } else {
    // Entries without a valid date are not read at all; released ones
    // carry an `heure`.
    const released = releases.filter((release) => !release.upcoming);
    const upcoming = releases.length - released.length;
    items.push(
      item(
        "release_notes",
        released.length > 0,
        released.length
          ? `\`${file}\`: ${released.length} version${released.length > 1 ? "s" : ""}, latest ${released[0]?.version} on ${released[0]?.date}${
              upcoming ? `; ${upcoming} not released yet` : ""
            }.`
          : `\`${file}\`: no entry released yet (none has an \`heure\`).`,
      ),
    );
  }

  const documentation = config?.documentation ?? [];
  const pages = check?.docPages?.length ?? 0;
  items.push(
    item(
      "documentation",
      documentation.length > 0 && pages > 0,
      documentation.length ? `${pages} page${pages === 1 ? "" : "s"} published.` : "No `documentation`.",
    ),
  );

  const rubriques = config?.demandes?.rubriques?.length ?? 0;
  const labels = ["demande", "prete", "a_valider"].filter((key) => config?.demandes?.etiquettes?.[key]);
  items.push(
    item(
      "requests",
      rubriques > 0 && labels.length === 3,
      `${rubriques} section${rubriques === 1 ? "" : "s"} in the form, ${labels.length} of 3 circuit labels.`,
    ),
  );

  if (stories === null) {
    items.push({ key: "epics", state: "unknown", found: "The issues could not be read." });
  } else {
    const epics = stories.filter((story) => story.subTotal > 0);
    items.push(
      item(
        "epics",
        epics.length > 0,
        epics.length
          ? `${epics.length} epic${epics.length > 1 ? "s" : ""} with sub-issues.`
          : "No issue has sub-issues: stories are not attached to an epic.",
      ),
    );
  }

  // Work reaches its story by the branch name, or by its pull request
  // (`Closes #42`).
  const patterns = (config?.branches?.travail ?? []).map(globToRegExp);
  const working = branches.filter((branch) => patterns.some((pattern) => pattern.test(branch)));
  const numbered = working.filter((branch) => branchIssue(branch) !== null);
  const linked = (stories ?? []).filter((story) => story.pullRequests?.length).length;
  items.push(
    item(
      "working_branches",
      patterns.length > 0 && (working.length === 0 || numbered.length > 0 || linked > 0),
      !patterns.length
        ? "No `branches.travail`."
        : `${working.length ? `${numbered.length} of ${working.length} working branch${working.length > 1 ? "es" : ""} carry an issue number` : "No working branch seen yet"}; ${linked} stor${linked === 1 ? "y" : "ies"} linked to pull requests.`,
    ),
  );

  // Optional: without it, the default Definition of Ready and no priority.
  const cycle = config?.cycle;
  items.push(
    item(
      "cycle",
      Boolean(cycle?.pret?.length && cycle.priorites?.length),
      cycle
        ? `Definition of Ready: ${(cycle.pret ?? ["criteres", "epique"]).map((check) => `\`${check}\``).join(", ")}; priorities: ${
            cycle.priorites?.length ? cycle.priorites.map((label) => `\`${label}\``).join(", ") : "none"
          }.`
        : "Not declared: Ready means acceptance criteria and an epic; no priority.",
      !cycle,
    ),
  );

  const integration = config?.branches?.integration;
  const intEnvironment = environments.find(([name]) => name !== "production" && name !== production)?.[0];
  const deploy = config?.workflows?.["deploiement_int"];
  const complete = Boolean(integration && intEnvironment && typeof deploy === "string");
  items.push(
    item(
      "integration",
      complete,
      integration
        ? `\`${integration}\`${intEnvironment ? `, environment \`${intEnvironment}\`` : ", no environment for it"}${
            typeof deploy === "string" ? `, deployed by \`${deploy}\`` : ", no `workflows.deploiement_int`"
          }.`
        : "No integration branch: work goes to production straight from its branch.",
      // Optional until it is started; then it has to be complete.
      !integration,
    ),
  );

  return items;
}
