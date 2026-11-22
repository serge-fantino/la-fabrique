import { budgetHtml } from "./capabilities-views";
import { CAPABILITIES } from "./capabilities";
import { cardUrl } from "./card-views";
import type { AgentState, AgentsView, AgentTask } from "./agents";
import { RECENT_DAYS } from "./agents";
import { formatUsd } from "./llm";
import { BREAK_OWNERS, type OpenBreak } from "./loop-breaks";
import { BREAK_LABELS } from "./loop-events";
import { projectUrl } from "./urls";
import { escapeHtml, layout, type Viewer } from "./views";

// The Agents page (ADR 0004 § 2, epic F15, la-fabrique#422).

const STATE: Record<AgentState, { label: string; pill: string }> = {
  waiting: { label: "Waits its turn", pill: "small" },
  queued: { label: "Queued", pill: "small" },
  running: { label: "Running", pill: "warn" },
  decision: { label: "Waits for a decision", pill: "warn" },
  done: { label: "Done", pill: "ok" },
  failed: { label: "Failed", pill: "alert" },
  cancelled: { label: "Cancelled", pill: "small" },
};

export interface AgentFilters {
  project: string | null;
  capability: string | null;
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

// Where a proposal is decided.
function decideUrl(task: AgentTask): string {
  const card = task.card ? cardUrl(task.repo, task.card.id) : projectUrl(task.repo);
  if (task.capability === "stories") return `${card}/stories`;
  if (task.capability === "epic_features") return `${card}/features`;
  return `${card}#features`;
}

function subject(task: AgentTask): string {
  if (task.card) return `<a class="mono" href="${escapeHtml(cardUrl(task.repo, task.card.id))}">C${task.card.id}</a> ${escapeHtml(task.card.title)}`;
  const parts = [
    task.story ? `<a class="mono" href="https://github.com/${escapeHtml(task.repo)}/issues/${task.story}">#${task.story}</a>` : "",
    task.pull ? `<a class="mono" href="https://github.com/${escapeHtml(task.repo)}/pull/${task.pull}">PR #${task.pull}</a>` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function when(at: string | null): string {
  return at ? `<span class="mono small">${escapeHtml(at.slice(0, 16).replace("T", " "))}</span>` : "";
}

function row(task: AgentTask, columns: "active" | "decision" | "ended"): string {
  const state = STATE[task.state];
  const project = `<a href="${escapeHtml(projectUrl(task.repo))}">${escapeHtml(task.repo)}</a>`;
  const where = task.place === "fabrique" ? "La Fabrique" : "Runner";
  const cost =
    task.costMicros !== null
      ? `<span class="mono">${escapeHtml(formatUsd(task.costMicros))}</span>${task.place === "runner" ? ` <span class="muted small">at API rates${task.auth === "subscription" ? ", on the subscription" : task.auth === "api" ? ", paid on the API" : ""}</span>` : ""}`
      : task.place === "runner" && task.state !== "running" && task.state !== "queued"
        ? `<span class="muted small">No usage reported</span>`
        : "";
  const usage = task.tokens ? `<br><span class="small">${tokens(task.tokens.newIn)} new in, ${tokens(task.tokens.cacheRead)} from cache, ${tokens(task.tokens.out)} out</span>` : "";
  const link =
    columns === "decision"
      ? `<a class="button small" href="${escapeHtml(decideUrl(task))}">Decide</a>`
      : task.url
        ? `<a href="${escapeHtml(task.url)}">The run</a>${columns === "ended" ? ` · <a href="${escapeHtml(`${task.url}#artifacts`)}">transcript</a>` : ""}`
        : task.card
          ? `<a href="${escapeHtml(`${cardUrl(task.repo, task.card.id)}#claude-job`)}">The job</a>`
          : "";
  return `<tr>
      <td class="small">${project}</td>
      <td><strong>${escapeHtml(task.label)}</strong> <span class="muted small">${where}</span><br>${subject(task)}</td>
      <td><span class="pill ${state.pill} small">${state.label}</span>${task.phase ? ` <span class="small">${escapeHtml(task.phase)}</span>` : ""}${task.who ? `<br><span class="small">by @${escapeHtml(task.who)}</span>` : ""}</td>
      <td>${when(columns === "ended" ? task.ended : task.since)}</td>
      ${columns === "ended" ? `<td class="small">${cost}${usage}</td>` : ""}
      <td class="small">${link}</td>
    </tr>`;
}

function table(tasks: AgentTask[], columns: "active" | "decision" | "ended", empty: string): string {
  if (!tasks.length) return `<p class="muted">${empty}</p>`;
  const head =
    columns === "ended"
      ? "<th>Project</th><th>Task</th><th>Outcome</th><th>Ended</th><th>Cost</th><th></th>"
      : `<th>Project</th><th>Task</th><th>State</th><th>${columns === "decision" ? "Proposed" : "Since"}</th><th></th>`;
  return `<table class="table agents"><thead><tr>${head}</tr></thead><tbody>${tasks.map((task) => row(task, columns)).join("")}</tbody></table>`;
}

// The loop's stops waiting for a person (C186): what stopped Claude, who
// answers, and the story's page where they do.
function breaksTable(breaks: OpenBreak[]): string {
  if (!breaks.length) return `<p class="muted">No stop waits for a person.</p>`;
  return `<table class="table agents"><thead><tr><th>Project</th><th>Story</th><th>Why Claude stopped</th><th>Since</th><th>Who answers</th><th></th></tr></thead><tbody>${breaks
    .map((brk) => {
      const kind = brk.breakKind ?? "code";
      return `<tr>
      <td class="small"><a href="${escapeHtml(projectUrl(brk.repo))}">${escapeHtml(brk.repo)}</a></td>
      <td><a class="mono" href="https://github.com/${escapeHtml(brk.repo)}/issues/${brk.story}">#${brk.story}</a></td>
      <td><span class="pill alert small">${escapeHtml(BREAK_LABELS[kind])}</span><br><span class="small">${escapeHtml(brk.breakReason ?? "")}</span></td>
      <td>${when(brk.at)}</td>
      <td class="small">${escapeHtml(BREAK_OWNERS[kind].who)}</td>
      <td class="small"><a class="button small" href="${escapeHtml(`${projectUrl(brk.repo)}/sprint/stories/${brk.story}#stop`)}">Answer</a></td>
    </tr>`;
    })
    .join("")}</tbody></table>`;
}

export function agentsPage(viewer: Viewer, data: AgentsView, filters: AgentFilters): string {
  const keep = (task: AgentTask) => (!filters.project || task.repo.toLowerCase() === filters.project.toLowerCase()) && (!filters.capability || task.capability === filters.capability);
  const active = data.active.filter(keep);
  const decisions = data.decisions.filter(keep);
  const breaks = data.breaks.filter((brk) => (!filters.project || brk.repo.toLowerCase() === filters.project.toLowerCase()) && (!filters.capability || ["code", "rework", "update", "story_loop"].includes(filters.capability)));
  const ended = data.ended.filter(keep);
  const budgets = data.budgets.filter((entry) => !filters.project || entry.repo.toLowerCase() === filters.project.toLowerCase());
  const form = `<form method="get" action="/agents" class="filters agents-filters">
      <label>Project <select name="project" data-autosubmit>
        <option value="">All</option>
        ${data.repos.map((repo) => `<option value="${escapeHtml(repo)}"${filters.project?.toLowerCase() === repo.toLowerCase() ? " selected" : ""}>${escapeHtml(repo)}</option>`).join("")}
      </select></label>
      <label>Capability <select name="capability" data-autosubmit>
        <option value="">All</option>
        ${CAPABILITIES.filter((entry) => entry.place !== "person").map((entry) => `<option value="${escapeHtml(entry.id)}"${filters.capability === entry.id ? " selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}
      </select></label>
      <noscript><button type="submit" class="button quiet small">Filter</button></noscript>
    </form>`;
  const months = budgets.length
    ? `<ul class="agents-budgets">${budgets.map((entry) => `<li><a href="${escapeHtml(`${projectUrl(entry.repo)}/capabilities`)}">${escapeHtml(entry.name)}</a> ${budgetHtml(entry.budget)}</li>`).join("")}</ul>`
    : `<p class="muted">No project yet.</p>`;
  return layout(
    "Agents · La Fabrique extraordinaire",
    `<h1>Agents</h1>
      <p class="lead">What Claude does for every project, in La Fabrique and in the projects' runners: what runs or waits its turn, what waits for a person's decision, what ended these last ${RECENT_DAYS} days and what it cost. Each capability is described on a project's Capabilities tab.</p>
      ${form}
      <section id="active"><h2>Running and waiting <span class="muted small">(${active.length})</span></h2>${table(active, "active", "Nothing runs or waits its turn.")}</section>
      <section id="decisions"><h2>Waiting for a decision <span class="muted small">(${decisions.length})</span></h2>
        <p class="muted small">Claude's proposals are applied only once a person keeps them: a Product Engineer and above decides on stories, features and an epic's review.</p>
        ${table(decisions, "decision", "No proposal waits for a decision.")}</section>
      <section id="stops"><h2>Claude stopped, waiting for a person <span class="muted small">(${breaks.length})</span></h2>
        <p class="muted small">Each stop goes to the role that can unblock it: a decision or a doubt on the spec to a Product Engineer, tests, code or the review to a tech lead. Their answer goes on the issue, and Claude resumes with it.</p>
        ${breaksTable(breaks)}</section>
      <section id="ended"><h2>Ended these last ${RECENT_DAYS} days <span class="muted small">(${ended.length})</span></h2>${table(ended, "ended", "Nothing ended these last days.")}</section>
      <section id="months"><h2>This month, per project</h2>${months}</section>`,
    viewer,
  );
}
