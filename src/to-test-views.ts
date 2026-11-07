import type { StoryCards } from "./card-groups";
import { linkNamedForm } from "./card-views";
import { reworkLabelOf } from "./lifecycle";
import type { Recorded } from "./gherkin";
import { scenarioBlock } from "./gherkin-views";
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
  // The label of a story back in development after a feedback.
  reworkLabel?: string;
  scenarios?: Map<number, Recorded[]>;
  // Each story's features (la-fabrique#206): a link to the card.
  cards?: StoryCards;
  // The project's cards by number, and whether the person may link a story
  // to the card it names (la-fabrique#218).
  cardTitles?: Map<number, string>;
  canLink?: boolean;
  repo?: string;
}

// The feedbacks from testing (la-fabrique#201): the last one of a
// criterion, failed while the story is back in development, to test again
// once its code changed.
function feedbackOf(story: Story, index: number, actions: CardActions): string {
  const feedback = [...(actions.checks.get(story.number)?.feedbacks ?? [])].reverse().find((candidate) => candidate.criterion === index);
  if (!feedback) return "";
  const rework = isRework(story, actions);
  return ` <span class="pill ${rework ? "alert" : "warn"} small">${rework ? "Failed" : "To test again"}</span>${
    feedback.url ? ` <a class="small" href="${escapeHtml(feedback.url)}">feedback</a>` : ""
  }`;
}

function isRework(story: Story, actions: CardActions): boolean {
  return story.labels.includes(actions.reworkLabel ?? "rework");
}

// The story's feedbacks, newest first.
function feedbackList(story: Story, actions: CardActions): string {
  const feedbacks = [...(actions.checks.get(story.number)?.feedbacks ?? [])].reverse();
  if (!feedbacks.length) return "";
  return `<details class="feedbacks"${isRework(story, actions) ? " open" : ""}><summary>${feedbacks.length} feedback${feedbacks.length === 1 ? "" : "s"} from testing</summary><ul>${feedbacks
    .map(
      (feedback) =>
        `<li><span class="mono small">${escapeHtml(feedback.at.slice(0, 16).replace("T", " "))}</span> @${escapeHtml(feedback.by)}${
          feedback.criterion !== null ? ` · criterion ${feedback.criterion + 1}${feedback.criterionText ? ` “${escapeHtml(feedback.criterionText)}”` : ""}` : ""
        }: ${escapeHtml(feedback.text)}${feedback.url ? ` <a href="${escapeHtml(feedback.url)}">On GitHub</a>` : ""}</li>`,
    )
    .join("")}</ul></details>`;
}

