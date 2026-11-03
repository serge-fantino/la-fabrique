import { relayFacts } from "./relay";
import { projectUrl } from "./urls";
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
import { decodeScreenshot, storeScreenshot, testEnvironment } from "./defects";
import { installationToken, githubPost } from "./github-app";
import { projectRules, reworkLabelOf, stageOf } from "./lifecycle";
import { applyIssueEvent } from "./stories";
import { wordingFor } from "./wording";
import type { Project } from "./projects";
import { intVersion, readIssue, storyChecks, tickCriterion, validateStory } from "./validation";
import { activityStatement } from "./activity-log";
import { cleanSteps } from "./test-steps";
import { acceptanceCriteria } from "./stories";

// The stories on int to test, for the project's app (scope `stories:test`,
// la-fabrique#165): what the tester reads next to the app, read only.

export const TO_TEST_ROUTE = /^\/api\/projects\/([^/]+)\/to-test$/;
// Tick a criterion, validate (la-fabrique#166).
// …and give a feedback that sends the story back to development (#201).
export const TO_TEST_STORY_ROUTE = /^\/api\/projects\/([^/]+)\/to-test\/(\d+)\/(criteria|validate|feedback)$/;

function refuse(status: number, error: string, message: string): Response {
  return json({ error, message }, { status, headers: { "cache-control": "no-store" } });
}

async function allowed(request: Request, env: Env, props: GrantProps, projectParam: string, what: string): Promise<{ project: Project; onInt: boolean } | Response> {
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

  // Only on the test environment (la-fabrique#209): int, or production for
  // a project without an integration branch. Asked by the query, or said by
  // the relay (protocol 2, la-fabrique#195).
  const test = await testEnvironment(env, project);
  const asked = new URL(request.url).searchParams.get("environment") ?? relayFacts(request).environment;
  if (!test) return refuse(403, "testing_disabled", "This project has no environment to test on.");
  if (asked && asked !== test.name) return refuse(403, "testing_disabled", `Testing is off on ${asked}: the stories are tested on ${test.name}.`);
  return { project, onInt: test.environment.type === "integration" || Boolean(project.check?.config?.branches?.integration) };
}

