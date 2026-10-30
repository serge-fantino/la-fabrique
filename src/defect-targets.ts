import type { Env } from "./env";
import { PRODUCTION, type ProductionStatus } from "./production";
import type { Project } from "./projects";
import { loadReleases, type Release } from "./roadmap";
import { readSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";

// What a defect can be about, for the person reporting it: the release
// notes, the versions on int first, then those released, newest first. A
// version carries the stories its entry declares (`stories`); nothing is
// guessed from branches or dates: an entry that does not say has none.

export const DEFECT_LABEL = "bug";
const RELEASED_KEPT = 20;

export interface TargetStory {
  number: number;
  title: string;
  url: string;
}

export interface DefectTarget {
  version: string;
  title: string | null;
  changes: string[];
  on_int: boolean;
  date: string | null;
  stories: TargetStory[];
}

export async function defectTargets(env: Env, project: Project): Promise<DefectTarget[]> {
  const [production, stories, released] = await Promise.all([
    readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION),
    readSnapshot<Story[]>(env.DB, project.repo, STORIES),
    loadReleases(env, project).catch(() => ({ releases: [] as Release[] })),
  ]);
  const byNumber = new Map((stories?.data ?? []).map((story) => [story.number, story]));
  const declared = (numbers: number[] | null | undefined): TargetStory[] =>
    (numbers ?? []).flatMap((number) => {
      const story = byNumber.get(number);
      // An epic is tested through its stories; a defect is not a story.
      if (story && (story.subTotal > 0 || story.labels.includes(DEFECT_LABEL))) return [];
      return [{ number, title: story?.title ?? "", url: story?.url ?? `https://github.com/${project.repo}/issues/${number}` }];
    });

  // On int: the entries production does not have yet.
  const waiting = production?.data.waiting ?? [];
  const targets: DefectTarget[] = waiting.map((entry) => ({
    version: entry.version,
    title: entry.title,
    changes: entry.changes,
    on_int: true,
    date: null,
    stories: declared(entry.stories),
  }));

  const shipped = released.releases.filter((release) => !release.upcoming && !waiting.some((entry) => entry.version === release.version));
  for (const release of shipped.slice(0, RELEASED_KEPT)) {
    targets.push({
      version: release.version,
      title: release.title,
      changes: release.changes,
      on_int: false,
      date: release.date,
      stories: declared(release.stories),
    });
  }
  return targets;
}

// The stories the versions on int declare: the one a report belongs to when
// there is a single one and the reporter did not say.
export function storiesOnIntOf(targets: DefectTarget[]): number[] {
  return [...new Set(targets.filter((target) => target.on_int).flatMap((target) => target.stories.map((story) => story.number)))];
}

// A story the report may name: an issue of the project, not a defect.
export async function isKnownStory(env: Env, project: Project, number: number): Promise<boolean> {
  const stories = (await readSnapshot<Story[]>(env.DB, project.repo, STORIES))?.data;
  if (!stories) return true;
  const story = stories.find((candidate) => candidate.number === number);
  return story !== undefined && !story.labels.includes(DEFECT_LABEL);
}
