import type { NextRelease, ProductionStatus, ProductionView, WorkflowState } from "./production";
import type { Story } from "./stories";
import { notice, projectContext, projectHeader, type ProjectView } from "./project-views";
import type { Project } from "./projects";
import { escapeHtml, formatDate, layout, type Viewer } from "./views";

const WORKFLOW_LABELS: Record<string, string> = {
  ci: "CI",
  deploiement_int: "Deployment to int",
  migrations_production: "Production migrations",
};

function runPill(workflow: WorkflowState): string {
  switch (workflow.status) {
    case "success":
      return `<span class="pill ok">Passed</span>`;
    case "failure":
      return `<span class="pill alert">Failed</span>`;
    case "running":
      return `<span class="pill warn">Running</span>`;
    case "none":
      return `<span class="pill">Never run</span>`;
    default:
      return `<span class="pill warn">${escapeHtml(workflow.conclusion ?? "Other")}</span>`;
  }
}

function issueLink(repo: string, number: number, titles: Map<number, string>): string {
  const title = titles.get(number);
  return `<a href="https://github.com/${escapeHtml(repo)}/issues/${number}">#${number}</a>${title ? ` ${escapeHtml(title)}` : ""}`;
}

function banner(status: ProductionStatus): string {
  if (status.aheadBy === 0) {
    return `<p class="notice ok" role="status">Production is up to date: <code>${escapeHtml(status.integration)}</code> has nothing that <code>${escapeHtml(status.production)}</code> lacks.</p>`;
  }
  if (status.ready) {
    return `<p class="notice ok banner" role="status"><strong>Ready for production.</strong> CI and the deployment to int passed on the latest commit of <code>${escapeHtml(status.integration)}</code>.</p>`;
  }
  return `<div class="notice error banner" role="alert"><p><strong>Not ready for production.</strong></p><ul>${status.blockers
    .map((blocker) => `<li>${escapeHtml(blocker.text)}${blocker.url ? ` <a href="${escapeHtml(blocker.url)}">See the run</a>` : ""}</li>`)
    .join("")}</ul></div>`;
}

function versionsSection(status: ProductionStatus): string {
  const versions = status.versions
    .map(
      (version) =>
        `<li><a href="${escapeHtml(version.url)}">${escapeHtml(version.environment)}</a> <span class="mono">${
          version.version ? escapeHtml(version.version) : "unknown"
        }</span></li>`,
    )
    .join("");
  if (!versions) return "";
  return `<section>
      <h2>Versions</h2>
      <ul class="versions">${versions}</ul>
    </section>`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function waitingEntries(status: ProductionStatus): NextRelease[] {
  return status.waiting ?? (status.next ? [status.next] : []);
}

// The delta in product terms: the stories the pending work refers to, by
// epic, and every release-notes entry production does not have yet.
function waitingSection(repo: string, status: ProductionStatus, stories: Story[]): string {
  if (status.aheadBy === 0) return "";
  const byNumber = new Map(stories.map((story) => [story.number, story]));
  const referred = [...new Set(status.groups.flatMap((group) => group.issues))]
    .map((number) => byNumber.get(number))
    .filter((story): story is Story => Boolean(story) && (story?.subTotal ?? 0) === 0);
  const epics = new Map<number | null, Story[]>();
  for (const story of referred) {
    const epic = story.parent !== null && byNumber.has(story.parent) ? story.parent : null;
    epics.set(epic, [...(epics.get(epic) ?? []), story]);
  }
  const order = [...epics.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  const storyLink = (story: Story) =>
    `<li><a href="${escapeHtml(story.url || `https://github.com/${repo}/issues/${story.number}`)}">#${story.number}</a> ${escapeHtml(story.title)} ${
      story.state === "closed" ? `<span class="pill ok">Closed</span>` : `<span class="pill warn">Open</span>`
    }</li>`;
  const storiesHtml = referred.length
    ? order
        .map((epic) => {
          const head = epic === null ? "Without an epic" : `<a href="https://github.com/${escapeHtml(repo)}/issues/${epic}">#${epic}</a> ${escapeHtml(byNumber.get(epic)?.title ?? "")}`;
          return `<div class="waiting-epic"><h4>${head}</h4><ul class="waiting-stories">${(epics.get(epic) ?? [])
            .sort((a, b) => a.number - b.number)
            .map(storyLink)
            .join("")}</ul></div>`;
        })
        .join("")
    : `<p class="muted">The pending commits refer to no story.</p>`;

  const releases = waitingEntries(status);
  const changes = releases.reduce((total, release) => total + release.changes.length, 0);
  const releasesHtml = releases.length
    ? releases
        .map(
          (release) => `<div class="release">
            <p><span class="pill warn">Waiting</span> <span class="mono">${escapeHtml(release.version)}</span>${release.title ? ` · ${escapeHtml(release.title)}` : ""}</p>
            ${release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
          </div>`,
        )
        .join("")
    : `<p class="muted">No release-notes entry waiting.</p>`;

  return `<section class="waiting">
      <h2>What production will get</h2>
      <p class="waiting-count"><strong>${plural(referred.length, "story", "stories")}, ${plural(releases.length, "version")}, ${plural(changes, "change")}</strong> waiting.</p>
      <div class="waiting-columns">
        <div><h3>Stories</h3>${storiesHtml}</div>
        <div><h3>Features</h3>${releasesHtml}</div>
      </div>
    </section>`;
}

