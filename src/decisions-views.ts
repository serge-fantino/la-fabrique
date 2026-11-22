import { cardUrl } from "./card-views";
import { mentionedBy, STATUS_LABELS, STATUSES, type Decision, type DecisionStatus, type DecisionsView } from "./decisions";
import { renderMarkdown } from "./markdown";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { githubBlobUrl, projectUrl } from "./urls";
import { escapeHtml, layout, type Viewer } from "./views";

// The Decisions tab (epic F15): the project's ADRs, read in its repository,
// with their status, their deciders and what they serve; a decision's page.

const PILL: Record<DecisionStatus, string> = {
  proposed: "warn",
  accepted: "ok",
  rejected: "alert",
  superseded: "small",
  deprecated: "small",
  unknown: "small",
};

export function statusPill(decision: Pick<Decision, "status" | "statusText">): string {
  const title = decision.statusText && decision.statusText !== STATUS_LABELS[decision.status] ? ` title="${escapeHtml(decision.statusText)}"` : "";
  return `<span class="pill ${PILL[decision.status]}"${title}>${STATUS_LABELS[decision.status]}</span>`;
}

function decisionsBase(repo: string): string {
  return `${projectUrl(repo)}/decisions`;
}

export function decisionUrl(repo: string, number: string): string {
  return `${decisionsBase(repo)}/${encodeURIComponent(number)}`;
}

function serves(project: Project, decision: Decision): string {
  const issues = decision.issues.map((number) => `<a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${number}">#${number}</a>`);
  const cards = decision.cards.map((number) => `<a class="mono" href="${escapeHtml(cardUrl(project.repo, number))}">C${number}</a>`);
  return [...cards, ...issues].join(" ");
}

function deciders(decision: Decision): string {
  return decision.deciders.map((login) => `<a href="https://github.com/${encodeURIComponent(login)}">@${escapeHtml(login)}</a>`).join(", ");
}

