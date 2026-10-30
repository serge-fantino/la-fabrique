import { isStalled, STALLED_DAYS, type InDevView, type WorkItem } from "./in-dev";
import { isEpic, type Stage } from "./lifecycle";
import { notice, progressive, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { Story } from "./stories";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const CI_PILLS: Record<string, string> = {
  success: `<span class="pill ok">CI passed</span>`,
  failure: `<span class="pill alert">CI failed</span>`,
  running: `<span class="pill warn">CI running</span>`,
  other: `<span class="pill">CI ended otherwise</span>`,
};

function workRow(item: WorkItem, now: number): string {
  const pull = item.pull
    ? `<a href="${escapeHtml(item.pull.url)}">PR #${item.pull.number}</a>${item.pull.draft ? ` <span class="pill warn">Draft</span>` : ""} <span class="muted small">opened ${age(item.pull.openedAt, now)}</span>`
    : `<span class="muted small">no pull request</span>`;
  const ci = item.ci ? `<a class="pill-link" href="${escapeHtml(item.ci.url)}">${CI_PILLS[item.ci.state]}</a>` : "";
  const commit = item.lastCommit
    ? `<a class="mono" href="${escapeHtml(item.lastCommit.url)}">${escapeHtml(item.lastCommit.sha.slice(0, 7))}</a> ${escapeHtml(item.lastCommit.message)} <span class="muted">· ${age(item.lastCommit.date, now)}${
        item.lastCommit.author ? ` · ${escapeHtml(item.lastCommit.author)}` : ""
      }</span>`
    : `<span class="muted">last commit unknown</span>`;
  return `<li class="work${isStalled(item, now) ? " stalled" : ""}">
      <p><code>${escapeHtml(item.branch)}</code> ${pull} ${ci}${isStalled(item, now) ? ` <span class="pill alert">Stalled</span>` : ""}</p>
      <p class="small">${commit}</p>
    </li>`;
}

export function inDevContent(
  view: InDevView,
  stories: Story[],
  stages: Map<number, Stage>,
  now = Date.now(),
): string {
  const failure = notice(view.failure, "error");
  if (!view.data) return `${failure}<p class="muted">Nothing could be read yet.</p>`;
  const byNumber = new Map(stories.map((story) => [story.number, story]));
  const known = (number: number) => {
    const story = byNumber.get(number);
    return story && !isEpic(story) ? story : null;
  };

  const itemsByStory = new Map<number, WorkItem[]>();
  const loose: WorkItem[] = [];
  for (const item of view.data.items) {
    const linked = item.stories.filter((number) => known(number));
    if (!linked.length) loose.push(item);
    for (const number of linked) itemsByStory.set(number, [...(itemsByStory.get(number) ?? []), item]);
  }
  // Stories in development by their stage, even when their branch was not read.
  for (const [number, stage] of stages) if (stage === "in_dev" && !itemsByStory.has(number)) itemsByStory.set(number, []);

  const latest = (items: WorkItem[]) => items.map((item) => item.lastCommit?.date ?? "").sort().at(-1) ?? "";
  const ordered = [...itemsByStory.entries()].sort((a, b) => latest(b[1]).localeCompare(latest(a[1])));
  const stalled = view.data.items.filter((item) => isStalled(item, now)).length;

  const cards = ordered
    .map(([number, items]) => {
      const story = known(number);
      if (!story) return "";
      const epic = story.parent !== null ? byNumber.get(story.parent) : undefined;
      return `<article class="dev-story">
          <h3><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</h3>
          ${epic ? `<p class="muted small">Epic <a href="${escapeHtml(epic.url)}">#${epic.number}</a> ${escapeHtml(epic.title)}</p>` : ""}
          ${items.length ? `<ul class="work-list">${items.map((item) => workRow(item, now)).join("")}</ul>` : `<p class="muted small">A pull request refers to it; no working branch was read.</p>`}
        </article>`;
    })
    .join("");

  return `${failure}
    <p class="test-summary"><span><strong>${ordered.length} stor${ordered.length === 1 ? "y" : "ies"} in development</strong> on ${view.data.items.length} branch${
      view.data.items.length === 1 ? "" : "es"
    }${stalled ? `; <strong>${stalled} stalled</strong> (no commit for ${STALLED_DAYS} days)` : ""}.</span>${
      view.fetchedAt ? ` <span class="muted small">Read from GitHub ${formatDate(view.fetchedAt)}.</span>` : ""
    }</p>
    ${cards || `<p class="muted">No story is being developed.</p>`}
    ${
      loose.length
        ? `<section><h2>Branches without a story</h2>
            <p class="muted small">Put the issue number in the branch name (<code>feature/42-…</code>) or write <code>Closes #42</code> in the pull request.</p>
            <ul class="work-list">${loose.map((item) => workRow(item, now)).join("")}</ul></section>`
        : ""
    }
    ${view.data.truncated ? `<p class="muted small">Only the first ${view.data.items.length} working branches are read.</p>` : ""}`;
}

export function inDevLoading(path: string): string {
  return progressive(`${path}?part=content`, `${path}?wait=1`, "Reading the working branches and pull requests…");
}

export function inDevPage(viewer: Viewer, project: Project, content: string): string {
  const name = project.check?.config?.nom || project.repo;
  return layout(
    `In development · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "in_dev")}
      ${content}`,
    viewer,
    [],
    projectContext(project),
  );
}
