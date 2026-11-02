import { recordedCriteria, type Recorded } from "./gherkin";
import { scenarioBlock } from "./gherkin-views";
import { cardRef, cardUrl } from "./card-views";
import { storyCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import { claudeLaunches, claudeRuns, type ClaudeRun } from "./claude";
import type { Env } from "./env";
import { isDeveloped, isToTest } from "./lifecycle";
import type { LogEntry } from "./log";
import { describe } from "./log-views";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { lastMergeAttempts, pullDetails, type MergeAttempt, type PullDetail } from "./sprint-pulls";
import { loadStories, type Story } from "./stories";
import { canValidate } from "./validation";
import { storyStatus } from "./stories-views";
import { projectUrl } from "./urls";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

// A story's detail, from the sprint (la-fabrique#113): where it stands, step
// by step (ready, Claude, pull request, online, tested, in production), its
// criteria, its pull requests and Claude's runs, and its history from the
// log. Everything is read from GitHub and the log: nothing is kept apart.
export interface StoryDetail {
  number: number;
  story: Story | null;
  state: CardStory | null;
  cards: { id: number; title: string }[];
  pulls: PullDetail[];
  merges: Map<number, MergeAttempt>;
  runs: ClaudeRun[];
  launched: { by: string; at: string } | null;
  history: LogEntry[];
  scenarios: Recorded[];
}

export async function loadStoryDetail(env: Env, project: Project, number: number): Promise<StoryDetail> {
  const [{ stories }, states, links, launches, runs, merges] = await Promise.all([
    loadStories(env, project),
    cardStories(env, project, [number]),
    storyCards(env.DB, project.repo),
    claudeLaunches(env.DB, project.repo),
    claudeRuns(env, project).catch(() => [] as ClaudeRun[]),
    lastMergeAttempts(env.DB, project.repo),
  ]);
  const state = states.get(number) ?? null;
  const numbers = (state?.pulls ?? []).map((pull) => pull.number);
  const details = await pullDetails(env, project, numbers);
  const cards = (links.byStory.get(number) ?? []).map((id) => ({ id, title: links.cards.get(id)?.title ?? "" }));
  // The log: the story's own entries and its pull requests'.
  const keys = [number, ...numbers];
  const { results } = await env.DB.prepare(
    `SELECT id, occurred_at, actor, action, issue_number, details FROM activity_log
     WHERE repo = ? AND issue_number IN (${keys.map(() => "?").join(", ")}) ORDER BY id`,
  )
    .bind(project.repo, ...keys)
    .all<{ id: number; occurred_at: string; actor: string; action: string; issue_number: number | null; details: string | null }>();
  const history = results.map((row) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    } catch {
      // An unreadable detail stays out of the sentence.
    }
    return { id: row.id, at: row.occurred_at, actor: row.actor, action: row.action, issue: row.issue_number, details: parsed };
  });
  return {
    number,
    story: stories.find((candidate) => candidate.number === number) ?? null,
    state,
    cards,
    pulls: numbers.map((pull) => details.get(pull)).filter((pull): pull is PullDetail => Boolean(pull)),
    merges,
    runs: runs.filter((run) => run.issue === number),
    launched: launches.get(number) ?? null,
    history,
    scenarios: await recordedCriteria(env.DB, project.repo, number),
  };
}

type StepState = "done" | "current" | "waiting";

const STEP_MARKS: Record<StepState, string> = { done: "✓", current: "●", waiting: "○" };

// The steps a story goes through, each done, current or still to come.
function steps(detail: StoryDetail, project: Project): { label: string; state: StepState; note: string }[] {
  const state = detail.state;
  const stage = state?.stage ?? null;
  const closed = Boolean(state?.closed);
  const merged = detail.pulls.some((pull) => pull.state === "merged") || (state?.pulls ?? []).some((pull) => pull.state === "merged");
  const open = (state?.pulls ?? []).some((pull) => pull.state === "open");
  const online = isDeveloped(state) || merged;
  const tested = closed || Boolean(state?.validated);
  const hasIntegration = Boolean(project.check?.config?.branches?.integration);
  // Each step and whether it is done; the first not done is the current one.
  const order: [string, boolean, string][] = [
    ["Ready for dev", stage !== "backlog", stage === "backlog" ? `Missing: ${(state?.missing ?? []).join(", ")}` : ""],
    ["Claude at work", Boolean(detail.launched) || open || merged || closed, detail.launched ? `Launched by @${detail.launched.by} on ${detail.launched.at.slice(0, 10)}` : ""],
    ["Pull request", merged || closed, open ? "Open, waiting for its merge" : merged ? "Merged" : ""],
    [hasIntegration ? "On int" : "Online", online, ""],
    ["Tested", tested, state?.validated ? `Validated by @${state.validated.by}` : ""],
    ["In production", closed, closed ? "Released, issue closed" : ""],
  ];
  let current = false;
  return order.map(([label, done, note]) => {
    if (done) return { label, state: "done" as const, note };
    if (!current) {
      current = true;
      return { label, state: "current" as const, note };
    }
    return { label, state: "waiting" as const, note };
  });
}

const FEATURE_FAILURES: Record<string, string> = {
  signed_out: "GitHub no longer accepts your sign-in. Sign out and sign in again.",
  refused: "GitHub refused the change. The GitHub App needs Contents and Pull requests write permission on this repository, and you need write access to it.",
  nothing: "No criterion was recorded for this story yet.",
};

