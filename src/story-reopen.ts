import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { githubGraphql, githubPatch, githubPost, installationToken } from "./github-app";
import type { Project } from "./projects";
import { applyIssueEvent, type RestIssue } from "./stories";
import { storyChecks } from "./validation";
import { wordingFor } from "./wording";

// A story stays open until it is validated (la-fabrique#186). GitHub closes
// an issue by itself when the pull request of its linked branch (or a
// commit saying "Closes #N") reaches the default branch: for a story of a
// card, not validated yet, La Fabrique opens it again, says why on the
// issue, in the project's language, and logs it. A story closed by a person
// (no pull request nor commit behind the close) is left as it is.

interface ClosedBy {
  repository: {
    issue: {
      timelineItems: { nodes: ({ closer?: { __typename: string; number?: number; oid?: string } | null } | null)[] };
    } | null;
  } | null;
}

const CLOSER = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
        nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { number } ... on Commit { oid } } } }
      }
    }
  }
}`;

export type Closer = { pull: number } | { commit: string };

export async function closedBy(token: string, repo: string, number: number): Promise<Closer | null> {
  const [owner, name] = repo.split("/");
  const data = await githubGraphql<ClosedBy>(token, CLOSER, { owner, name, number });
  const closer = data.repository?.issue?.timelineItems.nodes.at(-1)?.closer;
  if (closer?.__typename === "PullRequest" && typeof closer.number === "number") return { pull: closer.number };
  if (closer?.__typename === "Commit" && typeof closer.oid === "string") return { commit: closer.oid };
  return null;
}

async function inCard(db: D1Database, repo: string, number: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM card_links l JOIN cards c ON c.id = l.card_id WHERE c.repo = ? AND l.kind = 'story' AND l.ref = ? AND c.archived_at IS NULL LIMIT 1")
    .bind(repo, String(number))
    .first();
  return Boolean(row);
}

// Webhook `issues` closed: opens the story again when the close came from a
// merge and nobody validated it. Returns the closer when it did.
export async function reopenIfClosedByMerge(env: Env, project: Project, issue: RestIssue): Promise<Closer | null> {
  if (issue.pull_request || issue.state !== "closed" || issue.state_reason === "not_planned" || issue.state_reason === "duplicate") return null;
  if (!project.installationId || !(await inCard(env.DB, project.repo, issue.number))) return null;
  if ((await storyChecks(env.DB, project.repo)).get(issue.number)?.validated) return null;
  const token = await installationToken(env, project.installationId);
  const closer = await closedBy(token, project.repo, issue.number).catch(() => null);
  if (!closer) return null;
  const words = wordingFor(project);
  const reopened = await githubPatch(token, `/repos/${project.repo}/issues/${issue.number}`, { state: "open" });
  if (!reopened.ok) return null;
  await githubPost(token, `/repos/${project.repo}/issues/${issue.number}/comments`, { body: words.reopened("pull" in closer ? `#${closer.pull}` : closer.commit.slice(0, 7)) });
  await applyIssueEvent(env, project.repo, "reopened", { ...issue, state: "open", closed_at: null });
  await activityStatement(env.DB, {
    actor: "github",
    action: "story_reopened",
    repo: project.repo,
    issueNumber: issue.number,
    details: "pull" in closer ? { pull: closer.pull } : { commit: closer.commit },
  }).run();
  return closer;
}
