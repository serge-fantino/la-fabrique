import { DEFECT_LABEL, type DefectTarget } from "./defect-targets";
import { TRIAGE_LABEL } from "./defects";
import type { Env } from "./env";
import { projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Story } from "./stories";
import { defectUrl, projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

// The project's defects: the issues labelled `bug`, with what GitHub does
// not keep, from the log (the story and version they are about, who
// reported them from the app, the screenshot).

export interface DefectRow {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  triage: boolean;
  story: number | null;
  release: string | null;
  version: string | null;
  reporter: string | null;
  reportedAt: string;
  screenshot: string | null;
}

export interface DefectFilters {
  state: "open" | "closed" | "all";
  triage: boolean;
}

interface Reported {
  actor: string;
  story: number | null;
  release: string | null;
  at: string;
  details: Record<string, unknown>;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function defectRows(env: Env, project: Project, stories: Story[]): Promise<DefectRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT occurred_at, actor, action, issue_number, details FROM activity_log WHERE repo = ? AND action IN ('defect_reported', 'defect_linked') ORDER BY id",
  )
    .bind(project.repo)
    .all<{ occurred_at: string; actor: string; action: string; issue_number: number | null; details: string | null }>();
  // The report says who and when; the latest link (report or triage) says
  // which story and version.
  const reported = new Map<number, Reported>();
  for (const row of results) {
    const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    const defect = details["defect"];
    if (typeof defect !== "number") continue;
    const before = reported.get(defect);
    if (row.action === "defect_reported" || !before) {
      reported.set(defect, { actor: row.actor, story: row.issue_number, release: textOf(details["release"]), at: row.occurred_at, details });
    } else {
      reported.set(defect, { ...before, story: row.issue_number, release: textOf(details["release"]) });
    }
  }

  const rows = new Map<number, DefectRow>();
  for (const issue of stories) {
    if (!issue.labels.includes(DEFECT_LABEL)) continue;
    const log = reported.get(issue.number);
    rows.set(issue.number, {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      triage: issue.labels.includes(TRIAGE_LABEL),
      story: log?.story ?? null,
      release: log?.release ?? null,
      version: textOf(log?.details["version"]),
      reporter: log?.actor ?? issue.author,
      reportedAt: log?.at ?? issue.createdAt,
      screenshot: textOf(log?.details["screenshot"]),
    });
  }
  // Reported but not read from GitHub yet (or its label was removed).
  for (const [number, log] of reported) {
    if (rows.has(number) || stories.some((story) => story.number === number)) continue;
    rows.set(number, {
      number,
      title: textOf(log.details["title"]) ?? `#${number}`,
      url: `https://github.com/${project.repo}/issues/${number}`,
      state: "open",
      triage: log.details["triage"] === true,
      story: log.story,
      release: log.release,
      version: textOf(log.details["version"]),
      reporter: log.actor,
      reportedAt: log.at,
      screenshot: textOf(log.details["screenshot"]),
    });
  }
  return [...rows.values()].sort((a, b) => b.number - a.number);
}

export function filterDefects(rows: DefectRow[], filters: DefectFilters): DefectRow[] {
  return rows.filter((row) => (filters.state === "all" || row.state === filters.state) && (!filters.triage || row.triage));
}

export function readDefectFilters(params: URLSearchParams): DefectFilters {
  const state = params.get("state");
  return {
    state: state === "closed" || state === "all" ? state : "open",
    triage: params.get("triage") === "1",
  };
}

function storyCell(row: DefectRow, repo: string, titles: Map<number, string>): string {
  if (row.story === null) return `<span class="muted">—</span>`;
  const title = titles.get(row.story);
  return `<a href="https://github.com/${escapeHtml(repo)}/issues/${row.story}">#${row.story}</a>${title ? ` ${escapeHtml(title)}` : ""}`;
}

// The same choice as the report form: a version and, under it, its
// stories; the current link chosen already.
export function triageChoices(targets: DefectTarget[], row: DefectRow, titles: Map<number, string>): string {
  const current = row.story !== null ? `s:${row.story}` : row.release ? `r:${row.release}` : "";
  let matched = current === "";
  const option = (value: string, label: string) => {
    const selected = value === current || (row.story !== null && value.startsWith(`s:${row.story}:`) && !matched);
    if (selected) matched = true;
    return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  };
  const groups = targets
    .map((target) => {
      const label = `${target.version}${target.title ? ` · ${target.title}` : ""}${target.on_int ? " (on int)" : target.date ? ` (${target.date})` : ""}`;
      const release = target.version === "int" ? "" : target.version;
      const stories = target.stories.map((story) => option(`s:${story.number}:${release}`, `#${story.number} ${story.title}`)).join("");
      return `<optgroup label="${escapeHtml(label)}">${release ? option(`r:${release}`, `Version ${release}, no particular story`) : ""}${stories}</optgroup>`;
    })
    .join("");
  // A story linked before and no longer among the targets stays choosable.
  const kept = !matched && row.story !== null
    ? `<optgroup label="Linked now">${option(`s:${row.story}:${row.release ?? ""}`, `#${row.story} ${titles.get(row.story) ?? ""}`)}</optgroup>`
    : "";
  return `<option value=""${current === "" ? " selected" : ""}>Not linked</option>${kept}${groups}`;
}

