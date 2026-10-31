import { defectUrl, projectUrl } from "./urls";
import { isEpic } from "./lifecycle";
import type { NextRelease, ProductionStatus } from "./production";
import { notice, progressive, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Release } from "./roadmap";
import type { Story } from "./stories";
import type { StoryChecks } from "./validation";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// What a card may do: tick, validate, report (testers, Product Engineers,
// super admins), and what the log says of the story.
export interface CardActions {
  viewer: Viewer;
  base: string;
  canValidate: boolean;
  checks: Map<number, StoryChecks>;
  all: Map<number, Story>;
}

function criteriaList(story: Story, actions: CardActions): string {
  const criteria = story.criteria ?? [];
  if (!criteria.length) return `<p class="muted small">No acceptance criteria written: test what the title says, and ask for criteria.</p>`;
  return `<ul class="criteria">${criteria
    .map((criterion, index) => {
      const content = `<span class="box" aria-hidden="true">${criterion.done ? "✓" : ""}</span><span>${escapeHtml(criterion.text)}${
        criterion.done ? ` <span class="visually-hidden">(checked)</span>` : ""
      }</span>`;
      if (!actions.canValidate) return `<li class="${criterion.done ? "done" : ""}">${content}</li>`;
      return `<li class="${criterion.done ? "done" : ""}"><form method="post" action="${escapeHtml(actions.base)}/to-test/criterion">
          ${csrfField(actions.viewer)}
          <input type="hidden" name="issue" value="${story.number}" />
          <input type="hidden" name="index" value="${index}" />
          <input type="hidden" name="text" value="${escapeHtml(criterion.text)}" />
          <input type="hidden" name="done" value="${criterion.done ? "0" : "1"}" />
          <button type="submit" class="criterion" aria-pressed="${criterion.done}">${content}</button>
        </form></li>`;
    })
    .join("")}</ul>`;
}

function validation(story: Story, actions: CardActions): string {
  const check = actions.checks.get(story.number);
  const validated = check?.validated
    ? `<p class="small"><span class="pill ok">Validated</span> by @${escapeHtml(check.validated.by)} on <span class="mono">${formatDate(
        check.validated.at.replace(" ", "T"),
      )}</span>${check.validated.version ? ` (version <span class="mono">${escapeHtml(check.validated.version)}</span>)` : ""}</p>`
    : "";
  const defects = (check?.defects ?? []).map((number) => {
    const defect = actions.all.get(number);
    return `<li><a href="${escapeHtml(defectUrl(story.url.split("/").slice(3, 5).join("/"), number))}">#${number}</a> ${
      defect ? escapeHtml(defect.title) : ""
    } ${defect?.state === "closed" ? `<span class="pill ok">Fixed</span>` : `<span class="pill alert">Open</span>`}</li>`;
  });
  if (!actions.canValidate) {
    return `${validated}${defects.length ? `<ul class="defects">${defects.join("")}</ul>` : ""}`;
  }
  const ready = (story.criteria ?? []).every((criterion) => criterion.done);
  return `${validated}
    ${defects.length ? `<ul class="defects">${defects.join("")}</ul>` : ""}
    <div class="test-actions">
      <form method="post" action="${escapeHtml(actions.base)}/to-test/validate">
        ${csrfField(actions.viewer)}
        <input type="hidden" name="issue" value="${story.number}" />
        <button type="submit" class="button${ready ? "" : " quiet"}"${ready ? "" : " disabled"}>${check?.validated ? "Validate again" : "Validate"}</button>
      </form>
      ${ready ? "" : `<span class="muted small">Check every criterion to validate.</span>`}
      <details class="defect-form">
        <summary class="button quiet">Report a defect</summary>
        <form method="post" action="${escapeHtml(actions.base)}/to-test/defect">
          ${csrfField(actions.viewer)}
          <input type="hidden" name="issue" value="${story.number}" />
          <label for="defect-title-${story.number}">Title</label>
          <input id="defect-title-${story.number}" name="title" required maxlength="200" />
          <label for="defect-did-${story.number}">What I did</label>
          <textarea id="defect-did-${story.number}" name="did" rows="3"></textarea>
          <label for="defect-saw-${story.number}">What I saw</label>
          <textarea id="defect-saw-${story.number}" name="saw" rows="3" required></textarea>
          <label for="defect-expected-${story.number}">What I expected</label>
          <textarea id="defect-expected-${story.number}" name="expected" rows="2"></textarea>
          <p><button type="submit" class="button">Open the issue</button></p>
        </form>
      </details>
    </div>`;
}

