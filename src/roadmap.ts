import type { Env } from "./env";
import { githubFetch, installationToken } from "./github-app";
import { describeFailure, type ConfigCheck, type Project } from "./projects";
import { readSnapshot, writeSnapshot, onBranch } from "./snapshots";
import type { Story } from "./stories";
import { githubContentsPath } from "./urls";

export const RELEASES = "releases";

export interface Release {
  version: string;
  date: string;
  time: string | null;
  title: string | null;
  changes: string[];
  links: string[];
  upcoming: boolean;
}

// "Quoi de neuf" entries, newest first; entries above the newest one with a
// time are not released yet.
export function parseReleases(raw: string): Release[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const releases: Release[] = [];
  let released = false;
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const version = record["version"] ?? record["numero"];
    const date = record["date"];
    if ((typeof version !== "string" && typeof version !== "number") || typeof date !== "string") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const time = typeof record["heure"] === "string" ? record["heure"] : null;
    if (time) released = true;
    releases.push({
      version: String(version),
      date,
      time,
      title: typeof record["titre"] === "string" ? record["titre"] : null,
      changes: Array.isArray(record["changements"])
        ? record["changements"].filter((change): change is string => typeof change === "string")
        : [],
      links: Array.isArray(record["liens"])
        ? record["liens"].flatMap((link) =>
            typeof link === "object" && link !== null
              ? Object.values(link as Record<string, unknown>).filter((value): value is string => typeof value === "string")
              : [],
          )
        : [],
      upcoming: !released && !time,
    });
  }
  return releases;
}

interface ReleasesSnapshot {
  commitSha: string;
  releases: Release[];
}

// The release notes as they stand at `check`'s commit: production's, or the
// reference branch's when one is chosen.
export async function loadReleases(
  env: Env,
  project: Project,
  check: ConfigCheck | null = project.check,
  ref: string | null = null,
): Promise<{ releases: Release[]; failure?: string }> {
  const file = check?.config?.version?.fichier;
  const sha = check?.commitSha;
  if (!file || !sha) return { releases: [] };
  const kind = onBranch(RELEASES, ref);
  const snapshot = await readSnapshot<ReleasesSnapshot>(env.DB, project.repo, kind);
  if (snapshot?.data.commitSha === sha) return { releases: snapshot.data.releases };
  try {
    const token = await installationToken(env, project.installationId);
    const response = await githubFetch(token, githubContentsPath(project.repo, file, sha), "application/vnd.github.raw+json");
    const releases = response.ok ? parseReleases(await response.text()) : [];
    await writeSnapshot(env.DB, project.repo, kind, { commitSha: sha, releases });
    return { releases };
  } catch (error) {
    return { releases: snapshot?.data.releases ?? [], failure: describeFailure(error) };
  }
}

export interface MonthDay {
  day: string;
  inMonth: boolean;
}

// Weeks start on Monday.
export function monthGrid(month: string): MonthDay[][] {
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(year, monthIndex - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - offset * 86_400_000);
  const weeks: MonthDay[][] = [];
  for (let cursor = start; ; ) {
    const week: MonthDay[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ day: cursor.toISOString().slice(0, 10), inMonth: cursor.getUTCMonth() === monthIndex - 1 });
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
    weeks.push(week);
    if (cursor.getUTCMonth() !== monthIndex - 1) break;
  }
  return weeks;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthIndex - 1 + delta, 1)).toISOString().slice(0, 7);
}

export interface EpicProgress {
  epic: Story;
  stories: Story[];
  // Done stories at the end of each day, from the epic's creation to today.
  done: { day: string; count: number }[];
}

export function epicProgress(stories: Story[], today: string): EpicProgress[] {
  return stories
    .filter((story) => story.subTotal > 0)
    .sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === "open" ? -1 : 1))
    .map((epic) => {
      const children = stories.filter((story) => story.parent === epic.number);
      const closedDays = children
        .filter((story) => story.state === "closed" && story.closedAt)
        .map((story) => (story.closedAt ?? "").slice(0, 10));
      const days: { day: string; count: number }[] = [];
      const start = Date.parse(`${epic.createdAt.slice(0, 10)}T00:00:00Z`);
      const end = Date.parse(`${today}T00:00:00Z`);
      for (let time = start; time <= end && days.length < 366; time += 86_400_000) {
        const day = new Date(time).toISOString().slice(0, 10);
        days.push({ day, count: closedDays.filter((closed) => closed <= day).length });
      }
      return { epic, stories: children, done: days };
    });
}

// Release dates and times are written in the project's own time; closing
// times are UTC, so the split between two versions is approximate.
export function storiesBetween(stories: Story[], after: Release | undefined, upTo: Release): Story[] {
  const stamp = (release: Release) => `${release.date}T${release.time ?? "23:59"}`;
  return stories.filter(
    (story) =>
      story.state === "closed" &&
      story.closedAt !== null &&
      story.closedAt.slice(0, 16) <= stamp(upTo) &&
      (!after || story.closedAt.slice(0, 16) > stamp(after)),
  );
}
