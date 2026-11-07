import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { githubDelete, githubPost, installationToken } from "./github-app";
import { reworkLabelOf } from "./lifecycle";
import type { Project } from "./projects";
import { branchIssue, isFabriqueBranch, namedStories } from "./pull-links";
import { applyIssueEvent } from "./stories";
import { readIssue } from "./validation";
import { wordingFor } from "./wording";

// The end of a rework (la-fabrique#202): a story back in development after
// feedbacks from testing (the rework label, #201) whose pull request is now
// merged is to test again. The label goes, the story's issue says so in the
// project's language, and the log keeps it; the criteria that failed show
// "To test again" from their feedbacks.

export interface MergedPull {
  number: number;
  merged_at: string | null;
  title?: string;
  body: string | null;
  head: { ref: string };
}

export async function reworkMerged(env: Env, project: Project, pull: MergedPull): Promise<number[]> {
  // A scenario La Fabrique proposed (la-fabrique#168) changes no code of the story.
  if (!pull.merged_at || isFabriqueBranch(pull.head.ref)) return [];
  const stories = [...new Set([branchIssue(pull.head.ref), ...namedStories(`${pull.title ?? ""}\n${pull.body ?? ""}`)].filter((number): number is number => number !== null))];
  if (!stories.length) return [];
  const label = reworkLabelOf(project.check?.config);
  const done: number[] = [];
  for (const number of stories) {
    const issue = await readIssue(env, project, number).catch(() => null);
    if (!issue || issue.pull_request) continue;
    // On a project without an integration branch, the merge reaches the
    // default branch: GitHub closes the story at that moment, and La Fabrique
    // opens it again (story-reopen.ts), on another webhook that may come
    // after this one. A story closed that way is still reworked; one closed
    // by a person as not planned or duplicate is left as it is.
    const closed = issue.state !== "open";
    if (closed && (issue.state_reason === "not_planned" || issue.state_reason === "duplicate")) continue;
    const names = issue.labels.map((entry) => (typeof entry === "string" ? entry : (entry.name ?? "")));
    if (!names.includes(label)) continue;
    const token = await installationToken(env, project.installationId);
    const removed = await githubDelete(token, `/repos/${project.repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
    if (!removed.ok && removed.status !== 404) continue;
    await githubPost(token, `/repos/${project.repo}/issues/${number}/comments`, { body: wordingFor(project).reworkMerged(pull.number) });
    // Closed, its state in the snapshot is left to the webhooks that follow
    // (reopened, unlabeled): writing it here could put back a close already undone.
    if (!closed) await applyIssueEvent(env, project.repo, "unlabeled", { ...issue, labels: names.filter((name) => name !== label).map((name) => ({ name })) });
    await activityStatement(env.DB, { actor: "github", action: "story_rework_merged", repo: project.repo, issueNumber: number, details: { pull: pull.number } }).run();
    done.push(number);
  }
  return done;
}
