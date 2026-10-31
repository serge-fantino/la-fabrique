import { dimensionValues, type Card, type FreeDimension } from "./cards";
import type { Env } from "./env";
import { PRODUCTION, type ProductionStatus } from "./production";
import type { Project } from "./projects";
import { loadReleases } from "./roadmap";
import { readSnapshot } from "./snapshots";

// The board's releases: the project's own (its release notes), shipped or
// in progress, and those planned ahead in La Fabrique (a value of the
// release dimension). Newest first: the board shows them left to right.
export type ReleaseState = "shipped" | "in_progress" | "planned";

export interface BoardRelease {
  version: string;
  title: string | null;
  state: ReleaseState;
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

// The project's numbering (`version.forme`, "v1.N", "0.N"): N is the number.
export function versionPattern(forme: string | undefined): RegExp | null {
  if (!forme || !forme.includes("N")) return null;
  const parts = forme.split("N").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("(\\d+)")}$`, "i");
}

// The version after the newest one, in the project's numbering.
export function nextVersion(forme: string | undefined, releases: BoardRelease[]): string | null {
  const pattern = versionPattern(forme);
  if (!forme || !pattern) return null;
  const highest = Math.max(0, ...releases.map((release) => Number(pattern.exec(release.version)?.[1] ?? 0)));
  return forme.replace("N", String(highest + 1));
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
    found.set(release.version, { version: release.version, title: release.title, state: release.time ? "shipped" : "in_progress" });
  }
  for (const waiting of production?.data.waiting ?? []) {
    if (!found.has(waiting.version)) found.set(waiting.version, { version: waiting.version, title: waiting.title, state: "in_progress" });
  }
  const pattern = versionPattern(project.check?.config?.version?.forme);
  for (const value of planned) {
    if (found.has(value) || (pattern && !pattern.test(value))) continue;
    found.set(value, { version: value, title: null, state: "planned" });
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
