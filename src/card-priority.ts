import { activityStatement } from "./activity-log";
import { setPriority } from "./backlog";
import { isNice, storyCards } from "./card-groups";
import type { Card } from "./cards";
import type { Env } from "./env";
import { githubJson, githubPost, installationToken } from "./github-app";
import { projectRules, type CycleRules } from "./lifecycle";
import { describeFailure, type Project } from "./projects";
import { applyIssueEvent, type RestIssue } from "./stories";

// A story's priority from its card's (la-fabrique#111): the same for a
// needed story, one level lower for a nice-to-have one; none without a
// card priority.
export function storyPriority(rules: CycleRules, cardPriority: string | null, nice: boolean): string | null {
  const index = cardPriority ? rules.priorities.indexOf(cardPriority) : -1;
  if (index < 0) return null;
  return nice ? (rules.priorities[Math.min(index + 1, rules.priorities.length - 1)] ?? null) : (rules.priorities[index] ?? null);
}

// Gives each story of the card the priority its card says; GitHub's
// refusals come back, the rest is done.
export async function applyCardPriority(env: Env, project: Project, card: Card, login: string): Promise<string[]> {
  const [rules, links] = await Promise.all([projectRules(env.DB, project), storyCards(env.DB, project.repo)]);
  const failed: string[] = [];
  for (const number of links.order.get(card.id) ?? []) {
    const to = storyPriority(rules, card.priority, isNice(links, card.id, number));
    if (!to) continue;
    const outcome = await setPriority(env, project, login, number, to);
    if (!outcome.ok) failed.push(`#${number}: ${outcome.message}`);
  }
  return failed;
}

// "Ready for Claude": the project's ready label (`demandes.etiquettes.prete`),
// set by a Product Engineer once the story says enough; logged.
export async function markReady(env: Env, project: Project, number: number, login: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const label = project.check?.config?.demandes?.etiquettes?.["prete"];
  if (!label) return { ok: false, message: "This project declares no ready label (demandes.etiquettes.prete)." };
  try {
    const token = await installationToken(env, project.installationId);
    const added = await githubPost(token, `/repos/${project.repo}/issues/${number}/labels`, { labels: [label] });
    if (!added.ok) return { ok: false, message: `GitHub refused the label (HTTP ${added.status}).` };
    const issue = await githubJson<RestIssue>(token, `/repos/${project.repo}/issues/${number}`).catch(() => null);
    if (issue) await applyIssueEvent(env, project.repo, "labeled", issue);
  } catch (error) {
    return { ok: false, message: describeFailure(error) };
  }
  await activityStatement(env.DB, { actor: login, action: "story_marked_ready", repo: project.repo, issueNumber: number, details: { label } }).run();
  return { ok: true };
}