function storyCard(story: Story, actions: CardActions): string {
  return `<article class="test-story" id="story-${story.number}">
      <h4><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</h4>
      ${criteriaList(story, actions)}
      ${validation(story, actions)}
    </article>`;
}

// Stories grouped by their epic, epics in number order, loose ones last.
function byEpic(repo: string, items: Story[], all: Map<number, Story>, actions: CardActions): string {
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
        .map((story) => storyCard(story, actions))
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
  // Without an integration branch: the stories merged and still open, to
  // validate in production.
  toValidate?: Story[];
  failure?: string | undefined;
  // Open defects not linked to a story yet, to triage.
  unlinked?: { number: number; title: string; url: string; triage: boolean }[];
  // Without it (the latest production version), cards are read-only.
  actions?: Omit<CardActions, "all"> | undefined;
}

// Defects reported without a story: they go back to a feature by triage.
function unlinkedDefects(project: Project, defects: NonNullable<ToTestData["unlinked"]>): string {
  if (!defects.length) return "";
  return `<h2>Defects not linked to a story</h2>
    <ul class="defects">${defects
      .map(
        (defect) =>
          `<li><a href="${escapeHtml(defectUrl(project.repo, defect.number))}">#${defect.number}</a> ${escapeHtml(defect.title)}${defect.triage ? ` <span class="pill warn">to triage</span>` : ""} <a class="small" href="${escapeHtml(defectUrl(project.repo, defect.number))}#triage">Triage</a></li>`,
      )
      .join("")}</ul>
    <p><a class="button quiet" href="${escapeHtml(projectUrl(project.repo))}/defects">All the defects</a></p>`;
}

// What the PO validates: the stories on int with their acceptance criteria,
// and the release-notes changes production does not have yet.
export function toTestContent(project: Project, data: ToTestData): string {
  const all = new Map(data.stories.map((story) => [story.number, story]));
  const actions: CardActions = data.actions
    ? { ...data.actions, all }
    : { viewer: { login: "", role: "tester", csrfToken: "" }, base: "", canValidate: false, checks: new Map(), all };
  const readOnly: CardActions = { ...actions, canValidate: false };
  const failure = notice(data.failure, "error");

  if (!data.status) {
    const pending = (data.toValidate ?? []).filter((story) => !isEpic(story));
    const toValidate = pending.length
      ? `<p class="lede">No integration branch: the stories whose work is merged are checked in production. Validated, a story is done and its issue closed.</p>
        <h2>Stories to validate <span class="muted mono">${pending.length}</span></h2>
        ${byEpic(project.repo, pending, all, actions)}`
      : "";
    if (!data.latest) {
      return `${failure}${toValidate || "<p>Nothing to test: this project has no integration branch, no merged story waits for its validation, and its release notes do not say what the latest version brought yet.</p>"}`;
    }
    const { release, stories } = data.latest;
    return `${failure}
      ${toValidate || `<p class="lede">No integration branch, and no merged story waits for its validation: what the latest production version brought.</p>`}
      <h2>Latest version</h2>
      <div class="release">
        <p><span class="pill ok">In production</span> <span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` · ${escapeHtml(release.title)}` : ""} <span class="muted">· ${escapeHtml(release.date)}${release.time ? ` ${escapeHtml(release.time)}` : ""}</span></p>
        ${release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
      </div>
      ${stories.length ? `<h2>Stories closed for it</h2>${byEpic(project.repo, stories.filter((story) => !isEpic(story)), all, readOnly)}` : ""}`;
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
    ${referred.length ? byEpic(project.repo, referred, all, actions) : `<p class="muted">The work waiting refers to no story; see the changes below.</p>`}
    ${unlinkedDefects(project, data.unlinked ?? [])}
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
