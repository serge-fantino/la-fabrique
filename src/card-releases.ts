import { dimensionValues, type Card, type FreeDimension } from "./cards";
import type { Env } from "./env";
import { PRODUCTION, type ProductionStatus } from "./production";
import { productionBranch, type Project } from "./projects";
import { loadReleases } from "./roadmap";
import { readSnapshot } from "./snapshots";
import { activeSprint, endSprint } from "./sprints";

// The board's releases: the project's own (its release notes), shipped or
// in progress, and those planned ahead in La Fabrique (a value of the
// release dimension). Newest first: the board shows them left to right.
export type ReleaseState = "shipped" | "in_progress" | "planned";

export interface BoardRelease {
  version: string;
  title: string | null;
  state: ReleaseState;
  // The stories its release-notes entry declares (none for a planned one).
  stories?: number[] | null;
  // Started as the sprint in La Fabrique (la-fabrique#109).
  sprint?: boolean;
  // In progress on the project's integration branch, waiting for the go:
  // the branch, to say "On int · integration".
  integration?: string;
  // The Sprint lane: the release(s) on int it is building, shown in its
  // head ("Sprint · In progress · 1.170 (int)") rather than as a lane.
  onInt?: string[];
  // The Sprint lane: the version the sprint will release (la-fabrique#174).
  sprintVersion?: string;
}

// Two lanes with no version: what the next sprint will take, and the
// sprint running. A version is given to a card only once it ships: a
// release planned by number could ship with other work and carry the card
// away undone.
export const NEXT_RELEASE = "Next release";
export const SPRINT_LANE = "Sprint";

export function isFixedLane(value: string): boolean {
  return value === NEXT_RELEASE || value === SPRINT_LANE;
}

export const RELEASE_STATE_LABELS: Record<ReleaseState, string> = { shipped: "Shipped", in_progress: "In progress", planned: "Planned" };

function numbers(version: string): number[] | null {
  const found = version.match(/\d+/g);
  return found ? found.map(Number) : null;
}

