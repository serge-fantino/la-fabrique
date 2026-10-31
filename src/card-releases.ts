import { dimensionValues, type Card, type FreeDimension } from "./cards";
import type { Env } from "./env";
import { PRODUCTION, type ProductionStatus } from "./production";
import type { Project } from "./projects";
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
  const out = releases.find((release) => release.state !== "planned" && compareVersions(version, release.version) >= 0);
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
  // The sprint's release is in progress until the release notes date it;
  // dated, the sprint ends by itself.
  const sprint = await activeSprint(env.DB, project.repo);
  if (sprint) {
    const release = found.get(sprint.release);
    if (release?.state === "shipped") await endSprint(env.DB, sprint, "la-fabrique", "shipped");
    else found.set(sprint.release, { ...(release ?? { version: sprint.release, title: null }), state: "in_progress", sprint: true });
  }
  return [...found.values()].sort((a, b) => compareVersions(a.version, b.version));
}

// The values of the board's free dimensions, the project's releases among
// them, newest first.
export async function knownValues(
  env: Env,
  project: Project,
  cards: Card[],
): Promise<{ known: Record<FreeDimension, string[]>; releases: Map<string, BoardRelease> }> {
  const known = await dimensionValues(env.DB, project.repo, cards);
  const releases = await boardReleases(env, project, known.release);
  const others = known.release.filter((value) => !releases.some((release) => release.version === value));
  known.release = [...others.filter((value) => !numbers(value)), ...[...releases.map((release) => release.version), ...others.filter((value) => numbers(value))].sort(compareVersions)];
  return { known, releases: new Map(releases.map((release) => [release.version, release])) };
}
