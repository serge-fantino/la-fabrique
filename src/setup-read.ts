import { knownBranches } from "./branches";
import type { Env } from "./env";
import { projectKit } from "./kit-update";
import { readSnapshot } from "./snapshots";
import { PRODUCTION, type ProductionStatus } from "./production";
import { appLink } from "./project-app";
import { checkOtherBranch, type ConfigCheck, type Project } from "./projects";
import { loadReleases } from "./roadmap";
import { setupChecklist, type SetupItem } from "./setup";
import { loadStories } from "./stories";
import { RELEASE_NOTES_KIT_VERSION } from "./kit";
import { isCurrent, projectReleaseTool, type ReleaseTool } from "./release-tool";

export interface SetupReading {
  items: SetupItem[];
  // The file read: the production branch's, or `ref`'s.
  check: ConfigCheck | null;
  // The branch read, when it is not the production branch.
  ref: string | null;
  failure?: string;
  link: Awaited<ReturnType<typeof appLink>>;
  kit: Awaited<ReturnType<typeof projectKit>>;
  releaseTool: ReleaseTool & { exists: boolean; latest: string; current: boolean };
}

// What *Setup* says about a project, read from its files and GitHub: on its
// production branch, or on another branch (a pull request's, before its
// merge). The Setup page and the MCP `setup` tool read the same thing.
export async function readSetup(
  env: Env,
  project: Project,
  origin: string,
  ref: string | null,
  branches?: string[],
): Promise<SetupReading> {
  let check: ConfigCheck | null = project.check;
  let failure: string | undefined;
  if (ref) {
    const branch = await checkOtherBranch(env, project, ref);
    if (branch.ok) check = branch.check;
    else failure = branch.message;
  }
  const [releases, stories, production, link, kit, known, tool] = await Promise.all([
    loadReleases(env, project, check, ref),
    loadStories(env, project),
    readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION),
    appLink(env, project, origin),
    projectKit(env, project),
    branches ? Promise.resolve(branches) : knownBranches(env, project, ref),
    projectReleaseTool(env, project),
  ]);
  const releaseTool = { ...tool, exists: tool.sha !== null, latest: RELEASE_NOTES_KIT_VERSION, current: isCurrent(tool) };
  const items = setupChecklist({
    check,
    app: { reporting: Object.keys(link.reporting), registered: link.app !== null, missing: link.missing.length, connections: link.connections },
    versions: production?.data.versions ?? null,
    releases: releases.failure ? null : releases.releases,
    stories: stories.failure && !stories.stories.length ? null : stories.stories,
    branches: known,
    releaseTool,
  });
  const reading: SetupReading = { items, check, ref, link, kit, releaseTool };
  const failed = failure ?? releases.failure ?? stories.failure;
  if (failed) reading.failure = failed;
  return reading;
}
