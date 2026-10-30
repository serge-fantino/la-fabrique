import { isEpic } from "./lifecycle";
import type { NextRelease, ProductionStatus } from "./production";
import { notice, progressive, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Release } from "./roadmap";
import type { Story } from "./stories";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function criteriaList(story: Story): string {
  const criteria = story.criteria ?? [];
  if (!criteria.length) return `<p class="muted small">No acceptance criteria written: test what the title says, and ask for criteria.</p>`;
  return `<ul class="criteria">${criteria
    .map(
      (criterion) =>
        `<li class="${criterion.done ? "done" : ""}"><span class="box" aria-hidden="true">${criterion.done ? "✓" : ""}</span>${escapeHtml(criterion.text)}${
          criterion.done ? ` <span class="visually-hidden">(checked)</span>` : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

function storyCard(story: Story): string {
  return `<article class="test-story">
      <h4><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</h4>
      ${criteriaList(story)}
    </article>`;
}

// Stories grouped by their epic, epics in number order, loose ones last.
function byEpic(repo: string, items: Story[], all: Map<number, Story>): string {
  const groups = new Map<number | null, Story[]>();
  for (const story of items) {
    const epic = story.parent !== null && all.has(story.parent) ? story.parent : null;
    groups.set(epic, [...(groups.get(epic) ?? []), story]);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))
    .map((epic) => {
      const head =
        epic === null
          ? "Without an epic"
          : `<a href="https://github.com/${escapeHtml(repo)}/issues/${epic}">#${epic}</a> ${escapeHtml(all.get(epic)?.title ?? "")}`;
      return `<section class="test-epic"><h3>${head}</h3>${(groups.get(epic) ?? [])
        .sort((a, b) => a.number - b.number)
        .map(storyCard)
        .join("")}</section>`;
    })
    .join("");
}

function changesList(releases: NextRelease[]): string {
  if (!releases.length) return `<p class="muted">No release-notes entry waiting.</p>`;
  return releases
    .map(
      (release) => `<div class="release">
        <p><span class="pill warn">Waiting</span> <span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` · ${escapeHtml(release.title)}` : ""}</p>
        ${release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
      </div>`,
    )
    .join("");
}

export interface ToTestData {
  status: ProductionStatus | null;
  stories: Story[];
  // The environment to test on, when the project declares one besides production.
  environment: { name: string; url: string } | null;
  // Without an integration branch: what the latest production version brought.
  latest: { release: Release; stories: Story[] } | null;
  failure?: string | undefined;
}

// What the PO validates: the stories on int with their acceptance criteria,
// and the release-notes changes production does not have yet.
export function toTestContent(project: Project, data: ToTestData): string {
  const all = new Map(data.stories.map((story) => [story.number, story]));
  const failure = notice(data.failure, "error");

  if (!data.status) {
    if (!data.latest) {
      return `${failure}<p>Nothing to test: this project has no integration branch, and its release notes do not say what the latest version brought yet.</p>`;
    }
    const { release, stories } = data.latest;
    return `${failure}
      <p class="lede">No integration branch: what the latest production version brought.</p>
      <div class="release">
        <p><span class="pill ok">In production</span> <span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` · ${escapeHtml(release.title)}` : ""} <span class="muted">· ${escapeHtml(release.date)}${release.time ? ` ${escapeHtml(release.time)}` : ""}</span></p>
        ${release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
      </div>
      ${stories.length ? `<h2>Stories closed for it</h2>${byEpic(project.repo, stories.filter((story) => !isEpic(story)), all)}` : ""}`;
  }

  const status = data.status;
  const referred = [...new Set(status.groups.flatMap((group) => group.issues))]
    .map((number) => all.get(number))
    .filter((story): story is Story => Boolean(story) && !isEpic(story as Story));
  const releases = status.waiting ?? (status.next ? [status.next] : []);
  const changes = releases.reduce((total, release) => total + release.changes.length, 0);
  const oldest = status.groups
    .map((group) => group.mergedAt ?? group.commits[0]?.date ?? null)
    .filter((date): date is string => Boolean(date))
    .sort()[0];
  const where = data.environment
    ? `<a class="button" href="${escapeHtml(data.environment.url)}">Open ${escapeHtml(data.environment.name)}</a>`
    : "";
  const version = data.environment
    ? status.versions.find((candidate) => candidate.environment === data.environment?.name)?.version
    : null;

  if (status.aheadBy === 0) {
    return `${failure}<p class="notice ok" role="status">Nothing new to test: <code>${escapeHtml(status.integration)}</code> has nothing that <code>${escapeHtml(status.production)}</code> lacks.</p>`;
  }
  return `${failure}
    <div class="test-summary">
      <p><strong>${plural(referred.length, "story", "stories")} and ${plural(changes, "change")} to test</strong> on <code>${escapeHtml(status.integration)}</code>${
        oldest ? `, waiting since <span class="mono">${formatDate(oldest)}</span>` : ""
      }${version ? `; it runs <span class="mono">${escapeHtml(version)}</span>` : ""}.</p>
      ${where}
    </div>
    <h2>Stories</h2>
    ${referred.length ? byEpic(project.repo, referred, all) : `<p class="muted">The work waiting refers to no story; see the changes below.</p>`}
    <h2>Changes in the release notes</h2>
    ${changesList(releases)}`;
}

export function toTestLoading(path: string): string {
  return progressive(`${path}?part=content`, `${path}?wait=1`, "Reading what int has that production lacks…");
}

export function toTestPage(viewer: Viewer, project: Project, content: string): string {
  const name = project.check?.config?.nom || project.repo;
  return layout(
    `To test · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "to_test")}
      ${content}`,
    viewer,
    [],
    projectContext(project),
  );
}
