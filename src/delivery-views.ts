import { barChart } from "./charts";
import { WORKFLOW_LABELS, type DeliveryView, type Run, type WorkflowSummary } from "./delivery";
import { notice, progressive, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}

const RESULT_LABELS: Record<Run["result"], string> = {
  success: "passed",
  failure: "failed",
  running: "running",
  other: "other",
};

function resultPill(run: Run): string {
  const tone = run.result === "success" ? "ok" : run.result === "failure" ? "alert" : "warn";
  return `<span class="pill ${tone}">${run.result === "other" ? escapeHtml(run.conclusion ?? "other") : RESULT_LABELS[run.result]}</span>`;
}

function strip(summary: WorkflowSummary): string {
  const runs = [...summary.recent].reverse();
  if (!runs.length) return "";
  return `<p class="run-strip" aria-label="Last ${runs.length} runs, oldest first">${runs
    .map(
      (run) =>
        `<a class="run run-${run.result}" href="${escapeHtml(run.url)}" title="${escapeHtml(
          `${formatDate(run.startedAt)} · ${run.branch} · ${RESULT_LABELS[run.result]} · ${duration(run.seconds)}`,
        )}"><span class="visually-hidden">${RESULT_LABELS[run.result]}</span></a>`,
    )
    .join("")}</p>`;
}

function workflowSection(summary: WorkflowSummary, runs: Run[], days: string[]): string {
  const label = WORKFLOW_LABELS[summary.key] ?? summary.key;
  const streak = summary.streak
    ? summary.streak.result === "success"
      ? `${summary.streak.count} passed in a row`
      : `<strong>failed ${summary.streak.count} time${summary.streak.count > 1 ? "s" : ""} in a row</strong>`
    : "—";
  const perDay = days.map((day) => {
    const ofDay = runs.filter((run) => run.startedAt.startsWith(day));
    const passed = ofDay.filter((run) => run.result === "success").length;
    const failed = ofDay.filter((run) => run.result === "failure").length;
    return { day, up: passed, down: failed, title: `${day}: ${passed} passed, ${failed} failed` };
  });
  return `<section class="workflow">
      <h2>${escapeHtml(label)} <code>${escapeHtml(summary.file)}</code></h2>
      <div class="tiles">
        <div class="tile"><p class="tile-label">Runs, 30 days</p><p class="tile-value mono">${summary.runs}</p></div>
        <div class="tile"><p class="tile-label">Passed</p><p class="tile-value mono">${
          summary.successRate === null ? "—" : `${Math.round(summary.successRate * 100)}%`
        }</p></div>
        <div class="tile"><p class="tile-label">Median duration</p><p class="tile-value mono">${duration(summary.medianSeconds)}</p></div>
        <div class="tile"><p class="tile-label">Now</p><p class="tile-detail">${streak}</p></div>
      </div>
      ${
        summary.lastFailure
          ? `<p class="muted">Last failure: <span class="mono">${formatDate(summary.lastFailure.startedAt)}</span> on <code>${escapeHtml(
              summary.lastFailure.branch,
            )}</code>, <a href="${escapeHtml(summary.lastFailure.url)}">see the run</a>.</p>`
          : ""
      }
      ${strip(summary)}
      ${
        summary.runs
          ? barChart({
              bars: perDay,
              label: `${label}: runs passed and failed per day, last 30 days`,
              upClass: "bar-success",
              downClass: "bar-failure",
              height: 160,
            })
          : `<p class="muted">No run in the last 30 days.</p>`
      }
    </section>`;
}

// The figures alone: the whole page, or the part a progressive page reads
// once it is shown.
export function deliveryContent(view: DeliveryView): string {
  const body = view.summaries.length
    ? `<p class="legend"><span class="key key-added"></span> passed <span class="key key-removed"></span> failed
        <span class="muted">· last 30 days, UTC${view.fetchedAt ? `, read from GitHub <span class="mono">${formatDate(view.fetchedAt)}</span>` : ""}</span></p>
      ${view.summaries
        .map((summary) => workflowSection(summary, view.runs.filter((run) => run.workflow === summary.key), view.days))
        .join("")}
      <section>
        <h2>Latest runs</h2>
        <table>
          <thead><tr><th>Workflow</th><th>Branch and commit</th><th>Result</th><th>Duration</th><th>Started</th></tr></thead>
          <tbody>${view.runs
            .slice(0, 25)
            .map(
              (run) => `<tr>
                <td>${escapeHtml(WORKFLOW_LABELS[run.workflow] ?? run.workflow)}<br /><span class="muted">${escapeHtml(run.title)}</span></td>
                <td><code>${escapeHtml(run.branch)}</code> <span class="mono muted">${escapeHtml(run.sha.slice(0, 7))}</span></td>
                <td>${resultPill(run)} <a href="${escapeHtml(run.url)}">Logs</a></td>
                <td class="mono nowrap">${duration(run.seconds)}</td>
                <td class="mono muted nowrap">${formatDate(run.startedAt)}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table>
      </section>`
    : `<p>This project declares no workflow (<code>workflows</code> in <code>.fabrique.json</code>).</p>`;

  return `${notice(view.failure, "error")}
      ${body}`;
}

// While GitHub is read, the page shows at once with a placeholder that the
// shared script fills; without the script, a link waits for the figures.
export function deliveryLoading(path: string): string {
  return progressive(`${path}?part=content`, `${path}?wait=1`, "Reading the workflow runs from GitHub…");
}

export function deliveryPage(viewer: Viewer, project: Project, content: string): string {
  const name = project.check?.config?.nom || project.repo;
  return layout(
    `Delivery · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "delivery")}
      ${content}`,
    viewer,
    [],
    projectContext(project),
  );
}
