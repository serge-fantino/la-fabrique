// Claude reviews the pull requests (epic F14, C158; F14.1, la-fabrique#377): how a
// project wants to be reviewed, read from `.fabrique.json` > `revue` (format:
// docs/fabrique-json.md § Revue). The project's own workflow (`workflows.revue`)
// runs the review with its secrets (principle 3); La Fabrique starts it.

// How picky the review is: lenient by default, so that nobody spends their
// time rewriting stories.
export const PICKINESS = ["souple", "normale", "stricte"] as const;
export type Pickiness = (typeof PICKINESS)[number];

// What a focus area does with what it finds.
export const FOCUS_LEVELS = ["off", "conseil", "bloquant"] as const;
export type FocusLevel = (typeof FOCUS_LEVELS)[number];

// The standard areas, in this order; a project may add its own. What each one
// checks is written later (C161), in the project's guidelines folder.
export const STANDARD_FOCUS = ["securite", "architecture", "performance", "craftsmanship", "compliance"] as const;

export const DEFAULT_FOCUS: Record<string, FocusLevel> = {
  securite: "bloquant",
  architecture: "conseil",
  performance: "conseil",
  craftsmanship: "off",
  compliance: "off",
};

export const DEFAULT_PICKINESS: Pickiness = "souple";
export const DEFAULT_MAX_REMARKS = 5;
export const MAX_REMARKS_LIMIT = 20;

// As written in `.fabrique.json`, once checked.
export interface ReviewConfig {
  active?: boolean;
  modele?: string;
  exigence?: Pickiness;
  max_remarques?: number;
  focus?: Record<string, FocusLevel>;
  consignes?: string;
}

// What the review runs with: the file's settings, the defaults for the rest.
export interface ReviewSettings {
  active: boolean;
  // Absent: the workflow's default model.
  model: string | null;
  pickiness: Pickiness;
  maxRemarks: number;
  focus: { area: string; level: FocusLevel }[];
  guidelines: string | null;
}

export const PICKINESS_LABELS: Record<Pickiness, string> = {
  souple: "lenient",
  normale: "normal",
  stricte: "strict",
};

export const FOCUS_LEVEL_LABELS: Record<FocusLevel, string> = {
  off: "off",
  conseil: "advice",
  bloquant: "blocking",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODEL = /^[\w.:@/-]{1,100}$/;
const AREA = /^[a-z][a-z0-9_-]{0,39}$/;

function folderOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const folder = value.replace(/^\.?\//, "").replace(/\/$/, "");
  return folder && !folder.split("/").includes("..") && /^[\w./-]+$/.test(folder) ? folder : null;
}

// The `revue` block, checked: each error in `errors`, the rest kept, so that a
// mistake in one key never drops the others.
export function readReviewConfig(raw: unknown, errors: string[], folderExists: (path: string) => boolean): ReviewConfig | null {
  if (!isObject(raw)) {
    errors.push("`revue` must be an object.");
    return null;
  }
  const config: ReviewConfig = {};

  const active = raw["active"];
  if (active !== undefined) {
    if (typeof active === "boolean") config.active = active;
    else errors.push("`revue.active` must be true or false.");
  }

  const model = raw["modele"];
  if (model !== undefined && model !== null) {
    if (typeof model === "string" && MODEL.test(model.trim())) config.modele = model.trim();
    else errors.push("`revue.modele` must be a model's identifier, such as \"claude-sonnet-5-5\".");
  }

  const pickiness = raw["exigence"];
  if (pickiness !== undefined) {
    if ((PICKINESS as readonly unknown[]).includes(pickiness)) config.exigence = pickiness as Pickiness;
    else errors.push(`\`revue.exigence\` must be ${PICKINESS.map((value) => `"${value}"`).join(", ")}.`);
  }

  const max = raw["max_remarques"];
  if (max !== undefined) {
    if (Number.isInteger(max) && (max as number) >= 1 && (max as number) <= MAX_REMARKS_LIMIT) config.max_remarques = max as number;
    else errors.push(`\`revue.max_remarques\` must be a whole number from 1 to ${MAX_REMARKS_LIMIT}.`);
  }

  const focus = raw["focus"];
  if (focus !== undefined) {
    if (!isObject(focus)) {
      errors.push("`revue.focus` must map each focus area to its level.");
    } else {
      const levels: Record<string, FocusLevel> = {};
      for (const [area, level] of Object.entries(focus)) {
        if (!AREA.test(area)) {
          errors.push(`\`revue.focus\`: \`${area}\` is not a valid area name (lowercase letters, digits, - and _).`);
        } else if (!(FOCUS_LEVELS as readonly unknown[]).includes(level)) {
          errors.push(`\`revue.focus.${area}\` must be ${FOCUS_LEVELS.map((value) => `"${value}"`).join(", ")}.`);
        } else {
          levels[area] = level as FocusLevel;
        }
      }
      config.focus = levels;
    }
  }

  const guidelines = raw["consignes"];
  if (guidelines !== undefined && guidelines !== null) {
    const folder = folderOf(guidelines);
    if (!folder) errors.push("`revue.consignes` must be a folder of the repository, such as .github/review.");
    else if (!folderExists(folder)) errors.push(`\`revue.consignes\`: \`${folder}\` does not exist.`);
    else config.consignes = folder;
  }

  return config;
}

// The settings a review runs with. Areas the project did not name keep their
// default; the standard areas first, then the project's own, in its order.
export function reviewSettings(config: ReviewConfig | null | undefined): ReviewSettings {
  const levels = { ...DEFAULT_FOCUS, ...(config?.focus ?? {}) };
  const own = Object.keys(config?.focus ?? {}).filter((area) => !(STANDARD_FOCUS as readonly string[]).includes(area));
  return {
    active: config?.active === true,
    model: config?.modele ?? null,
    pickiness: config?.exigence ?? DEFAULT_PICKINESS,
    maxRemarks: config?.max_remarques ?? DEFAULT_MAX_REMARKS,
    focus: [...STANDARD_FOCUS, ...own].map((area) => ({ area, level: levels[area] ?? "off" })),
    guidelines: config?.consignes ?? null,
  };
}

// In a sentence, for Setup.
export function describeReview(settings: ReviewSettings, workflow: string | null): string {
  if (!workflow) return "No `workflows.revue`: pull requests are not reviewed by Claude from La Fabrique.";
  const areas = settings.focus.filter((entry) => entry.level !== "off");
  return [
    `\`${workflow}\`, ${settings.active ? "on: every pull request is reviewed when it is opened or updated" : "off: a review starts only on Review with Claude"}`,
    `model ${settings.model ? `\`${settings.model}\`` : "the workflow's default"}`,
    `${PICKINESS_LABELS[settings.pickiness]} (\`${settings.pickiness}\`), at most ${settings.maxRemarks} remark${settings.maxRemarks > 1 ? "s" : ""}`,
    areas.length ? `focus: ${areas.map((entry) => `\`${entry.area}\` ${FOCUS_LEVEL_LABELS[entry.level]}`).join(", ")}` : "no focus area on",
    settings.guidelines ? `guidelines in \`${settings.guidelines}/\`` : "no guidelines folder",
  ].join("; ") + ".";
}
