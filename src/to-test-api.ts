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
import type { Project } from "./projects";
import { intVersion, readIssue, storyChecks, tickCriterion, validateStory } from "./validation";
import { activityStatement } from "./activity-log";
import { cleanSteps } from "./test-steps";
import { acceptanceCriteria } from "./stories";

// The stories on int to test, for the project's app (scope `stories:test`,
// la-fabrique#165): what the tester reads next to the app, read only.

export const TO_TEST_ROUTE = /^\/api\/projects\/([^/]+)\/to-test$/;
// Tick a criterion, validate (la-fabrique#166).
export const TO_TEST_STORY_ROUTE = /^\/api\/projects\/([^/]+)\/to-test\/(\d+)\/(criteria|validate)$/;

function refuse(status: number, error: string, message: string): Response {
  return json({ error, message }, { status, headers: { "cache-control": "no-store" } });
}

async function allowed(request: Request, env: Env, props: GrantProps, projectParam: string, what: string): Promise<{ project: Project } | Response> {
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
    return refuse(403, "insufficient_scope", `This app was not allowed to ${what}: connect it again.`);
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
  return { project };
}

async function storiesOnInt(env: Env, project: Project) {
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
    .sort((a, b) => a.number - b.number);
  return { stories, cards, checks };
}

export async function storiesToTestForApp(request: Request, env: Env, props: GrantProps, projectParam: string): Promise<Response> {
  const guard = await allowed(request, env, props, projectParam, "show the stories to test");
  if (guard instanceof Response) return guard;
  const { stories, cards, checks } = await storiesOnInt(env, guard.project);
  return json(
    {
      stories: stories.map((story) => {
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
      }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// POST …/to-test/{story}/criteria {index, done} and …/validate: written on
// the issue and in the log as the To test page does; the story must be one
// of those to test.
export async function actOnStoryForApp(request: Request, env: Env, props: GrantProps, projectParam: string, story: number, action: string): Promise<Response> {
  const guard = await allowed(request, env, props, projectParam, "tick or validate stories");
  if (guard instanceof Response) return guard;
  const { project } = guard;
  if (!(await storiesOnInt(env, project)).stories.some((candidate) => candidate.number === story)) {
    return refuse(404, "not_found", `Story #${story} is not one of the stories to test.`);
  }
  let outcome;
  if (action === "criteria") {
    let data = null as { index?: unknown; done?: unknown; steps?: unknown } | null;
    try {
      data = (await request.json()) as typeof data;
    } catch {
      data = null;
    }
    const index = data?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof data?.done !== "boolean") {
      return refuse(400, "invalid", "Send the criterion's index and done (true or false).");
    }
    const steps = cleanSteps(data?.steps);
    if (steps === null) return refuse(400, "invalid", "steps must be a list.");
    // The text is read from the issue as it is now, never trusted from the app.
    const issue = await readIssue(env, project, story);
    const criterion = issue ? acceptanceCriteria(issue.body)[index] : undefined;
    if (!criterion) return refuse(422, "invalid", `Story #${story} has no criterion ${index}.`);
    outcome = await tickCriterion(request, env, project, props.login, story, index, criterion.text, data.done);
    if (outcome.ok && steps.length > 0) {
      // Kept with the criterion, the story, the version tested and the tester.
      await activityStatement(env.DB, {
        actor: props.login,
        action: "story_test_recorded",
        repo: project.repo,
        issueNumber: story,
        details: { index, text: criterion.text, done: data.done, version: await intVersion(env, project).catch(() => null), steps },
      }).run();
    }
    if (outcome.ok) return json({ ok: true, index, done: data.done, steps: steps.length }, { headers: { "cache-control": "no-store" } });
  } else {
    outcome = await validateStory(request, env, project, props.login, story);
    if (outcome.ok) return json({ ok: true, validated: true }, { headers: { "cache-control": "no-store" } });
  }
  return refuse(outcome.status, outcome.status === 422 ? "not_ready" : outcome.status === 409 ? "conflict" : "github", outcome.message);
}