export function storyDetailPage(viewer: Viewer, project: Project, detail: StoryDetail, feature: { pull?: number; failed?: string } = {}): string {
  const base = projectUrl(project.repo);
  const github = `https://github.com/${escapeHtml(project.repo)}`;
  const state = detail.state;
  const title = detail.story?.title ?? state?.title ?? `Story #${detail.number}`;
  const criteria = state?.criteria ?? [];
  const timeline = steps(detail, project)
    .map(
      (step) =>
        `<li class="story-step ${step.state}"><span class="story-step-mark" aria-hidden="true">${STEP_MARKS[step.state]}</span> <strong>${escapeHtml(step.label)}</strong>${
          step.note ? ` <span class="muted small">${escapeHtml(step.note)}</span>` : ""
        }<span class="visually-hidden"> (${step.state})</span></li>`,
    )
    .join("");
  const pulls = detail.pulls.length
    ? `<ul class="story-pulls">${detail.pulls
        .map((pull) => {
          const attempt = detail.merges.get(pull.number);
          return `<li><a href="${escapeHtml(pull.url)}">PR #${pull.number}</a> ${escapeHtml(pull.title)} <span class="pill small${pull.state === "merged" ? " ok" : pull.state === "open" ? " warn" : ""}">${pull.draft && pull.state === "open" ? "draft" : pull.state}</span>${
            pull.base ? ` <span class="muted small">into <code>${escapeHtml(pull.base)}</code></span>` : ""
          }${pull.mergeable === "dirty" ? ` <span class="pill alert small">In conflict</span>` : ""}${
            attempt && attempt.conclusion !== "success" && pull.state === "open" ? ` <span class="small">Merge refused: ${escapeHtml(attempt.reason ?? "the workflow stopped")}</span>` : ""
          }${pull.reviewers.length ? ` <span class="muted small">review asked from ${pull.reviewers.map((login) => `@${escapeHtml(login)}`).join(", ")}</span>` : ""}</li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">No pull request yet.</p>`;
  const runs = detail.runs.length
    ? `<ul>${detail.runs
        .map((run) => `<li><a href="${escapeHtml(run.url)}">${escapeHtml(run.status === "completed" ? (run.conclusion ?? "ended") : run.status)}</a> <span class="muted small mono">${escapeHtml(run.createdAt.slice(0, 16).replace("T", " "))} UTC</span></li>`)
        .join("")}</ul>`
    : `<p class="muted">No Claude run seen for this story.</p>`;
  const history = detail.history.length
    ? `<table class="log"><tbody>${detail.history
        .map((entry) => `<tr><td class="mono small">${escapeHtml(formatDate(entry.at))}</td><td class="mono small">@${escapeHtml(entry.actor)}</td><td>${describe(entry, project.repo)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">Nothing in the log yet.</p>`;
  return layout(
    `#${detail.number} ${title} · Sprint · La Fabrique extraordinaire`,
    `${projectHeader(project, "sprint", `#${detail.number} ${title}`)}
      <p class="crumbs"><a href="${escapeHtml(base)}/sprint">Sprint</a> <span aria-hidden="true">›</span> <span class="mono">#${detail.number}</span></p>
      <p class="fiche-tags"><a class="mono small" href="${github}/issues/${detail.number}">Issue #${detail.number} on GitHub</a> ${state?.stage ? storyStatus(state) : ""}${state?.priority ? ` <span class="pill">${escapeHtml(state.priority)}</span>` : ""}${
        detail.cards.length ? ` <span class="muted small">from ${detail.cards.map((card) => `<a class="mono" href="${escapeHtml(cardUrl(project.repo, card.id))}">${cardRef(card.id)}</a> ${escapeHtml(card.title)}`).join(", ")}</span>` : ""
      }</p>
      <section class="story-detail">
        <h2>Steps</h2>
        <ol class="story-steps">${timeline}</ol>
        <h2>Acceptance criteria <span class="muted mono">${criteria.filter((criterion) => criterion.done).length}/${criteria.length}</span></h2>
        ${
          criteria.length
            ? `<ul class="criteria">${criteria.map((criterion) => `<li class="${criterion.done ? "done" : ""}"><span class="box" aria-hidden="true">${criterion.done ? "✓" : ""}</span> ${escapeHtml(criterion.text)}</li>`).join("")}</ul>`
            : `<p class="muted">No acceptance criteria written.</p>`
        }
        ${
          feature.pull
            ? `<p class="notice ok" role="status">Proposed to the project: <a href="https://github.com/${escapeHtml(project.repo)}/pull/${feature.pull}">pull request #${feature.pull}</a>.</p>`
            : feature.failed
              ? notice(FEATURE_FAILURES[feature.failed] ?? "The scenario could not be proposed.", "error")
              : ""
        }
        ${scenarioBlock(viewer, base, detail.number, title, detail.scenarios, canValidate(viewer.role), "story")}
        ${isToTest(state) ? `<p><a class="button quiet" href="${escapeHtml(base)}/to-test#story-${detail.number}">Test it in To test</a></p>` : ""}
        <h2>Pull requests</h2>
        ${pulls}
        <h2>Claude's runs</h2>
        ${runs}
        <h2>History</h2>
        ${history}
      </section>`,
    viewer,
    [],
    projectContext(project, false),
  );
}
