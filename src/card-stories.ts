import type { Env } from "./env";
import { missingForReady, priorityOf, projectRules, stagesOf, storiesOnInt, type Stage } from "./lifecycle";
import type { Project } from "./projects";
import { loadStories, type Criterion, type LinkedPull } from "./stories";
import { storyChecks } from "./validation";

// A card's stories as GitHub has them (the stories' snapshot), with their
// stage: for the card's page, and for Claude when it reviews them.
export interface CardStory {
  number: number;
  title: string;
  stage: Stage | null;
  closed: boolean;
  criteria: Criterion[];
  // Its priority label, and what its Definition of Ready still lacks.
  priority: string | null;
  missing: string[];
  // Its pull requests (by the branch's or the text's #number).
  pulls: LinkedPull[];
  // Validated on int (or in production without integration): by whom, when.
  validated?: { by: string; at: string } | null;
}

export async function cardStories(env: Env, project: Project, numbers: number[]): Promise<Map<number, CardStory>> {
  const found = new Map<number, CardStory>();
  if (!numbers.length) return found;
  const [{ stories }, onInt, checks] = await Promise.all([loadStories(env, project), storiesOnInt(env, project), storyChecks(env.DB, project.repo)]);
  const rules = await projectRules(env.DB, project);
  const stages = stagesOf(stories, rules, onInt);
  for (const story of stories) {
    if (!numbers.includes(story.number)) continue;
    found.set(story.number, {
      number: story.number,
      title: story.title,
      stage: stages.get(story.number) ?? null,
      closed: story.state === "closed",
      criteria: story.criteria ?? [],
      priority: priorityOf(story, rules),
      missing: missingForReady(story, rules),
      pulls: story.pullRequests,
      validated: checks.get(story.number)?.validated ?? null,
    });
  }
  return found;
}