function workflowsSection(status: ProductionStatus): string {
  if (!status.workflows.length) return "";
  return `<section>
      <h2>Workflows</h2>
      <table>
        <thead><tr><th>Workflow</th><th>Branch</th><th>Last run</th><th>When</th></tr></thead>
        <tbody>${status.workflows
          .map(
            (workflow) => `<tr>
              <td>${escapeHtml(WORKFLOW_LABELS[workflow.key] ?? workflow.key)} <code>${escapeHtml(workflow.file)}</code></td>
              <td><code>${escapeHtml(workflow.branch)}</code></td>
              <td>${runPill(workflow)}${workflow.url ? ` <a href="${escapeHtml(workflow.url)}">Logs</a>` : ""}</td>
              <td class="mono muted">${workflow.at ? formatDate(workflow.at) : ""}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>
    </section>`;
}

function pendingSection(repo: string, status: ProductionStatus, titles: Map<number, string>): string {
  if (status.aheadBy === 0) return "";
  const groups = status.groups
    .map(
      (group) => `<article class="pending-group">
        <h3>${group.branch ? `Integration: <code>${escapeHtml(group.branch)}</code>` : escapeHtml(group.title)}</h3>
        <p class="muted">${group.mergedAt ? `Merged <span class="mono">${formatDate(group.mergedAt)}</span> · ` : ""}${group.commits.length} commit${group.commits.length > 1 ? "s" : ""}</p>
        ${group.issues.length ? `<p>${group.issues.map((number) => issueLink(repo, number, titles)).join("<br />")}</p>` : ""}
        <ul class="commits">${group.commits
          .map(
            (commit) =>
              `<li><a class="mono" href="${escapeHtml(commit.url)}">${escapeHtml(commit.sha.slice(0, 7))}</a> ${escapeHtml(commit.message.split("\n")[0] ?? "")} <span class="muted">${escapeHtml(commit.author ?? "")}</span></li>`,
          )
          .join("")}</ul>
      </article>`,
    )
    .join("");
  return `<section>
      <h2>${status.aheadBy} commit${status.aheadBy > 1 ? "s" : ""} on <code>${escapeHtml(status.integration)}</code> not in <code>${escapeHtml(status.production)}</code></h2>
      ${groups}
    </section>`;
}

export function productionPage(viewer: Viewer, project: Project, view: ProductionView): string {
  const name = project.check?.config?.nom || project.repo;
  const status = view.status;
  const ref = (project as Partial<ProjectView>).ref ?? null;
  const body = !project.check?.config?.branches?.integration && !ref
    ? `<p>This project does not declare an integration branch (<code>branches.integration</code> in <code>.fabrique.json</code>).</p>`
    : !status
      ? `<p class="muted">Nothing could be read yet.</p>`
      : `${banner(status)}
        ${view.fetchedAt ? `<p class="muted">Read from GitHub <span class="mono">${formatDate(view.fetchedAt)}</span>; pushes and workflow runs refresh it.</p>` : ""}
        ${waitingSection(project.repo, status, view.stories)}
        ${versionsSection(status)}
        ${workflowsSection(status)}
        ${pendingSection(project.repo, status, view.storyTitles)}`;
  return layout(
    `Production · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "production")}
      ${notice(view.failure, "error")}
      ${body}`,
    viewer,
    [],
    projectContext(project),
  );
}
