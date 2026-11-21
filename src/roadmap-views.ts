import { barChart } from "./charts";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { monthGrid, shiftMonth, storiesBetween, type EpicProgress, type Release } from "./roadmap";
import type { Story } from "./stories";
import { projectUrl } from "./urls";
import { escapeHtml, layout, type Viewer, backstageChanges } from "./views";

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

// The Releases side panel: the month's calendar, small, each day with a
// version leading to its notes on the page, each day with closed stories
// or an epic done marked; then the month's versions and the other months.
function sideCalendar(base: string, month: string, releases: Release[], stories: Story[]): string {
  const rows = monthGrid(month)
    .map(
      (week) =>
        `<tr>${week
          .map(({ day, inMonth }) => {
            const ofDay = releases.filter((release) => release.date === day);
            const closed = stories.filter((story) => story.state === "closed" && story.closedAt?.startsWith(day));
            const epicsDone = closed.filter((story) => story.subTotal > 0);
            const title = [
              ofDay.length ? `${ofDay.length} version${ofDay.length > 1 ? "s" : ""}: ${ofDay.map((release) => release.version).reverse().join(" → ")}` : "",
              closed.length ? `${closed.length} stor${closed.length > 1 ? "ies" : "y"} closed` : "",
              ...epicsDone.map((epic) => `Epic #${epic.number} done`),
            ].filter(Boolean);
            const number = `<span class="cal-day">${Number(day.slice(8, 10))}</span>${closed.length ? `<span class="cal-dot${epicsDone.length ? " epic-done" : ""}" aria-hidden="true"></span>` : ""}`;
            const label = `${dayTitle(day)}${title.length ? `: ${title.join("; ")}` : ""}`;
            const cell =
              ofDay.length && inMonth
                ? `<a href="#day-${day}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${number}</a>`
                : `<span${title.length ? ` title="${escapeHtml(label)}"` : ""}>${number}</span>`;
            return `<td class="${[inMonth ? "" : "outside", ofDay.length && inMonth ? "has-release" : ""].filter(Boolean).join(" ")}">${cell}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const ofMonth = releases.filter((release) => release.date.startsWith(month));
  // Every month with a version, newest first: a way across the year.
  const months = [...new Map(releases.map((release) => [release.date.slice(0, 7), 0])).keys()].map((value) => ({
    value,
    count: releases.filter((release) => release.date.startsWith(value)).length,
  }));
  return `<aside class="release-side" aria-label="Calendar of the releases">
      <nav class="month-nav compact" aria-label="Month">
        <a href="${escapeHtml(base)}?month=${shiftMonth(month, -1)}" aria-label="${monthTitle(shiftMonth(month, -1))}">←</a>
        <strong>${monthTitle(month)}</strong>
        <a href="${escapeHtml(base)}?month=${shiftMonth(month, 1)}" aria-label="${monthTitle(shiftMonth(month, 1))}">→</a>
      </nav>
      <table class="mini-calendar">
        <thead><tr>${["M", "T", "W", "T", "F", "S", "S"].map((name, i) => `<th><abbr title="${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}">${name}</abbr></th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted small cal-legend"><span class="cal-key has-release" aria-hidden="true"></span> a version <span class="cal-dot" aria-hidden="true"></span> stories closed <span class="cal-dot epic-done" aria-hidden="true"></span> an epic done</p>
      ${
        ofMonth.length
          ? `<h2 class="side-title">In ${monthTitle(month)}</h2><ul class="release-index">${ofMonth
              .map(
                (release) =>
                  `<li><a href="#v-${escapeHtml(release.version)}"><span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` ${escapeHtml(release.title)}` : ""}</a>${release.upcoming ? ` <span class="pill warn small">Upcoming</span>` : ""}</li>`,
              )
              .join("")}</ul>`
          : ""
      }
      ${
        months.length
          ? `<h2 class="side-title">Months</h2><ul class="release-months">${months
              .map(
                (one) =>
                  `<li><a href="${escapeHtml(base)}?month=${one.value}"${one.value === month ? ' aria-current="true"' : ""}>${monthTitle(one.value)}</a> <span class="mono muted small">${one.count}</span></li>`,
              )
              .join("")}</ul>`
          : ""
      }
    </aside>`;
}

export function roadmapPage(
  viewer: Viewer,
  project: Project,
  data: { epics: EpicProgress[]; plan?: string; failure?: string | undefined },
): string {
  const name = project.check?.config?.nom || project.repo;
  return layout(
    `Roadmap · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "roadmap")}
      ${notice(data.failure, "error")}
      ${data.plan ?? ""}
      <section>
        <h2>GitHub epics</h2>
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
    // The stories the entry declares; without them, those closed since the
    // previous version, as a hint.
    const declared = release.stories?.map(
      (number) => data.stories.find((story) => story.number === number) ?? { number, title: "", url: `https://github.com/${project.repo}/issues/${number}` },
    );
    const closed = declared || release.upcoming ? [] : storiesBetween(data.stories, data.releases[index + 1], release);
    return `<article class="release-note" id="v-${escapeHtml(release.version)}">
        <h3><span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` · ${escapeHtml(release.title)}` : ""}</h3>
        <p class="muted">${release.upcoming ? `<span class="pill warn">Upcoming</span>` : `${release.time ? `<span class="mono">${escapeHtml(release.time)}</span>` : ""}`}</p>
        ${release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
        ${backstageChanges(release.backstage)}
        ${releaseLinks(project, release)}
        ${
          declared?.length
            ? `<p class="muted">Stories:</p><ul class="closed-stories">${declared
                .map((story) => `<li><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</li>`)
                .join("")}</ul>`
            : ""
        }
        ${
          closed.length
            ? `<p class="muted">Stories closed since the previous version (the entry does not say which are its own):</p><ul class="closed-stories">${closed
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
      : `<p class="muted">No version in ${monthTitle(data.month)}.${
          data.releases[0] ? ` The latest: <a href="${escapeHtml(base)}?month=${data.releases[0].date.slice(0, 7)}#v-${escapeHtml(data.releases[0].version)}">${escapeHtml(data.releases[0].version)}</a>, ${dayTitle(data.releases[0].date)}.` : ""
        }</p>`;

  return layout(
    `Releases · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "releases")}
      ${notice(data.failure, "error")}
      <div class="releases-layout">
        ${project.check?.config?.version?.fichier ? sideCalendar(base, data.month, data.releases, data.stories) : ""}
        <div class="releases-main">
          ${monthNav(base, data.month)}
          ${body}
          <p class="muted">Versions from the project's “Quoi de neuf” file; stories closed and epics done from GitHub (UTC). Stories are matched to a version by their closing time against the version's date and time, so the split is approximate around a release.</p>
        </div>
      </div>`,
    viewer,
    [],
    projectContext(project),
  );
}
