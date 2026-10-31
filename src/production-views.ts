import type { NextRelease, ProductionStatus, ProductionView, WorkflowState } from "./production";
import type { Story } from "./stories";
import { notice, projectContext, projectHeader, type ProjectView } from "./project-views";
import type { Project } from "./projects";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";
import type { goSummary, LastGo } from "./go";
import { nextVersion } from "./next-release";
import type { StoryChecks } from "./validation";
import { projectUrl } from "./urls";

const WORKFLOW_LABELS: Record<string, string> = {
  ci: "CI",
  deploiement_int: "Deployment to int",
  migrations_production: "Production migrations",
  promouvoir: "Promotion (the go)",
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
    return `<p class="notice ok" role="status">Production is up to date: <code>${escapeHtml(status.integration)}</code> has nothing that <code>${escapeHtml(status.production)}</code> lacks. <strong>The go is blocked:</strong> there is nothing new to push.</p>`;
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

export interface GoPanel {
  canGo: boolean;
  declared: boolean;
  last: LastGo | null;
  summary: ReturnType<typeof goSummary> | null;
  checks: Map<number, StoryChecks>;
  notice?: string | undefined;
  failure?: string | undefined;
}

// Before the go: how the next release is numbered (minor by default).
function nextReleaseChoice(version: string | null): string {
  const minor = version ? nextVersion(version, "minor") : null;
  const major = version ? nextVersion(version, "major") : null;
  if (!version || !minor || !major) return "";
  return `<fieldset class="next-release"><legend>Next release after <span class="mono">${escapeHtml(version)}</span></legend>
          <label><input type="radio" name="next" value="minor" checked> Minor: <span class="mono">${escapeHtml(minor)}</span></label>
          <label><input type="radio" name="next" value="major"> Major: <span class="mono">${escapeHtml(major)}</span></label>
          <span class="muted small">Proposed on the integration branch as a pull request, with an empty release note.</span></fieldset>`;
}

// The go: what production will get, who validated it, and the button for
// a Product Engineer or super admin; the last go for everyone.
function goSection(viewer: Viewer, project: Project, status: ProductionStatus, go: GoPanel): string {
  const promotion = status.workflows.find((workflow) => workflow.key === "promouvoir");
  const last = go.last
    ? `<p class="small">Last go by @${escapeHtml(go.last.by)} on <span class="mono">${formatDate(go.last.at)}</span>${
        go.last.version ? ` for <span class="mono">${escapeHtml(go.last.version)}</span>` : ""
      }${go.last.reason ? `, anyway: “${escapeHtml(go.last.reason)}”` : ""}${
        promotion && promotion.status !== "none" ? ` · promotion ${runPill(promotion)}${promotion.url ? ` <a href="${escapeHtml(promotion.url)}">Logs</a>` : ""}` : ""
      }</p>`
    : "";
  const messages = `${notice(go.notice, "ok")}${notice(go.failure, "error")}`;
  if (!go.canGo) return last || messages ? `<section class="go">${messages}${last}</section>` : "";
  if (!go.declared) {
    return `<section class="go">${messages}${last}<p class="muted small">To give the go from here, the project declares its promotion workflow (<code>workflows.promouvoir</code>); <a href="${escapeHtml(
      projectUrl(project.repo),
    )}/setup">Setup</a> says how.</p></section>`;
  }
  if (status.aheadBy === 0 || !go.summary) return `<section class="go">${messages}${last}</section>`;
  if (!status.ready) {
    return `<section class="go">${messages}${last}<p class="muted"><strong>The go is blocked</strong> until production is ready (see above).</p></section>`;
  }
  const summary = go.summary;
  const storyLine = (story: Story) => {
    const validated = go.checks.get(story.number)?.validated;
    return `<li><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)} ${
      validated
        ? `<span class="pill ok">Validated</span> <span class="muted small">by @${escapeHtml(validated.by)}</span>`
        : `<span class="pill alert">Not validated</span>`
    }</li>`;
  };
  return `<section class="go">
      ${messages}
      ${last}
      <form method="post" action="${escapeHtml(projectUrl(project.repo))}/production/go" class="go-form">
        ${csrfField(viewer)}
        <h2>Give the go${summary.version ? ` for <span class="mono">${escapeHtml(summary.version)}</span>` : ""}</h2>
        ${summary.stories.length ? `<ul class="go-stories">${summary.stories.map(storyLine).join("")}</ul>` : `<p class="muted">No story is referred to by the work waiting.</p>`}
        ${
          summary.notValidated.length
            ? `<div class="notice error" role="alert"><p><strong>The go is blocked: ${summary.notValidated.length} stor${summary.notValidated.length === 1 ? "y is" : "ies are"} not validated on int.</strong></p><ul>${summary.notValidated
                .map((story) => `<li><a href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)}</li>`)
                .join("")}</ul></div>
               <label for="go-reason">${summary.notValidated.length} not validated on int: why give the go anyway?</label>
               <textarea id="go-reason" name="reason" rows="2" required maxlength="500"></textarea>`
            : ""
        }
        ${nextReleaseChoice(summary.version)}
        <p><button type="submit" class="button">${summary.notValidated.length ? "Give the go anyway" : "Give the go"}</button>
          <span class="muted small">Starts <code>${escapeHtml(String(project.check?.config?.workflows?.["promouvoir"] ?? ""))}</code> on the project; it is in the log.</span></p>
      </form>
    </section>`;
}

export function productionPage(viewer: Viewer, project: Project, view: ProductionView, go?: GoPanel): string {
  const name = project.check?.config?.nom || project.repo;
  const status = view.status;
  const ref = (project as Partial<ProjectView>).ref ?? null;
  const body = !project.check?.config?.branches?.integration && !ref
    ? `<p>This project does not declare an integration branch (<code>branches.integration</code> in <code>.fabrique.json</code>).</p>`
    : !status
      ? `<p class="muted">Nothing could be read yet.</p>`
      : `${banner(status)}
        ${view.fetchedAt ? `<p class="muted">Read from GitHub <span class="mono">${formatDate(view.fetchedAt)}</span>; pushes and workflow runs refresh it.</p>` : ""}
        ${go ? goSection(viewer, project, status, go) : ""}
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
