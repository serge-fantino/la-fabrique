import type { Env } from "./env";
import { PRODUCTION, type ProductionStatus } from "./production";
import type { Project } from "./projects";
import { loadReleases, storiesBetween, type Release } from "./roadmap";
import { readSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";

// What a defect can be about, for the person reporting it: the versions on
// int first, then the versions released, newest first, each with the
// stories it brought. A release note is linked to its stories by default:
// those on int for a version waiting there, those closed since the previous
// release for a version released.

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

function isFeature(story: Story): boolean {
  return story.subTotal === 0 && !story.labels.includes(DEFECT_LABEL);
}

function asTarget(story: Story): TargetStory {
  return { number: story.number, title: story.title, url: story.url };
}

export async function defectTargets(env: Env, project: Project): Promise<DefectTarget[]> {
  const [production, stories, released] = await Promise.all([
    readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION),
    readSnapshot<Story[]>(env.DB, project.repo, STORIES),
    loadReleases(env, project).catch(() => ({ releases: [] as Release[] })),
  ]);
  const all = stories?.data ?? [];
  const byNumber = new Map(all.map((story) => [story.number, story]));
  const targets: DefectTarget[] = [];

  // On int: what production lacks. Its stories are those of the work on int;
  // they go with the newest version waiting there.
  const waiting = production?.data.waiting ?? [];
  const onInt = [...new Set((production?.data.groups ?? []).flatMap((group) => group.issues))]
    .map((number) => byNumber.get(number))
    .filter((story): story is Story => story !== undefined && isFeature(story))
    .sort((a, b) => b.number - a.number)
    .map(asTarget);
  waiting.forEach((entry, index) => {
    targets.push({
      version: entry.version,
      title: entry.title,
      changes: entry.changes,
      on_int: true,
      date: null,
      stories: index === 0 ? onInt : [],
    });
  });
  if (!waiting.length && onInt.length) {
    targets.push({ version: "int", title: null, changes: [], on_int: true, date: null, stories: onInt });
  }

  const shipped = released.releases.filter((release) => !release.upcoming && !waiting.some((entry) => entry.version === release.version));
  shipped.slice(0, RELEASED_KEPT).forEach((release, index) => {
    targets.push({
      version: release.version,
      title: release.title,
      changes: release.changes,
      on_int: false,
      date: release.date,
      stories: storiesBetween(all, shipped[index + 1], release).filter(isFeature).map(asTarget),
    });
  });
  return targets;
}

// A story the report may name: an issue of the project, not a defect.
export async function isKnownStory(env: Env, project: Project, number: number): Promise<boolean> {
  const stories = (await readSnapshot<Story[]>(env.DB, project.repo, STORIES))?.data;
  if (!stories) return true;
  const story = stories.find((candidate) => candidate.number === number);
  return story !== undefined && !story.labels.includes(DEFECT_LABEL);
}
