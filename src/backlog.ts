import { can } from "./rights";
import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { githubDelete, githubPost, installationToken } from "./github-app";
import { cycleRules, priorityOf } from "./lifecycle";
import { describeFailure, type Project } from "./projects";
import { readSnapshot, writeSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";


export function canPrioritize(role: Role): boolean {
  return can(role, "request");
}

// Colours of the priority labels GitHub creates, highest first.
const COLOURS = ["c23d17", "d9a93b", "1e5a43", "6a7a72"];

export type PriorityOutcome =
  | { ok: true; from: string | null; to: string | null }
  | { ok: false; message: string; status: 422 | 502 };

// Replaces the story's priority label on GitHub with `to` (null: none),
// keeps the stories snapshot in step and writes who did it in the log.
export async function setPriority(
  env: Env,
  project: Project,
  actor: string,
  number: number,
  to: string | null,
): Promise<PriorityOutcome> {
  const rules = cycleRules(project.check?.config);
  if (to !== null && !rules.priorities.includes(to)) return { ok: false, message: "This priority is not declared in .fabrique.json.", status: 422 };
  const snapshot = await readSnapshot<Story[]>(env.DB, project.repo, STORIES);
  const story = snapshot?.data.find((candidate) => candidate.number === number);
  if (!snapshot || !story) return { ok: false, message: `Story #${number} is not known here.`, status: 422 };
  const from = priorityOf(story, rules);
  if (from === to) return { ok: true, from, to };

  try {
    const token = await installationToken(env, project.installationId);
    const repo = project.repo;
    if (to !== null) {
      const index = rules.priorities.indexOf(to);
      // Created once; GitHub answers 422 when it already exists.
      await githubPost(token, `/repos/${repo}/labels`, { name: to, color: COLOURS[Math.min(index, COLOURS.length - 1)] });
      const added = await githubPost(token, `/repos/${repo}/issues/${number}/labels`, { labels: [to] });
      if (!added.ok) return { ok: false, message: `GitHub refused the label (HTTP ${added.status}).`, status: 502 };
    }
    for (const label of story.labels.filter((label) => rules.priorities.includes(label) && label !== to)) {
      const removed = await githubDelete(token, `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
      if (!removed.ok && removed.status !== 404) return { ok: false, message: `GitHub did not remove ${label} (HTTP ${removed.status}).`, status: 502 };
    }
  } catch (error) {
    return { ok: false, message: describeFailure(error), status: 502 };
  }

  const labels = [...story.labels.filter((label) => !rules.priorities.includes(label)), ...(to ? [to] : [])];
  const updated = snapshot.data.map((candidate) => (candidate.number === number ? { ...candidate, labels } : candidate));
  await env.DB.batch([
    activityStatement(env.DB, {
      actor,
      action: "priority_set",
      repo: project.repo,
      issueNumber: number,
      details: { from, to },
    }),
  ]);
  await writeSnapshot(env.DB, project.repo, STORIES, updated, snapshot.fetchedAt);
  return { ok: true, from, to };
}