// The stories to test: on int, those int has; without int (la-fabrique#210),
// those merged and still open, as To test lists them, and those back in
// development after a feedback.
async function storiesToTest(env: Env, project: Project, onInt: boolean) {
  if (!onInt) {
    const [snapshot, cards, checks, rules] = await Promise.all([
      readSnapshot<Story[]>(env.DB, project.repo, STORIES),
      storyCards(env.DB, project.repo),
      storyChecks(env.DB, project.repo),
      projectRules(env.DB, project),
    ]);
    const stories = (snapshot?.data ?? [])
      .filter((story) => story.state === "open" && story.subTotal === 0 && !story.labels.includes(DEFECT_LABEL))
      .filter((story) => {
        const stage = stageOf(story, rules, new Set());
        const merged = story.pullRequests.some((pull) => pull.state === "merged");
        return stage === "to_validate" || (merged && story.labels.includes(rules.reworkLabel));
      })
      .sort((a, b) => a.number - b.number);
    return { stories, cards, checks };
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
    .sort((a, b) => a.number - b.number);
  return { stories, cards, checks };
}

export async function storiesToTestForApp(request: Request, env: Env, props: GrantProps, projectParam: string): Promise<Response> {
  const guard = await allowed(request, env, props, projectParam, "show the stories to test");
  if (guard instanceof Response) return guard;
  const { stories, cards, checks } = await storiesToTest(env, guard.project, guard.onInt);
  return json(
    {
      stories: stories.map((story) => {
        const card = (cards.byStory.get(story.number) ?? []).map((id) => cards.cards.get(id)).find((head) => head !== undefined);
        const validated = checks.get(story.number)?.validated ?? null;
        // Its feedbacks from testing, and whether it is back in development.
        const feedbacks = (checks.get(story.number)?.feedbacks ?? []).map((feedback) => ({
          criterion: feedback.criterion,
          text: feedback.text,
          by: feedback.by,
          at: feedback.at,
          url: feedback.url,
        }));
        const rework = story.labels.includes(reworkLabelOf(guard.project.check?.config));
        const failedAt = (index: number) => {
          const last = [...feedbacks].reverse().find((feedback) => feedback.criterion === index);
          return last ? { text: last.text, by: last.by, at: last.at, url: last.url, open: rework } : null;
        };
        return {
          number: story.number,
          title: story.title,
          url: story.url,
          // Its feature and its page in La Fabrique (la-fabrique#206).
          card: card ? { id: card.id, title: card.title, url: new URL(`${projectUrl(guard.project.repo)}/cards/${card.id}`, request.url).toString() } : null,
          page: new URL(`${projectUrl(guard.project.repo)}/sprint/stories/${story.number}`, request.url).toString(),
          criteria: (story.criteria ?? []).map((criterion, index) => ({ text: criterion.text, done: criterion.done, failed: failedAt(index) })),
          validated: validated ? { by: validated.by, at: validated.at, version: validated.version } : null,
          rework,
          feedbacks,
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
  if (!(await storiesToTest(env, project, guard.onInt)).stories.some((candidate) => candidate.number === story)) {
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
  } else if (action === "feedback") {
    return giveFeedback(request, env, project, props, story);
  } else {
    outcome = await validateStory(request, env, project, props.login, story);
    if (outcome.ok) return json({ ok: true, validated: true }, { headers: { "cache-control": "no-store" } });
  }
  return refuse(outcome.status, outcome.status === 422 ? "not_ready" : outcome.status === 409 ? "conflict" : "github", outcome.message);
}

// A feedback from testing (la-fabrique#201): a criterion that fails (or the
// story as a whole), what the tester saw, an optional screenshot. Not a new
// issue: a comment on the story, in the tester's name and the project's
// language; the story gets the rework label and goes back to development,
// the criterion unticked. Nothing is launched: a person decides (#202).
async function giveFeedback(request: Request, env: Env, project: Project, props: GrantProps, story: number): Promise<Response> {
  let data: Record<string, unknown> | null = null;
  try {
    const raw = await request.text();
    if (raw.length > 3 * 1024 * 1024) return refuse(400, "invalid", "The feedback is too large.");
    const parsed: unknown = JSON.parse(raw);
    data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  const text = typeof data?.["text"] === "string" ? data["text"].trim().slice(0, 4000) : "";
  if (!data || !text) return refuse(400, "invalid", "Say what happened (text).");
  const rawIndex = data["criterion"];
  if (rawIndex !== undefined && rawIndex !== null && (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0)) {
    return refuse(400, "invalid", "criterion must be the criterion's index.");
  }
  const screenshot = decodeScreenshot(data["screenshot"]);
  if (screenshot === "invalid") return refuse(400, "invalid", "The screenshot must be a PNG or JPEG image of 2 MB at most.");
  const page = typeof data["page"] === "string" && data["page"].startsWith("/") ? data["page"].slice(0, 500) : null;
  // The criterion's text is read from the issue as it is now.
  const issue = await readIssue(env, project, story);
  if (!issue) return refuse(502, "github", `Issue #${story} could not be read.`);
  const index = typeof rawIndex === "number" ? rawIndex : null;
  const criterion = index !== null ? acceptanceCriteria(issue.body)[index] : undefined;
  if (index !== null && !criterion) return refuse(422, "invalid", `Story #${story} has no criterion ${index + 1}.`);

  const facts = relayFacts(request);
  const version = facts.version ?? (await intVersion(env, project).catch(() => null));
  const stored = screenshot ? await storeScreenshot(env, project.repo, props.login, screenshot) : null;
  const screenshotUrl = stored ? new URL(`/screenshots/${stored}`, request.url).href : null;
  const words = wordingFor(project);
  const body = [
    words.feedback(props.login, facts.environment, version),
    criterion && index !== null ? words.feedbackCriterion(index + 1, criterion.text) : words.feedbackWhole,
    `> ${text.replace(/\n/g, "\n> ")}`,
    page ? `${words.feedbackPage} \`${page.replace(/`/g, "")}\`` : "",
    screenshotUrl ? `![screenshot](${screenshotUrl})` : "",
    `---\n${words.feedbackRework}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const token = await installationToken(env, project.installationId);
  const comment = await githubPost(token, `/repos/${project.repo}/issues/${story}/comments`, { body });
  if (!comment.ok) return refuse(502, "github", `GitHub refused the comment (HTTP ${comment.status}).`);
  const commentUrl = ((await comment.json()) as { html_url?: string }).html_url ?? null;
  const rework = reworkLabelOf(project.check?.config);
  const labelled = await githubPost(token, `/repos/${project.repo}/issues/${story}/labels`, { labels: [rework] });
  if (labelled.ok) {
    const labels = issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
    await applyIssueEvent(env, project.repo, "labeled", { ...issue, labels: [...new Set([...labels, rework])].map((name) => ({ name })) });
  }
  if (criterion && index !== null && criterion.done) {
    await tickCriterion(request, env, project, props.login, story, index, criterion.text, false).catch(() => null);
  }
  await activityStatement(env.DB, {
    actor: props.login,
    action: "story_feedback",
    repo: project.repo,
    issueNumber: story,
    details: {
      ...(index !== null && criterion ? { criterion: index, criterion_text: criterion.text.slice(0, 300) } : {}),
      text: text.slice(0, 1000),
      comment: commentUrl,
      environment: facts.environment,
      version,
      ...(stored ? { screenshot: stored } : {}),
    },
  }).run();
  return json({ ok: true, comment: commentUrl, rework: true }, { status: 201, headers: { "cache-control": "no-store" } });
}