export function decisionsPage(viewer: Viewer, project: Project, data: DecisionsView & { status: DecisionStatus | null; failure?: string | undefined }): string {
  const name = project.check?.config?.nom || project.repo;
  const base = decisionsBase(project.repo);
  const counts = new Map<DecisionStatus, number>();
  for (const decision of data.decisions) counts.set(decision.status, (counts.get(decision.status) ?? 0) + 1);
  const shown = data.decisions.filter((decision) => !data.status || decision.status === data.status).sort((a, b) => b.number.localeCompare(a.number));
  const statuses = [...STATUSES, "unknown" as const].filter((status) => counts.get(status));
  const filters = data.decisions.length
    ? `<form method="get" action="${escapeHtml(base)}" class="filters decisions-filters">
        <label>Status <select name="status" data-autosubmit>
          <option value="">All (${data.decisions.length})</option>
          ${statuses.map((status) => `<option value="${status}"${data.status === status ? " selected" : ""}>${STATUS_LABELS[status]} (${counts.get(status)})</option>`).join("")}
        </select></label>
        <noscript><button type="submit" class="button quiet small">Filter</button></noscript>
      </form>`
    : "";
  const proposed = counts.get("proposed") ?? 0;
  const waiting = proposed
    ? `<p class="notice">${proposed === 1 ? "One decision is proposed and waits" : `${proposed} decisions are proposed and wait`} for a decider: nothing proposed is taken until one of its deciders validates it. <a href="${escapeHtml(base)}?status=proposed">Show them</a></p>`
    : "";
  const rows = shown
    .map(
      (decision) => `<tr>
        <td class="mono"><a href="${escapeHtml(decisionUrl(project.repo, decision.number))}">${escapeHtml(decision.number)}</a></td>
        <td><a href="${escapeHtml(decisionUrl(project.repo, decision.number))}">${escapeHtml(decision.title)}</a></td>
        <td>${statusPill(decision)}</td>
        <td class="mono small">${escapeHtml(decision.date ?? "")}</td>
        <td class="small">${deciders(decision)}</td>
        <td class="small">${serves(project, decision)}</td>
      </tr>`,
    )
    .join("");
  const extra = [
    data.openDecisions ? `<a href="${escapeHtml(base)}/open">Open decisions</a>, not taken yet` : "",
    data.folder && data.sha ? `<a href="${escapeHtml(`https://github.com/${project.repo}/tree/${data.sha}/${data.folder}`)}">${escapeHtml(data.folder)}/ on GitHub</a>` : "",
  ].filter(Boolean);
  const body = !data.folder
    ? `<div class="empty-state">
        <p>This project has no decisions yet. A decision that would surprise the next reader is written down once, in its repository: one Markdown file per decision (an ADR), numbered, with its status and its deciders. La Fabrique finds them in <code>docs/adr/</code> or <code>docs/decisions/</code>, or in the folder <code>.fabrique.json</code> declares:</p>
        <pre><code>"decisions": { "dossier": "docs/decisions" }</code></pre>
        <p><a href="/guide/fabrique-json#décisions">The format of a decision</a></p>
      </div>`
    : !data.decisions.length
      ? `<p class="muted">No decision in <code>${escapeHtml(data.folder)}/</code> yet: each one is a file <code>NNNN-title.md</code>. <a href="/guide/fabrique-json#décisions">The format</a></p>`
      : `${waiting}${filters}
        <table class="table decisions"><thead><tr><th>ADR</th><th>Decision</th><th>Status</th><th>Date</th><th>Deciders</th><th>Serves</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="muted">No decision with this status.</td></tr>`}</tbody></table>`;
  return layout(
    `Decisions · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "decisions")}
      ${notice(data.failure, "error")}
      <p class="lead">The decisions taken on this project, and those waiting for someone to take them: one record each in its repository${data.folder ? ` (<code>${escapeHtml(data.folder)}/</code>${data.declared ? "" : ", found there"})` : ""}, with who decided, when, and what it serves.</p>
      ${extra.length ? `<p class="doc-meta muted">${extra.join(" · ")}</p>` : ""}
      ${body}`,
    viewer,
    [],
    projectContext(project),
  );
}

// A decision's page, or the open decisions file (decision null).
export function decisionPage(viewer: Viewer, project: Project, data: DecisionsView, decision: Decision | null, path: string, markdown: string): string {
  const name = project.check?.config?.nom || project.repo;
  const base = decisionsBase(project.repo);
  const sha = data.sha ?? "";
  const byPath = new Map(data.decisions.map((entry) => [entry.path, entry]));
  const rendered = renderMarkdown(markdown, {
    path,
    // A link to another decision of the folder stays in La Fabrique.
    isPage: (candidate) => byPath.has(candidate) || candidate === data.index || candidate === data.openDecisions,
    pageUrl: (candidate) => {
      if (candidate === data.index) return base;
      if (candidate === data.openDecisions) return `${base}/open`;
      const target = byPath.get(candidate);
      return target ? decisionUrl(project.repo, target.number) : base;
    },
    githubUrl: (candidate) => githubBlobUrl(project.repo, sha, candidate),
  }).html;
  const title = decision ? `${decision.number}. ${decision.title}` : "Open decisions";
  const related = decision ? mentionedBy(data.decisions, decision.number) : [];
  const names = decision ? decision.mentions.map((number) => data.decisions.find((entry) => entry.number === number)).filter((entry): entry is Decision => Boolean(entry)) : [];
  const list = (entries: Decision[]) =>
    `<ul>${entries.map((entry) => `<li><a href="${escapeHtml(decisionUrl(project.repo, entry.number))}"><span class="mono">${escapeHtml(entry.number)}</span> ${escapeHtml(entry.title)}</a> ${statusPill(entry)}</li>`).join("")}</ul>`;
  const facts = decision
    ? `<dl class="facts decision-facts">
        <dt>Status</dt><dd>${statusPill(decision)}${decision.statusText && decision.statusText !== STATUS_LABELS[decision.status] ? ` <span class="muted small">${escapeHtml(decision.statusText)}</span>` : ""}</dd>
        ${decision.date ? `<dt>Date</dt><dd class="mono">${escapeHtml(decision.date)}</dd>` : ""}
        <dt>Deciders</dt><dd>${deciders(decision) || `<span class="muted">Not said: nobody can validate it.</span>`}</dd>
        ${decision.issues.length || decision.cards.length ? `<dt>Serves</dt><dd>${serves(project, decision)}</dd>` : ""}
      </dl>`
    : "";
  return layout(
    `${title} · Decisions · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "decisions", decision ? `ADR ${decision.number}` : "Open decisions")}
      <p class="crumbs"><a href="${escapeHtml(base)}">Decisions</a> <span aria-hidden="true">›</span> ${escapeHtml(decision ? `ADR ${decision.number}` : "Open decisions")}</p>
      ${facts}
      ${decision?.status === "proposed" ? `<p class="notice">Proposed: not taken until one of its deciders validates it. A coding agent proposes a decision and never takes it.</p>` : ""}
      <p class="doc-meta muted"><a href="${escapeHtml(githubBlobUrl(project.repo, sha, path))}">${escapeHtml(path)} on GitHub</a> · <span class="mono">${escapeHtml(sha.slice(0, 7))}</span></p>
      <article class="markdown">${rendered}</article>
      ${names.length ? `<section class="decision-related"><h2>It names</h2>${list(names)}</section>` : ""}
      ${related.length ? `<section class="decision-related"><h2>Named by</h2>${list(related)}</section>` : ""}`,
    viewer,
    [],
    projectContext(project),
  );
}
