import { activityStatement } from "./activity-log";
import { defectTargets, isKnownStory } from "./defect-targets";
import { TRIAGE_LABEL } from "./defects";
import { defectRows } from "./defects-tab";
import type { Env } from "./env";
import { githubDelete, githubFetch, githubPost, installationToken } from "./github-app";
import type { Project } from "./projects";
import { applyIssueEvent, type RestIssue, type Story } from "./stories";
import { wordingFor } from "./wording";

// Triage: what a defect is about, chosen again after it was reported (the
// same choice as the report form), and the `to triage` label removed. Said
// on GitHub (on the story and on the defect), kept in the log.

export type TriageOutcome = { ok: true; changed: boolean } | { ok: false; message: string; status: 400 | 404 | 502 };

export interface About {
  story: number | null;
  release: string | null;
  // The index of a change in that version's release note.
  change: number | null;
}

// "" (not linked), "r:<version>", "c:<change>:<version>" or "s:<story>:<version>".
export function readAbout(value: string): About | null {
  if (value === "") return { story: null, release: null, change: null };
  if (value.startsWith("r:")) return value.length > 2 && value.length <= 42 ? { story: null, release: value.slice(2), change: null } : null;
  const change = /^c:(\d{1,2}):(.{1,40})$/.exec(value);
  if (change) return { story: null, release: change[2] ?? null, change: Number(change[1]) };
  const match = /^s:(\d+):(.{0,40})$/.exec(value);
  if (!match) return null;
  return { story: Number(match[1]), release: match[2] ? match[2] : null, change: null };
}

export async function triageDefect(
  env: Env,
  project: Project,
  stories: Story[],
  login: string,
  form: FormData,
): Promise<TriageOutcome> {
  const number = Number(form.get("defect"));
  const about = readAbout(String(form.get("about") ?? ""));
  const triaged = form.get("triaged") === "1";
  if (!Number.isInteger(number) || number <= 0 || !about) return { ok: false, message: "This choice is not valid.", status: 400 };
  const row = (await defectRows(env, project, stories)).find((candidate) => candidate.number === number);
  if (!row) return { ok: false, message: `#${number} is not one of this project's defects.`, status: 404 };
  if (about.story !== null && (about.story === number || !(await isKnownStory(env, project, about.story)))) {
    return { ok: false, message: `#${about.story} is not one of this project's stories.`, status: 400 };
  }
  // A change of the release note: its text, and the version's story when it
  // declares a single one.
  let change: string | null = null;
  let story = about.story;
  if (about.change !== null) {
    const target = (await defectTargets(env, project)).find((candidate) => candidate.version === about.release);
    change = target?.changes[about.change] ?? null;
    if (change === null) return { ok: false, message: "This change is no longer in the release notes.", status: 400 };
    if (target?.stories.length === 1) story = target.stories[0]?.number ?? null;
  }
  const relinked = story !== row.story || about.release !== row.release || change !== row.change;
  const untriage = triaged && row.triage;
  if (!relinked && !untriage) return { ok: true, changed: false };

  const words = wordingFor(project);
  try {
    const token = await installationToken(env, project.installationId);
    if (relinked) {
      if (story !== null && story !== row.story) {
        await githubPost(token, `/repos/${project.repo}/issues/${story}/comments`, { body: words.defectLinked(login, number) });
      }
      const linked = words.linkedTo(login, story, about.release);
      await githubPost(token, `/repos/${project.repo}/issues/${number}/comments`, {
        body: change ? `${linked}\n\n> ${change.replace(/\s+/g, " ")}` : linked,
      });
    }
    if (untriage) {
      const removed = await githubDelete(token, `/repos/${project.repo}/issues/${number}/labels/${encodeURIComponent(TRIAGE_LABEL)}`);
      if (!removed.ok && removed.status !== 404) return { ok: false, message: `GitHub refused to remove the label (HTTP ${removed.status}).`, status: 502 };
      const issue = await githubFetch(token, `/repos/${project.repo}/issues/${number}`);
      if (issue.ok) await applyIssueEvent(env, project.repo, "edited", (await issue.json()) as RestIssue);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: 502 };
  }

  await activityStatement(env.DB, {
    actor: login,
    action: "defect_linked",
    repo: project.repo,
    ...(story !== null ? { issueNumber: story } : {}),
    details: {
      defect: number,
      ...(about.release ? { release: about.release } : {}),
      ...(change ? { change: change.slice(0, 500) } : {}),
      from: row.story,
      ...(untriage ? { triaged: true } : {}),
    },
  }).run();
  return { ok: true, changed: true };
}