function criteriaList(story: Story, actions: CardActions): string {
  const criteria = story.criteria ?? [];
  if (!criteria.length) return `<p class="muted small">No acceptance criteria written: test what the title says, and ask for criteria.</p>`;
  return `<ul class="criteria">${criteria
    .map((criterion, index) => {
      const content = `<span class="box" aria-hidden="true">${criterion.done ? "✓" : ""}</span><span>${escapeHtml(criterion.text)}${
        criterion.done ? ` <span class="visually-hidden">(checked)</span>` : ""
      }</span>`;
      // Next to the criterion, never inside its button: a link in it.
      const failure = feedbackOf(story, index, actions);
      if (!actions.canValidate) return `<li class="${criterion.done ? "done" : ""}">${content}${failure}</li>`;
      return `<li class="${criterion.done ? "done" : ""}"><form method="post" action="${escapeHtml(actions.base)}/to-test/criterion" data-criterion>
          ${csrfField(actions.viewer)}
          <input type="hidden" name="issue" value="${story.number}" />
          <input type="hidden" name="index" value="${index}" />
          <input type="hidden" name="text" value="${escapeHtml(criterion.text)}" />
          <input type="hidden" name="done" value="${criterion.done ? "0" : "1"}" />
          <button type="submit" class="criterion" aria-pressed="${criterion.done}">${content}</button>
        </form>${failure}</li>`;
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
  const rework = isRework(story, actions);
  const ready = (story.criteria ?? []).every((criterion) => criterion.done) && !rework;
  return `${validated}
    ${defects.length ? `<ul class="defects">${defects.join("")}</ul>` : ""}
    <div class="test-actions">
      <form method="post" action="${escapeHtml(actions.base)}/to-test/validate" data-busy="Validating…">
        ${csrfField(actions.viewer)}
        <input type="hidden" name="issue" value="${story.number}" />
        <button type="submit" class="button${ready ? "" : " quiet"}"${ready ? "" : " disabled"} data-validate>${check?.validated ? "Validate again" : "Validate"}</button>
      </form>
      ${ready ? "" : `<span class="muted small">${rework ? "Back in development: its code takes the feedbacks into account first." : "Check every criterion to validate."}</span>`}
      <details class="defect-form">
        <summary class="button quiet">Report a defect</summary>
        <form method="post" action="${escapeHtml(actions.base)}/to-test/defect" data-busy="Opening the issue…">
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

// Where a story comes from: its feature, and its page in La Fabrique.
function storyOrigin(story: Story, actions: CardActions): string {
  if (!actions.base) return "";
  const cards = (actions.cards?.byStory.get(story.number) ?? []).map((id) => ({ id, title: actions.cards?.cards.get(id)?.title ?? "" }));
  const features = cards.map((card) => `<a class="mono" href="${escapeHtml(actions.base)}/cards/${card.id}">C${card.id}</a> ${escapeHtml(card.title)}`).join(", ");
  // The cards it names without being linked to them: proposed.
  const linked = new Set(cards.map((card) => card.id));
  const named = (story.mentions ?? []).filter((id) => !linked.has(id) && actions.cardTitles?.has(id));
  const proposals = named
    .map(
      (id) =>
        `<span class="muted">Names</span> <a class="mono" href="${escapeHtml(actions.base)}/cards/${id}">C${id}</a> ${escapeHtml(actions.cardTitles?.get(id) ?? "")}${
          actions.canLink ? ` ${linkNamedForm(actions.viewer, actions.repo ?? "", id, story.number, `${actions.base}/to-test#story-${story.number}`)}` : ""
        }`,
    )
    .join(" · ");
  return `<p class="test-origin small">${features ? `<span class="muted">Feature</span> ${features} · ` : ""}<a href="${escapeHtml(actions.base)}/sprint/stories/${story.number}">The story's steps</a></p>${
    proposals ? `<p class="test-origin small">${proposals}</p>` : ""
  }`;
}

function storyCard(story: Story, actions: CardActions): string {
  return `<article class="test-story" id="story-${story.number}">
      <h4><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</h4>
      ${storyOrigin(story, actions)}
      ${isRework(story, actions) ? `<p><span class="pill warn">Back in development</span> <span class="muted small">Feedbacks from testing: its code takes them into account, then it is tested again.</span></p>` : ""}
      ${criteriaList(story, actions)}
      ${feedbackList(story, actions)}
      ${validation(story, actions)}
      ${scenarioBlock(actions.viewer, actions.base, story.number, story.title, actions.scenarios?.get(story.number) ?? [], actions.canValidate, "to-test", story.scenarioPulls ?? [])}
    </article>`;
}

// The validated stories are folded away by default (la-fabrique#220):
// what is left to test comes first, the rest one tap away.
function withValidatedFolded(repo: string, stories: Story[], all: Map<number, Story>, actions: CardActions): { count: number; html: string } {
  const validated = stories.filter((story) => actions.checks.get(story.number)?.validated);
  const left = stories.filter((story) => !actions.checks.get(story.number)?.validated);
  const folded = validated.length
    ? `<details class="validated-stories"><summary>${validated.length} validated ${validated.length === 1 ? "story" : "stories"}, hidden</summary>${byEpic(repo, validated, all, actions)}</details>`
    : "";
  return {
    count: left.length,
    html: `${left.length ? byEpic(repo, left, all, actions) : `<p class="notice ok" role="status">Every story here is validated.</p>`}${folded}`,
  };
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
  const reworkLabel = reworkLabelOf(project.check?.config);
  const actions: CardActions = data.actions
    ? { ...data.actions, all, reworkLabel }
    : { viewer: { login: "", role: "tester", csrfToken: "" }, base: "", canValidate: false, checks: new Map(), all, reworkLabel };
  const readOnly: CardActions = { ...actions, canValidate: false };
  const failure = notice(data.failure, "error");

  if (!data.status) {
    const pending = (data.toValidate ?? []).filter((story) => !isEpic(story));
    const shown = withValidatedFolded(project.repo, pending, all, actions);
    const toValidate = pending.length
      ? `<p class="lede">No integration branch: the stories whose work is merged are online and checked there. Validated, a story stays open until the release that ships it.</p>
        <h2>Stories to validate <span class="muted mono">${shown.count}</span></h2>
        ${shown.html}`
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

  const shown = withValidatedFolded(project.repo, referred, all, actions);
  const validatedCount = referred.length - shown.count;
  if (status.aheadBy === 0) {
    return `${failure}<p class="notice ok" role="status">Nothing new to test: <code>${escapeHtml(status.integration)}</code> has nothing that <code>${escapeHtml(status.production)}</code> lacks.</p>`;
  }
  return `${failure}
    <div class="test-summary">
      <p><strong>${plural(shown.count, "story", "stories")} and ${plural(changes, "change")} to test</strong>${validatedCount ? ` (${validatedCount} already validated)` : ""} on <code>${escapeHtml(status.integration)}</code>${
        oldest ? `, waiting since <span class="mono">${formatDate(oldest)}</span>` : ""
      }${version ? `; it runs <span class="mono">${escapeHtml(version)}</span>` : ""}.</p>
      ${where}
    </div>
    <h2>Stories</h2>
    ${referred.length ? shown.html : `<p class="muted">The work waiting refers to no story; see the changes below.</p>`}
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
