import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { refreshUserToken } from "./github";
import { githubFetch, githubPost, githubPut } from "./github-app";
import type { Project } from "./projects";
import { userToken } from "./session";
import type { TestStep } from "./test-steps";

// A criterion recorded by a tester (la-fabrique#167) as a Gherkin scenario
// (la-fabrique#168), copied or proposed to the project as a pull request on
// `features/<story>.feature`. Never written directly on a branch.

export interface Recorded {
  index: number;
  text: string;
  steps: TestStep[];
}

// The scenarios of a story: for each criterion, its latest recording that
// ticked it and kept steps (a later one without steps does not erase it).
export async function recordedByStory(db: D1Database, repo: string, story?: number): Promise<Map<number, Recorded[]>> {
  const { results } = await db
    .prepare(
      `SELECT issue_number, details FROM activity_log WHERE repo = ? AND action = 'story_test_recorded'${story === undefined ? "" : " AND issue_number = ?"} ORDER BY id`,
    )
    .bind(...(story === undefined ? [repo] : [repo, story]))
    .all<{ issue_number: number | null; details: string | null }>();
  const latest = new Map<number, Map<number, Recorded>>();
  for (const row of results) {
    try {
      const d = JSON.parse(row.details ?? "{}") as { index?: unknown; text?: unknown; done?: unknown; steps?: unknown };
      if (row.issue_number === null || typeof d.index !== "number" || typeof d.text !== "string" || d.done !== true || !Array.isArray(d.steps) || !d.steps.length) continue;
      const criteria = latest.get(row.issue_number) ?? new Map<number, Recorded>();
      criteria.set(d.index, { index: d.index, text: d.text, steps: d.steps as TestStep[] });
      latest.set(row.issue_number, criteria);
    } catch {
      // An unreadable entry is skipped.
    }
  }
  return new Map([...latest].map(([number, criteria]) => [number, [...criteria.values()].sort((x, y) => x.index - y.index)]));
}

export async function recordedCriteria(db: D1Database, repo: string, story: number): Promise<Recorded[]> {
  return (await recordedByStory(db, repo, story)).get(story) ?? [];
}

// One line, no quote that would break the step's text.
function quoted(text: string): string {
  return `"${text.replace(/\s+/g, " ").replace(/"/g, "'").trim()}"`;
}

function line(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Given: the first page; When / And: what was done, in order; Then: the criterion.
export function scenarioText(recorded: Recorded): string {
  const given: string[] = [];
  const when: string[] = [];
  let page = "";
  for (const step of recorded.steps) {
    if (step.kind === "page") {
      if (step.page === page) continue;
      if (page === "" && when.length === 0) given.push(`I am on ${quoted(step.page || "/")}`);
      else when.push(`I go to ${quoted(step.page || "/")}`);
      page = step.page;
      continue;
    }
    if (page === "" && step.page && when.length === 0) {
      given.push(`I am on ${quoted(step.page)}`);
      page = step.page;
    }
    const verb = { click: "I click", fill: "I fill in", select: "I choose an option in", check: "I check" }[step.kind];
    when.push(`${verb} ${quoted(step.name)}`);
  }
  const lines = [
    ...given.map((text, i) => `    ${i === 0 ? "Given" : "And"} ${text}`),
    ...when.map((text, i) => `    ${i === 0 ? "When" : "And"} ${text}`),
  ];
  return [`  Scenario: ${line(recorded.text)}`, ...lines, `    Then ${line(recorded.text)}`].join("\n");
}

export function featureText(title: string, scenarios: Recorded[]): string {
  return `Feature: ${line(title)}\n\n${scenarios.map(scenarioText).join("\n\n")}\n`;
}

export function featurePath(story: number): string {
  return `features/story-${story}.feature`;
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type FeatureOutcome =
  | { ok: true; number: number; url: string; base: string }
  | { ok: false; reason: "signed_out" | "refused" | "nothing"; status?: number };

// A pull request on the integration branch (production without one), in the
// person's name, that adds (or replaces) the story's feature file.
export async function proposeFeature(
  request: Request,
  env: Env,
  project: Project,
  login: string,
  story: number,
  title: string,
  now = new Date(),
): Promise<FeatureOutcome> {
  const scenarios = await recordedCriteria(env.DB, project.repo, story);
  if (!scenarios.length) return { ok: false, reason: "nothing" };
  const token = await userToken(request, env.DB, (refresh) =>
    refreshUserToken(env.GITHUB_APP_CLIENT_ID ?? "", env.GITHUB_APP_CLIENT_SECRET ?? "", refresh),
  );
  if (!token) return { ok: false, reason: "signed_out" };
  const repo = project.repo;
  const config = project.check?.config;
  const base = config?.branches?.integration ?? config?.branches?.production ?? project.check?.branch ?? "main";
  const failed = (response: Response): FeatureOutcome =>
    response.status === 401 ? { ok: false, reason: "signed_out" } : { ok: false, reason: "refused", status: response.status };

  const head = await githubFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  if (!head.ok) return failed(head);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const path = featurePath(story);
  const existing = await githubFetch(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`);
  const current = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;
  const branch = `fabrique/feature-${story}-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const created = await githubPost(token, `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!created.ok) return failed(created);

  const marker = config?.version?.coulisses ? `${config.version.coulisses} ` : "";
  const prTitle = `${marker}La Fabrique: tested scenario${scenarios.length > 1 ? "s" : ""} for #${story}`;
  const commit = await githubPut(token, `/repos/${repo}/contents/${path}`, {
    message: prTitle,
    content: toBase64(featureText(title, scenarios)),
    ...(current ? { sha: current } : {}),
    branch,
  });
  if (!commit.ok) return failed(commit);
  const pull = await githubPost(token, `/repos/${repo}/pulls`, {
    title: prTitle,
    head: branch,
    base,
    body: `Refs #${story}\n\nProposed from La Fabrique by @${login}: ${scenarios.length} criterion${scenarios.length > 1 ? "a" : ""} of #${story} recorded while testing, as a Gherkin scenario in \`${path}\`. Review it, and make its steps run in the project's tests.`,
  });
  if (!pull.ok) return failed(pull);
  const opened = (await pull.json()) as { number: number; html_url: string };
  await activityStatement(env.DB, {
    actor: login,
    action: "feature_proposed",
    repo,
    issueNumber: story,
    details: { pull: opened.number, path, base, scenarios: scenarios.length },
  }).run();
  return { ok: true, number: opened.number, url: opened.html_url, base };
}
