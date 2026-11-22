import type { Role } from "./accounts";
import { activityStatement } from "./activity-log";
import { cardStories } from "./card-stories";
import { launchClaude } from "./claude";
import type { Env } from "./env";
import { githubPost, installationToken } from "./github-app";
import { toEvent, type BreakKind, type EventRow, type LoopEvent } from "./loop-events";
import type { Project } from "./projects";
import { can, type Action } from "./rights";
import { relaunchable, sprintRunFor } from "./sprint-run";
import { wordingFor } from "./wording";

// The breaks of the loop as tasks for a person (ADR 0003 § 3, epic F15,
// C186): a break goes to the role that can unblock it; that person answers
// from the story's page, the answer goes on the issue in their name and in
// the log, and Claude is relaunched on the story, which reads it. A break is
// never answered by an agent: no MCP tool answers one.

export interface BreakOwner {
  // The right it takes to answer; null: nobody has to.
  action: Action;
  who: string;
  // What a good answer says, for the form.
  hint: string;
}

export const BREAK_OWNERS: Record<BreakKind, BreakOwner> = {
  decision: {
    action: "request",
    who: "its deciders: a Product Engineer and above",
    hint: "The decision taken (accept, change or refuse the proposed ADR), and what Claude does next.",
  },
  spec: {
    action: "request",
    who: "a Product Engineer and above",
    hint: "The criterion as it should read, or what the story really asks. Rewrite the criteria on the issue too if they change.",
  },
  tests: { action: "launch_claude", who: "a tech lead and above", hint: "Why the tests do not pass and how to go on: fix, change the test, or split the story." },
  code: { action: "launch_claude", who: "a tech lead and above", hint: "Whether Claude may go past the limit (a larger change, a protected file), or how to cut the work." },
  review: { action: "launch_claude", who: "a tech lead and above", hint: "Which blocking findings to address, and which to leave." },
  quota: { action: "launch_claude", who: "nobody needs to: a tech lead relaunches Claude once the usage window is open", hint: "Nothing to decide: say when to go on." },
};

export function canAnswer(role: Role | null, kind: BreakKind): boolean {
  return can(role, BREAK_OWNERS[kind].action);
}

// A story's open break: its loop's last event is a break no one answered.
export function openBreakOf(events: LoopEvent[]): LoopEvent | null {
  const last = events[events.length - 1];
  return last && last.phase === "break" && last.breakKind && !last.answeredAt ? last : null;
}

export interface OpenBreak extends LoopEvent {
  repo: string;
}

// Every open break, across projects (the Agents page), the oldest first.
export async function openBreaks(db: D1Database): Promise<OpenBreak[]> {
  const { results } = await db
    .prepare(
      `SELECT e.* FROM loop_events e
       WHERE e.phase = 'break' AND e.answered_at IS NULL
         AND e.id = (SELECT MAX(x.id) FROM loop_events x WHERE x.repo = e.repo AND x.story = e.story)
       ORDER BY e.id LIMIT 200`,
    )
    .all<EventRow>();
  return results.filter((row) => row.break_kind).map((row) => ({ ...toEvent(row), repo: row.repo }));
}

export type AnswerOutcome =
  | { ok: true; relaunched: boolean; comment: string | null; notice: string | null }
  | { ok: false; message: string; status: 403 | 404 | 409 | 422 | 502 };

// A person answers a break: on the issue in their name, in the log, then
// Claude again on the story if they ask (on its branch, which holds the
// stopped run's commits; a rework stays a rework).
export async function answerBreak(
  env: Env,
  project: Project,
  viewer: { login: string; role: Role | null },
  story: number,
  eventId: number,
  text: string,
  relaunch: boolean,
): Promise<AnswerOutcome> {
  const answer = text.trim().slice(0, 4000);
  if (!answer) return { ok: false, message: "Write your answer: Claude reads it when it resumes.", status: 422 };
  const row = await env.DB.prepare("SELECT * FROM loop_events WHERE id = ? AND repo = ? AND story = ?").bind(eventId, project.repo, story).first<EventRow>();
  if (!row || row.phase !== "break" || !row.break_kind) return { ok: false, message: "There is no such stop on this story.", status: 404 };
  const event = toEvent(row);
  const kind = event.breakKind as BreakKind;
  if (!canAnswer(viewer.role, kind)) return { ok: false, message: `This stop is for ${BREAK_OWNERS[kind].who}.`, status: 403 };
  if (event.answeredAt) return { ok: false, message: `@${event.answeredBy ?? "someone"} already answered this stop.`, status: 409 };
  const last = await env.DB.prepare("SELECT MAX(id) AS id FROM loop_events WHERE repo = ? AND story = ?").bind(project.repo, story).first<{ id: number }>();
  if (last?.id !== event.id) return { ok: false, message: "Claude went on after this stop: there is nothing left to answer.", status: 409 };

  const words = wordingFor(project);
  const body = [words.breakAnswer(viewer.login, words.breakKinds[kind]), event.breakReason ? `> ${words.breakWas} ${event.breakReason.replace(/\n/g, " ")}` : "", answer, `---\n${words.breakResume}`]
    .filter(Boolean)
    .join("\n\n");
  const token = await installationToken(env, project.installationId);
  const posted = await githubPost(token, `/repos/${project.repo}/issues/${story}/comments`, { body });
  if (!posted.ok) return { ok: false, message: `GitHub refused the comment (HTTP ${posted.status}): nothing was recorded.`, status: 502 };
  const comment = ((await posted.json()) as { html_url?: string }).html_url ?? null;

  // Recorded once: the first answer holds.
  const marked = await env.DB.prepare("UPDATE loop_events SET answered_by = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND answered_at IS NULL")
    .bind(viewer.login, event.id)
    .run();
  if (!marked.meta.changes) return { ok: false, message: "Someone answered this stop at the same moment.", status: 409 };

  let relaunched = false;
  let notice: string | null = null;
  if (relaunch) {
    const state = (await cardStories(env, project, [story]).catch(() => null))?.get(story);
    const outcome = await launchClaude(env, project, viewer.login, story, { rework: Boolean(state?.rework), byHand: can(viewer.role, "launch_claude") });
    if (outcome.ok) {
      relaunched = true;
      // A card of the sprint's run stopped on this story follows it again.
      const run = sprintRunFor(env, project.repo);
      const stopped = run ? (await run.state().catch(() => null))?.cards.find((card) => card.stories[card.at] === story && relaunchable(card)) : undefined;
      if (run && stopped) await run.control(viewer.login, "relaunched", stopped.id).catch(() => null);
    } else {
      notice = `Your answer is on the issue, but Claude was not relaunched: ${outcome.message}`;
    }
  }
  await activityStatement(env.DB, {
    actor: viewer.login,
    action: "loop_break_answered",
    repo: project.repo,
    issueNumber: story,
    details: { kind, run: event.runId, event: event.id, text: answer.slice(0, 1000), comment, relaunched },
  }).run();
  return { ok: true, relaunched, comment, notice };
}

