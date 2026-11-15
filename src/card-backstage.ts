import { activityStatement } from "./activity-log";
import { storyCards } from "./card-groups";
import type { Card } from "./cards";
import type { FabriqueConfig } from "./fabrique-config";
import type { Env } from "./env";
import { githubDelete, githubPost, installationToken } from "./github-app";
import { describeFailure, type Project } from "./projects";
import { readSnapshot, writeSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";

// A feature behind the scenes ("coulisses", la-fabrique#366): its stories
// carry the project's backstage label, so that whoever writes their release
// note (a person, the project's Claude workflow) puts it in `coulisses`,
// for the team, and not in the public changes.
export function backstageLabelOf(config: FabriqueConfig | null | undefined): string {
  return config?.demandes?.etiquettes?.["coulisses"] ?? "coulisses";
}

// Gives the card's stories the backstage label, or takes it off (unless
// another backstage card shares the story). GitHub's refusals come back,
// the rest is done; the stories snapshot follows.
export async function applyCardBackstage(env: Env, project: Project, card: Card, login: string): Promise<string[]> {
  const label = backstageLabelOf(project.check?.config);
  const links = await storyCards(env.DB, project.repo);
  const numbers = links.order.get(card.id) ?? [];
  if (!numbers.length) return [];
  const { results } = await env.DB.prepare("SELECT id FROM cards WHERE repo = ? AND backstage = 1 AND archived_at IS NULL").bind(project.repo).all<{ id: number }>();
  const backstageCards = new Set(results.map((row) => row.id));
  const snapshot = await readSnapshot<Story[]>(env.DB, project.repo, STORIES);
  const failed: string[] = [];
  const changed = new Map<number, boolean>();
  try {
    const token = await installationToken(env, project.installationId);
    if (card.backstage) await githubPost(token, `/repos/${project.repo}/labels`, { name: label, color: "6a7a72", description: "Behind the scenes: release note for the team only" });
    for (const number of numbers) {
      const has = snapshot?.data.find((story) => story.number === number)?.labels.includes(label);
      if (card.backstage) {
        if (has) continue;
        const added = await githubPost(token, `/repos/${project.repo}/issues/${number}/labels`, { labels: [label] });
        if (added.ok) changed.set(number, true);
        else failed.push(`#${number}: GitHub refused the label (HTTP ${added.status}).`);
      } else {
        if (has === false) continue;
        if ((links.byStory.get(number) ?? []).some((id) => id !== card.id && backstageCards.has(id))) continue;
        const removed = await githubDelete(token, `/repos/${project.repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
        if (removed.ok || removed.status === 404) changed.set(number, false);
        else failed.push(`#${number}: GitHub did not remove ${label} (HTTP ${removed.status}).`);
      }
    }
  } catch (error) {
    return [...failed, describeFailure(error)];
  }
  if (!changed.size) return failed;
  if (snapshot) {
    const updated = snapshot.data.map((story) => {
      const on = changed.get(story.number);
      if (on === undefined) return story;
      const labels = story.labels.filter((name) => name !== label);
      return { ...story, labels: on ? [...labels, label] : labels };
    });
    await writeSnapshot(env.DB, project.repo, STORIES, updated, snapshot.fetchedAt);
  }
  await activityStatement(env.DB, {
    actor: login,
    action: "card_backstage_applied",
    repo: project.repo,
    details: { card: card.id, label, backstage: card.backstage, stories: [...changed.keys()] },
  }).run();
  return failed;
}
