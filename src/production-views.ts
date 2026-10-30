import type { ProductionStatus, ProductionView, WorkflowState } from "./production";
import { notice, projectHeader } from "./project-views";
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
  const next = status.next
    ? `<div class="release">
        <p><span class="pill warn">Next</span> <span class="mono">${escapeHtml(status.next.version)}</span>${
          status.next.title ? ` · ${escapeHtml(status.next.title)}` : ""
        }</p>
        ${status.next.changes.length ? `<ul>${status.next.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}
      </div>`
    : "";
  if (!versions && !next) return "";
  return `<section>
      <h2>Versions</h2>
      ${versions ? `<ul class="versions">${versions}</ul>` : ""}
      ${next}
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
  const body = !project.check?.config?.branches?.integration
    ? `<p>This project does not declare an integration branch (<code>branches.integration</code> in <code>.fabrique.json</code>).</p>`
    : !status
      ? `<p class="muted">Nothing could be read yet.</p>`
      : `${banner(status)}
        ${view.fetchedAt ? `<p class="muted">Read from GitHub <span class="mono">${formatDate(view.fetchedAt)}</span>; pushes and workflow runs refresh it.</p>` : ""}
        ${versionsSection(status)}
        ${workflowsSection(status)}
        ${pendingSection(project.repo, status, view.storyTitles)}`;
  return layout(
    `Production · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "production")}
      ${notice(view.failure, "error")}
      ${body}`,
    viewer,
  );
}
