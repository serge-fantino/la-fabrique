import { RANGES, type ActivityView } from "./activity";
import { barChart } from "./charts";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { projectUrl } from "./urls";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function tile(label: string, value: string, detail?: string): string {
  return `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value mono">${value}</p>${
    detail ? `<p class="tile-detail muted">${detail}</p>` : ""
  }</div>`;
}

export function activityPage(viewer: Viewer, project: Project, view: ActivityView): string {
  const name = project.check?.config?.nom || project.repo;
  const { totals } = view;
  const ranges = RANGES.map((range) =>
    range === view.range
      ? `<span aria-current="true">${range} days</span>`
      : `<a href="${escapeHtml(projectUrl(project.repo))}/activity?days=${range}">${range} days</a>`,
  ).join("");

  const commitsChart = barChart({
    bars: view.days.map((day) => ({
      day: day.day,
      up: day.commits,
      title: `${day.day}: ${day.commits} commit${day.commits === 1 ? "" : "s"}`,
    })),
    label: `Commits per day on ${view.branch}, last ${view.range} days`,
    upClass: "bar-commits",
  });
  const linesChart = barChart({
    bars: view.days.map((day) => ({
      day: day.day,
      up: day.additions ?? 0,
      down: day.deletions ?? 0,
      title:
        day.additions === null
          ? `${day.day}: not read yet`
          : `${day.day}: +${count(day.additions)} / −${count(day.deletions ?? 0)} lines`,
    })),
    label: `Lines added and removed per day on ${view.branch}, last ${view.range} days`,
    upClass: "bar-added",
    downClass: "bar-removed",
  });

  const pending = view.pendingDays
    ? `<p class="notice error" role="status">Lines are still being read for ${view.pendingDays} day${view.pendingDays > 1 ? "s" : ""}: reload in a moment.</p>`
    : "";
  const truncated = view.truncated
    ? `<p class="muted">Very busy period: only the latest 600 commits are counted.</p>`
    : "";

  const authors = view.authors.length
    ? `<section>
        <h2>By author</h2>
        <table>
          <thead><tr><th>Author</th><th>Commits</th></tr></thead>
          <tbody>${view.authors
            .map((author) => `<tr><td class="mono">${escapeHtml(author.author)}</td><td class="mono">${count(author.commits)}</td></tr>`)
            .join("")}</tbody>
        </table>
      </section>`
    : "";

  const table = `<details class="data-table">
      <summary>Show the figures</summary>
      <table>
        <thead><tr><th>Day (UTC)</th><th>Commits</th><th>Lines added</th><th>Lines removed</th></tr></thead>
        <tbody>${[...view.days]
          .reverse()
          .map(
            (day) =>
              `<tr><td class="mono">${day.day}</td><td class="mono">${day.commits}</td><td class="mono">${
                day.additions === null ? "…" : count(day.additions)
              }</td><td class="mono">${day.deletions === null ? "…" : count(day.deletions)}</td></tr>`,
          )
          .join("")}</tbody>
      </table>
    </details>`;

  return layout(
    `Activity · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "activity")}
      ${notice(view.failure, "error")}
      <p class="range">${ranges}</p>
      <p class="muted">Branch <code>${escapeHtml(view.branch)}</code>, days in UTC${
        view.fetchedAt ? `, read from GitHub <span class="mono">${formatDate(view.fetchedAt)}</span>` : ""
      }. Merge commits are not counted.</p>
      <div class="tiles">
        ${tile("Commits", count(totals.commits), `${count(Math.round((totals.commits / view.range) * 10) / 10)} per day`)}
        ${tile("Active days", `${totals.activeDays}/${view.range}`)}
        ${tile("Lines added", `+${count(totals.additions)}`)}
        ${tile("Lines removed", `−${count(totals.deletions)}`)}
      </div>
      ${pending}
      ${truncated}
      <section>
        <h2>Commits per day</h2>
        ${commitsChart}
      </section>
      <section>
        <h2>Lines changed per day</h2>
        <p class="legend"><span class="key key-added"></span> added <span class="key key-removed"></span> removed
          <span class="muted">· net change of <code>${escapeHtml(view.branch)}</code> each day</span></p>
        ${linesChart}
      </section>
      ${table}
      ${authors}`,
    viewer,
    [],
    projectContext(project),
  );
}
