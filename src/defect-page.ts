import { renderCardText } from "./card-views";
import type { DefectTarget } from "./defect-targets";
import { SCREENSHOT_ROUTE } from "./defects";
import { triageForm, type DefectRow } from "./defects-tab";
import type { Env } from "./env";
import { githubJson, installationToken } from "./github-app";
import type { LogEntry } from "./log";
import { describe } from "./log-views";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { RestIssue, Story } from "./stories";
import { projectUrl } from "./urls";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

// One defect on its own page: the issue as GitHub has it (text, screenshot,
// comments), the story it is about, its triage and its history in the log.

export interface DefectComment {
  author: string | null;
  at: string;
  url: string;
  body: string;
}

export interface DefectLive {
  body: string | null;
  comments: DefectComment[];
  // The linked story's text, for its preview.
  storyBody: string | null;
  failure?: string;
}

interface RestComment {
  user: { login: string } | null;
  created_at: string;
  html_url: string;
  body?: string | null;
}

// Read from GitHub each time: a defect's page is opened to read it as it is.
export async function readDefectLive(env: Env, project: Project, number: number, story: number | null): Promise<DefectLive> {
  try {
    const token = await installationToken(env, project.installationId);
    const [issue, comments, linked] = await Promise.all([
      githubJson<RestIssue>(token, `/repos/${project.repo}/issues/${number}`),
      githubJson<RestComment[]>(token, `/repos/${project.repo}/issues/${number}/comments?per_page=100`),
      story !== null ? githubJson<RestIssue>(token, `/repos/${project.repo}/issues/${story}`).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      body: issue.body ?? "",
      comments: comments.map((comment) => ({
        author: comment.user?.login ?? null,
        at: comment.created_at,
        url: comment.html_url,
        body: comment.body ?? "",
      })),
      storyBody: linked?.body ?? null,
    };
  } catch (error) {
    return {
      body: null,
      comments: [],
      storyBody: null,
      failure: `GitHub did not answer for #${number}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// What the log says of this defect: its report and each triage.
export async function defectHistory(db: D1Database, repo: string, number: number): Promise<LogEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT id, occurred_at, actor, action, issue_number, details FROM activity_log
       WHERE repo = ? AND action IN ('defect_reported', 'defect_linked') AND json_extract(details, '$.defect') = ?
       ORDER BY id`,
    )
    .bind(repo, number)
    .all<{ id: number; occurred_at: string; actor: string; action: string; issue_number: number | null; details: string | null }>();
  return results.map((row) => {
    let details: Record<string, unknown> = {};
    try {
      details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    } catch {
      // An unreadable detail stays out of the sentence.
    }
    return { id: row.id, at: row.occurred_at, actor: row.actor, action: row.action, issue: row.issue_number, details };
  });
}

// Screenshots La Fabrique keeps are shown; any other image stays a link.
export function ownScreenshots(origin: string): (src: string) => string | null {
  return (src) => {
    try {
      const url = new URL(src, origin);
      return url.origin === origin && SCREENSHOT_ROUTE.test(url.pathname) ? url.pathname : null;
    } catch {
      return null;
    }
  };
}

function storyPreview(project: Project, row: DefectRow, story: Story | undefined, body: string | null, images: (src: string) => string | null): string {
  if (row.story === null) {
    return `<p class="muted">Not linked to a story yet${row.release ? `; about version <span class="mono">${escapeHtml(row.release)}</span>` : ""}.</p>`;
  }
  const url = story?.url ?? `https://github.com/${project.repo}/issues/${row.story}`;
  const criteria = story?.criteria ?? [];
  const done = criteria.filter((criterion) => criterion.done).length;
  return `<div class="story-preview defect-story">
      <p class="defect-story-head"><a href="${escapeHtml(url)}">#${row.story}</a> <strong>${escapeHtml(story?.title ?? "")}</strong>
        ${story ? (story.state === "closed" ? `<span class="pill ok">Closed</span>` : `<span class="pill">Open</span>`) : ""}
        ${row.release ? `<span class="pill mono">${escapeHtml(row.release)}</span>` : ""}
        ${criteria.length ? `<span class="muted small">${done} of ${criteria.length} criteria met</span>` : ""}</p>
      ${
        body === null
          ? ""
          : body.trim()
            ? `<div class="markdown defect-story-text">${renderCardText(body, project.repo, images)}</div>`
            : `<p class="muted">The story has no text.</p>`
      }
    </div>`;
}

const PAGE_NOTICES: Record<string, string> = {
  triaged: "Defect triaged: its story and version are saved, and said on GitHub.",
  unchanged: "Nothing to change.",
};

export function defectPage(
  viewer: Viewer,
  project: Project,
  data: {
    row: DefectRow;
    live: DefectLive;
    story: Story | undefined;
    history: LogEntry[];
    origin: string;
    canTriage: boolean;
    targets: DefectTarget[];
    titles: Map<number, string>;
    notice?: string | null;
    failure?: string | undefined;
  },
): string {
  const { row, live } = data;
  const base = `${projectUrl(project.repo)}/defects`;
  const images = ownScreenshots(data.origin);
  const facts: [string, string][] = [
    ["Reported", `${row.reporter ? `<span class="mono">@${escapeHtml(row.reporter)}</span>, ` : ""}<span class="mono">${escapeHtml(formatDate(row.reportedAt))}</span>`],
  ];
  if (row.version) facts.push(["Seen in", `<span class="mono">${escapeHtml(row.version)}</span>`]);
  const report =
    live.body === null
      ? row.screenshot
        ? `<p><img class="defect-shot" src="/screenshots/${escapeHtml(row.screenshot)}" alt="Screenshot" /></p>`
        : ""
      : live.body.trim()
        ? `<article class="markdown defect-text">${renderCardText(live.body, project.repo, images)}</article>`
        : `<p class="muted">No text.</p>`;
  const comments = live.comments.length
    ? `<h2>Comments</h2>
      <ol class="defect-comments">${live.comments
        .map(
          (comment) => `<li>
          <p class="muted small">${comment.author ? `<span class="mono">@${escapeHtml(comment.author)}</span>, ` : ""}<a class="mono" href="${escapeHtml(comment.url)}">${escapeHtml(formatDate(comment.at))}</a></p>
          <div class="markdown">${renderCardText(comment.body, project.repo, images)}</div>
        </li>`,
        )
        .join("")}</ol>`
    : "";
  const triage =
    data.canTriage && row.state === "open"
      ? `<section id="triage" class="defect-triage">
          <h3>Triage</h3>
          ${triageForm(viewer, base, "page", row, data.targets, data.titles)}
        </section>`
      : "";
  return layout(
    `#${row.number} ${row.title} · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "defects")}
      ${notice(data.failure ?? live.failure, "error")}
      ${notice(data.notice ? PAGE_NOTICES[data.notice] : undefined, "ok")}
      <p class="crumbs"><a href="${escapeHtml(base)}">Defects</a> <span aria-hidden="true">›</span> <span class="mono">#${row.number}</span></p>
      <h1>${escapeHtml(row.title)}</h1>
      <p class="fiche-tags">${row.state === "closed" ? `<span class="pill ok">Closed</span>` : `<span class="pill alert">Open</span>`}${
        row.triage ? ` <span class="pill warn">to triage</span>` : ""
      } <a class="button quiet" href="${escapeHtml(row.url)}">#${row.number} on GitHub</a></p>
      <dl class="facts">${facts.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>
      <h2>It is about</h2>
      ${storyPreview(project, row, data.story, live.storyBody, images)}
      ${triage}
      <h2>The report</h2>
      ${report}
      ${comments}
      <h2>History</h2>
      ${
        data.history.length
          ? `<ul class="card-history">${data.history
              .map((entry) => `<li><span class="mono">@${escapeHtml(entry.actor)}</span> ${describe(entry, project.repo)} <span class="mono muted small">${escapeHtml(formatDate(entry.at))}</span></li>`)
              .join("")}</ul>`
          : `<p class="muted">Nothing in the log: reported on GitHub, not through La Fabrique.</p>`
      }`,
    viewer,
    [],
    projectContext(project),
  );
}
