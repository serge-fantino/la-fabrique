import { storyCards } from "./card-groups";
import type { Env } from "./env";
import { json } from "./http";
import type { GrantProps } from "./oauth";
import { PRODUCTION, type ProductionStatus } from "./production";
import { findProject } from "./projects";
import { can } from "./rights";
import { effectiveRole } from "./accounts";
import { readSnapshot } from "./snapshots";
import { STORIES, type Story } from "./stories";
import { DEFECT_LABEL } from "./defect-targets";
import { reportingEnvironments } from "./defects";
import { storyChecks } from "./validation";

// The stories on int to test, for the project's app (scope `stories:test`,
// la-fabrique#165): what the tester reads next to the app, read only.

export const TO_TEST_ROUTE = /^\/api\/projects\/([^/]+)\/to-test$/;

function refuse(status: number, error: string, message: string): Response {
  return json({ error, message }, { status, headers: { "cache-control": "no-store" } });
}

export async function storiesToTestForApp(request: Request, env: Env, props: GrantProps, projectParam: string): Promise<Response> {
  let wanted: string;
  try {
    wanted = decodeURIComponent(projectParam);
  } catch {
    wanted = "";
  }
  const project = await findProject(env.DB, props.repo);
  if (!project || wanted.toLowerCase() !== props.repo.slice(props.repo.indexOf("/") + 1).toLowerCase()) {
    return refuse(403, "no_access", "This connection works on another project.");
  }
  if (!(props.scopes ?? []).includes("stories:test")) {
    return refuse(403, "insufficient_scope", "This app was not allowed to show the stories to test: connect it again.");
  }
  const role = await effectiveRole(env, props.login);
  if (!can(role, "validate")) return refuse(403, "not_allowed", "Your role does not let you test stories.");

  // Never in production: only an environment the project opens to testing
  // (not of the production type); asked by name, or any of them.
  const environments = await reportingEnvironments(env, project);
  const asked = new URL(request.url).searchParams.get("environment");
  if (asked ? !environments[asked] : Object.keys(environments).length === 0) {
    return refuse(403, "testing_disabled", asked ? `Testing is off on ${asked}.` : "This project has no environment to test on.");
  }

  const [production, snapshot, cards, checks] = await Promise.all([
    readSnapshot<ProductionStatus>(env.DB, project.repo, PRODUCTION),
    readSnapshot<Story[]>(env.DB, project.repo, STORIES),
    storyCards(env.DB, project.repo),
    storyChecks(env.DB, project.repo),
  ]);
  const byNumber = new Map((snapshot?.data ?? []).map((story) => [story.number, story]));
  const numbers = [...new Set((production?.data.groups ?? []).flatMap((group) => group.issues))];
  const stories = numbers
    .map((number) => byNumber.get(number))
    .filter((story): story is Story => story !== undefined && story.state === "open" && story.subTotal === 0 && !story.labels.includes(DEFECT_LABEL))
    .sort((a, b) => a.number - b.number)
    .map((story) => {
      const card = (cards.byStory.get(story.number) ?? []).map((id) => cards.cards.get(id)).find((head) => head !== undefined);
      const validated = checks.get(story.number)?.validated ?? null;
      return {
        number: story.number,
        title: story.title,
        url: story.url,
        card: card ? { id: card.id, title: card.title } : null,
        criteria: (story.criteria ?? []).map((criterion) => ({ text: criterion.text, done: criterion.done })),
        validated: validated ? { by: validated.by, at: validated.at, version: validated.version } : null,
      };
    });
  return json({ stories }, { headers: { "cache-control": "no-store" } });
}