// Triage on the defect's page; `back` is "page" to come back to it.
export function triageForm(
  viewer: Viewer,
  base: string,
  back: string,
  row: DefectRow,
  targets: DefectTarget[],
  titles: Map<number, string>,
): string {
  return `<form method="post" action="${escapeHtml(base)}" class="triage-form">${csrfField(viewer)}
        <input type="hidden" name="defect" value="${row.number}" />
        <input type="hidden" name="back" value="${escapeHtml(back)}" />
        <label>It is about <select name="about">${triageChoices(targets, row, titles)}</select></label>
        ${row.triage ? `<label class="check"><input type="checkbox" name="triaged" value="1" checked /> Triaged: remove <em>to triage</em></label>` : ""}
        <button type="submit" class="button quiet">Save</button>
      </form>`;
}

const DEFECT_NOTICES: Record<string, string> = {
  triaged: "Defect triaged: its story and version are saved, and said on GitHub.",
  unchanged: "Nothing to change.",
};

export function defectsPage(
  viewer: Viewer,
  project: Project,
  data: {
    rows: DefectRow[];
    all: DefectRow[];
    stories: Story[];
    filters: DefectFilters;
    failure?: string | undefined;
    canTriage?: boolean;
    notice?: string | null;
  },
): string {
  const titles = new Map(data.stories.map((story) => [story.number, story.title]));
  const open = data.all.filter((row) => row.state === "open").length;
  const triage = data.all.filter((row) => row.state === "open" && row.triage).length;
  const unlinked = data.all.filter((row) => row.state === "open" && row.story === null).length;
  const base = `${projectUrl(project.repo)}/defects`;
  const option = (value: string, label: string) =>
    `<option value="${value}"${data.filters.state === value ? " selected" : ""}>${label}</option>`;
  const rows = data.rows
    .map(
      (row) => `<tr>
        <td><a href="${escapeHtml(defectUrl(project.repo, row.number))}"><span class="mono">#${row.number}</span> ${escapeHtml(row.title)}</a>${row.triage ? ` <span class="pill warn">to triage</span>` : ""}${
          row.state === "closed" ? ` <span class="pill ok">closed</span>` : ""
        }</td>
        <td>${storyCell(row, project.repo, titles)}</td>
        <td class="mono">${escapeHtml(row.release ?? row.version ?? "—")}</td>
        <td>${row.reporter ? `<span class="mono">@${escapeHtml(row.reporter)}</span><br />` : ""}<span class="mono small">${escapeHtml(formatDate(row.reportedAt))}</span></td>
        <td>${row.screenshot ? `<a href="/screenshots/${escapeHtml(row.screenshot)}">Screenshot</a>` : ""}${
          data.canTriage && row.state === "open" ? ` <a href="${escapeHtml(defectUrl(project.repo, row.number))}#triage">Triage</a>` : ""
        }</td>
      </tr>`,
    )
    .join("");
  return layout(
    `Defects · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "defects")}
      ${data.failure ? `<p class="notice error" role="status">${escapeHtml(data.failure)}</p>` : ""}
      ${data.notice && DEFECT_NOTICES[data.notice] ? `<p class="notice ok" role="status">${escapeHtml(DEFECT_NOTICES[data.notice] ?? "")}</p>` : ""}
      <p><strong>${open} open</strong>${triage ? ` · ${triage} to triage` : ""}${unlinked ? ` · ${unlinked} not linked to a story` : ""}</p>
      <p class="muted">The issues labelled <code>${escapeHtml(DEFECT_LABEL)}</code>, with the story and the version each is about. Reports from the project's app say it themselves; the others keep what GitHub knows. Open a defect to read it, see its story and triage it.</p>
      <form method="get" action="${escapeHtml(base)}" class="filters">
        <label>State <select name="state" data-autosubmit>${option("open", "Open")}${option("closed", "Closed")}${option("all", "All")}</select></label>
        <label class="check"><input type="checkbox" name="triage" value="1"${data.filters.triage ? " checked" : ""} data-autosubmit /> To triage only</label>
        <noscript><button type="submit" class="button quiet">Filter</button></noscript>
      </form>
      ${
        data.rows.length
          ? `<table class="defects">
          <thead><tr><th>Defect</th><th>Story</th><th>Version</th><th>Reported</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
          : `<p class="muted">No defect here.</p>`
      }`,
    viewer,
    [],
    projectContext(project),
  );
}
