import { barChart } from "./charts";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { monthGrid, shiftMonth, storiesBetween, type EpicProgress, type Release } from "./roadmap";
import type { Story } from "./stories";
import { projectUrl } from "./urls";
import { escapeHtml, layout, type Viewer } from "./views";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthTitle(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? ""} ${month.slice(0, 4)}`;
}

function dayTitle(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTH_NAMES[Number(day.slice(5, 7)) - 1] ?? ""} ${day.slice(0, 4)}`;
}

function monthNav(base: string, month: string): string {
  return `<nav class="month-nav" aria-label="Month">
      <a href="${escapeHtml(base)}?month=${shiftMonth(month, -1)}">← ${monthTitle(shiftMonth(month, -1))}</a>
      <strong>${monthTitle(month)}</strong>
      <a href="${escapeHtml(base)}?month=${shiftMonth(month, 1)}">${monthTitle(shiftMonth(month, 1))} →</a>
    </nav>`;
}

function epicSection(progress: EpicProgress): string {
  const { epic } = progress;
  const chart =
    progress.done.length > 1 && epic.subCompleted > 0
      ? barChart({
          bars: progress.done.map((point) => ({
            day: point.day,
            up: point.count,
            title: `${point.day}: ${point.count}/${epic.subTotal} done`,
          })),
          label: `#${epic.number} stories done over time`,
          upClass: "bar-commits",
          height: 130,
          max: epic.subTotal,
        })
      : "";
  return `<article class="epic">
      <div class="group-head">
        <h3><a href="${escapeHtml(epic.url)}">#${epic.number}</a> ${escapeHtml(epic.title)}</h3>
        ${epic.state === "open" ? `<span class="pill ok">Open</span>` : `<span class="pill">Closed</span>`}
        <span class="mono muted">${epic.subCompleted}/${epic.subTotal} done</span>
        <progress max="${epic.subTotal}" value="${epic.subCompleted}">${epic.subCompleted}/${epic.subTotal}</progress>
      </div>
      <p class="muted">Opened <span class="mono">${epic.createdAt.slice(0, 10)}</span>${
        epic.closedAt ? `, done <span class="mono">${epic.closedAt.slice(0, 10)}</span>` : ""
      }.</p>
      ${chart}
    </article>`;
}

function calendar(project: Project, month: string, releases: Release[], stories: Story[]): string {
  const releasesUrl = `${projectUrl(project.repo)}/releases`;
  const rows = monthGrid(month)
    .map(
      (week) =>
        `<tr>${week
          .map(({ day, inMonth }) => {
            const ofDay = releases.filter((release) => release.date === day);
            const closed = stories.filter((story) => story.state === "closed" && story.closedAt?.startsWith(day));
            const epicsDone = closed.filter((story) => story.subTotal > 0);
            const items = [
              ofDay.length
                ? `<a href="${escapeHtml(releasesUrl)}?month=${day.slice(0, 7)}#day-${day}">${ofDay.length} version${ofDay.length > 1 ? "s" : ""}</a><br /><span class="mono">${escapeHtml(
                    ofDay.length > 1 ? `${ofDay.at(-1)?.version} → ${ofDay[0]?.version}` : (ofDay[0]?.version ?? ""),
                  )}</span>`
                : "",
              closed.length ? `<span>${closed.length} closed</span>` : "",
              ...epicsDone.map((epic) => `<span class="pill ok">Epic #${epic.number} done</span>`),
            ].filter(Boolean);
            return `<td class="${inMonth ? "" : "outside"}${items.length ? "" : " empty"}">
              <span class="day-number"><span class="day-short">${Number(day.slice(8, 10))}</span><span class="day-full">${dayTitle(day)}</span></span>
              ${items.join("<br />")}
            </td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="calendar">
      <thead><tr>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => `<th>${name}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function roadmapPage(
  viewer: Viewer,
  project: Project,
  data: { month: string; releases: Release[]; stories: Story[]; epics: EpicProgress[]; failure?: string | undefined },
): string {
  const name = project.check?.config?.nom || project.repo;
  const base = `${projectUrl(project.repo)}/roadmap`;
  return layout(
    `Roadmap · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "roadmap")}
      ${notice(data.failure, "error")}
      <section>
        <h2>Calendar</h2>
        ${monthNav(base, data.month)}
        ${calendar(project, data.month, data.releases, data.stories)}
        <p class="muted">Versions from the project's “Quoi de neuf” file on the production branch; stories closed and epics done from GitHub (UTC).</p>
      </section>
      <section>
        <h2>Epics</h2>
        ${data.epics.length ? data.epics.map(epicSection).join("") : `<p class="muted">No epic yet: an epic is an issue with sub-issues.</p>`}
      </section>`,
    viewer,
    [],
    projectContext(project),
  );
}

function releaseLinks(project: Project, release: Release): string {
  const production = project.check?.config?.environnements?.["production"]?.url;
  const links = release.links
    .filter((link) => link.startsWith("/") && production)
    .map((link) => `<a href="${escapeHtml(new URL(link, production).toString())}"><code>${escapeHtml(link)}</code></a>`);
  return links.length ? `<p class="links-inline">${links.join(" ")}</p>` : "";
}

export function releasesPage(
  viewer: Viewer,
  project: Project,
  data: { month: string; releases: Release[]; stories: Story[]; failure?: string | undefined },
): string {
  const name = project.check?.config?.nom || project.repo;
  const base = `${projectUrl(project.repo)}/releases`;
  const inMonth = data.releases.filter((release) => release.date.startsWith(data.month));
  const days = [...new Set(inMonth.map((release) => release.date))];

  const article = (release: Release) => {
    const index = data.releases.indexOf(release);
    const closed = release.upcoming ? [] : storiesBetween(data.stories, data.releases[index + 1], release);
    return `<article class="release-note" id="v-${escapeHtml(release.version)}">
        <h3><span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` · ${escapeHtml(release.title)}` : ""}</h3>
        <p class="muted">${release.upcoming ? `<span class="pill warn">Upcoming</span>` : `${release.time ? `<span class="mono">${escapeHtml(release.time)}</span>` : ""}`}</p>
        ${release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
        ${releaseLinks(project, release)}
        ${
          closed.length
            ? `<p class="muted">Stories closed since the previous version:</p><ul class="closed-stories">${closed
                .map((story) => `<li><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</li>`)
                .join("")}</ul>`
            : ""
        }
      </article>`;
  };

  const body = !project.check?.config?.version?.fichier
    ? `<p>This project does not declare its release notes file (<code>version.fichier</code> in <code>.fabrique.json</code>).</p>`
    : days.length
      ? days
          .map(
            (day) => `<section id="day-${day}">
              <h2>${dayTitle(day)}</h2>
              ${inMonth.filter((release) => release.date === day).map(article).join("")}
            </section>`,
          )
          .join("")
      : `<p class="muted">No version in ${monthTitle(data.month)}.</p>`;

  return layout(
    `Releases · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "releases")}
      ${notice(data.failure, "error")}
      ${monthNav(base, data.month)}
      ${body}
      <p class="muted">Stories are matched to a version by their closing time (UTC) against the version's date and time, so the split is approximate around a release.</p>`,
    viewer,
    [],
    projectContext(project),
  );
}