// Newer first; a value without a number ("Later") before every version.
export function compareVersions(a: string, b: string): number {
  const left = numbers(a);
  const right = numbers(b);
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? -1) - (left[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

// The project's numbering (`version.forme`, "v1.N", "0.N"): N is the
// number. A leading prefix is optional: "v1.N" matches "1.169" too, as a
// project's release notes may write it.
export function versionPattern(forme: string | undefined): RegExp | null {
  if (!forme || !forme.includes("N")) return null;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^[^\dN]*/.exec(forme)?.[0] ?? "";
  const parts = forme.slice(prefix.length).split("N").map(escape);
  return new RegExp(`^${prefix ? `(?:${escape(prefix)})?` : ""}${parts.join("(\\d+)")}$`, "i");
}

// The newest of the project's own releases (not planned) in its numbering.
function newest(pattern: RegExp, releases: BoardRelease[]): { release: BoardRelease; n: number } | null {
  let found: { release: BoardRelease; n: number } | null = null;
  for (const release of releases) {
    const n = Number(pattern.exec(release.version)?.[1] ?? NaN);
    if (Number.isInteger(n) && (!found || n > found.n)) found = { release, n };
  }
  return found;
}

// A version spelled as the project's releases are ("1.170" when they say
// "1.169"), or as its numbering says when there is none yet.
export function spellVersion(forme: string | undefined, releases: BoardRelease[], n: number): string | null {
  const pattern = versionPattern(forme);
  if (!forme || !pattern) return null;
  const model = newest(pattern, releases.filter((release) => release.state !== "planned"))?.release.version;
  return model ? model.replace(/(\d+)(?!.*\d)/, String(n)) : forme.replace("N", String(n));
}

// The version after the newest one, in the project's numbering.
export function nextVersion(forme: string | undefined, releases: BoardRelease[]): string | null {
  const pattern = versionPattern(forme);
  if (!forme || !pattern) return null;
  return spellVersion(forme, releases, (newest(pattern, releases)?.n ?? 0) + 1);
}

// A version typed to plan, spelled as the project's releases are.
export function plannedSpelling(forme: string | undefined, releases: BoardRelease[], value: string): string {
  const n = Number(versionPattern(forme)?.exec(value)?.[1] ?? NaN);
  return Number.isInteger(n) ? (spellVersion(forme, releases, n) ?? value) : value;
}

// Why a release cannot be planned; null when it can.
export function planningProblem(project: Project, version: string, releases: BoardRelease[]): string | null {
  const forme = project.check?.config?.version?.forme;
  const pattern = versionPattern(forme);
  const next = nextVersion(forme, releases);
  if (pattern && !pattern.test(version)) return `A release follows the project's numbering, ${forme}${next ? `: the next one is ${next}` : ""}.`;
  const out = releases.find((release) => release.state !== "planned" && !isFixedLane(release.version) && compareVersions(version, release.version) >= 0);
  if (out) return `${version} is not ahead of ${out.version}, already ${RELEASE_STATE_LABELS[out.state].toLowerCase()}${next ? `: the next one is ${next}` : ""}.`;
  return null;
}

export async function boardReleases(env: Env, project: Project, planned: string[]): Promise<BoardRelease[]> {
  const [{ releases }, production] = await Promise.all([
    loadReleases(env, project),
    // What integration brings, as the Production page last read it.
    readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION),
  ]);
  const found = new Map<string, BoardRelease>();
  for (const release of releases) {
    // An entry not released yet ("next": the sprint's work, online without
    // a version) is not a release of its own (la-fabrique#173).
    if (release.version.toLowerCase() === "next") continue;
    // Entries newer than the newest one with a time are not out yet; older
    // ones without a time came before times were written down.
    found.set(release.version, { version: release.version, title: release.title, state: release.upcoming ? "in_progress" : "shipped", stories: release.stories });
  }
  for (const waiting of production?.data.waiting ?? []) {
    if (!found.has(waiting.version)) found.set(waiting.version, { version: waiting.version, title: waiting.title, state: "in_progress", stories: waiting.stories ?? null });
  }
  const pattern = versionPattern(project.check?.config?.version?.forme);
  for (const value of planned) {
    if (found.has(value) || (pattern && !pattern.test(value))) continue;
    found.set(value, { version: value, title: null, state: "planned" });
  }
  // A sprint started on a planned version (before the fixed lanes) is in
  // progress until the release notes date it; dated, it ends by itself.
  const sprint = await activeSprint(env.DB, project.repo);
  if (sprint && sprint.release !== SPRINT_LANE) {
    const release = found.get(sprint.release);
    if (release?.state === "shipped") await endSprint(env.DB, sprint, "la-fabrique", "shipped");
    else found.set(sprint.release, { ...(release ?? { version: sprint.release, title: null }), state: "in_progress", sprint: true });
  }
  // On a project with an integration branch, a release in progress is
  // the one on int, waiting for the go.
  const integration = project.check?.config?.branches?.integration;
  if (typeof integration === "string" && integration !== productionBranch(project)) {
    for (const release of found.values()) if (release.state === "in_progress" && !release.sprint) release.integration = integration;
  }
  const fixed: BoardRelease[] = [
    { version: NEXT_RELEASE, title: "What the next sprint takes", state: "planned" },
    ...(sprint?.release === SPRINT_LANE
      ? [{ version: SPRINT_LANE, title: sprint.version ? `The sprint in progress, to release ${sprint.version}` : "The sprint in progress", state: "in_progress" as const, sprint: true, ...(sprint.version ? { sprintVersion: sprint.version } : {}) }]
      : []),
  ];
  for (const lane of fixed) found.delete(lane.version);
  return [...fixed, ...[...found.values()].sort((a, b) => compareVersions(a.version, b.version))];
}

// The values of the board's free dimensions, the project's releases among
// them, newest first.
export async function knownValues(
  env: Env,
  project: Project,
  cards: Card[],
): Promise<{ known: Record<FreeDimension, string[]>; releases: Map<string, BoardRelease> }> {
  const known = await dimensionValues(env.DB, project.repo, cards);
  const all = await boardReleases(env, project, known.release);
  // A release planned by number that is now in progress or out (the
  // project wrote it in its notes, "1.170" for a planned "v1.170") is no
  // longer a lane of its own, unless a card still carries it.
  const used = new Set(cards.map((card) => card.release).filter(Boolean));
  const stale = (release: BoardRelease) =>
    release.state === "planned" &&
    !isFixedLane(release.version) &&
    !used.has(release.version) &&
    all.some((other) => other.state !== "planned" && !isFixedLane(other.version) && compareVersions(release.version, other.version) >= 0);
  const gone = new Set(all.filter(stale).map((release) => release.version));
  // While a sprint runs, the release on int is the one it builds: one lane,
  // the Sprint's, says both ("Sprint · In progress · 1.170 (int)"), so a
  // card shows once. A card that carries the version keeps its lane.
  const sprintLane = all.find((release) => release.version === SPRINT_LANE);
  if (sprintLane) {
    const onInt = all.filter((release) => release.integration && !used.has(release.version));
    if (onInt.length) {
      onInt.forEach((release) => gone.add(release.version));
      sprintLane.onInt = onInt.map((release) => release.version);
      const branch = onInt[0]?.integration;
      if (branch) sprintLane.integration = branch;
    }
  }
  const releases = all.filter((release) => !gone.has(release.version));
  known.release = known.release.filter((value) => !gone.has(value));
  const others = known.release.filter((value) => !releases.some((release) => release.version === value));
  const fixed = releases.filter((release) => isFixedLane(release.version)).map((release) => release.version);
  // Next release and Sprint first, then the values without a number, then
  // the versions, newest first.
  known.release = [
    ...fixed,
    ...others.filter((value) => !numbers(value)),
    ...[...releases.filter((release) => !isFixedLane(release.version)).map((release) => release.version), ...others.filter((value) => numbers(value))].sort(compareVersions),
  ];
  return { known, releases: new Map(releases.map((release) => [release.version, release])) };
}
