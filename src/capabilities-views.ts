import type { RunnerUsage } from "./runner-runs";
import { ROLE_LABELS, type Role } from "./accounts";
import type { DecisionCounts } from "./agent-requests";
import { ENDING_LABELS, PLACE_LABELS, PLACES, type Capability, type Usage } from "./capabilities";
import { formatUsd } from "./llm";
import { projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { can } from "./rights";
import { escapeHtml, layout, type Viewer } from "./views";

// The Capabilities tab (ADR 0006, epic F15): what can be asked of an agent,
// or of a person, on this project; where it runs, how it ends, what it
// writes, who may launch it, and what it has cost here.

const ENDING_PILL: Record<Capability["ending"], string> = { decision: "warn", pose: "ok", report: "small", person: "card" };

// The lowest role that may launch it ("Product Engineer and above").
function who(capability: Capability): string {
  const ladder: Role[] = ["tester", "product_engineer", "tech_lead", "super_admin"];
  const lowest = ladder.find((role) => can(role, capability.right));
  if (!lowest) return "Nobody yet";
  if (capability.id === "decision") return "One of its deciders";
  return lowest === "super_admin" ? ROLE_LABELS.super_admin : `${ROLE_LABELS[lowest]} and above`;
}

function usageCell(capability: Capability, usage: Usage | undefined): string {
  if (capability.place === "fabrique") {
    if (!usage) return `<span class="muted">Not used yet</span>`;
    const average = usage.calls > usage.unpriced ? usage.costMicros / (usage.calls - usage.unpriced) : null;
    return `<span class="mono">${usage.calls}</span> call${usage.calls === 1 ? "" : "s"} · <span class="mono">${escapeHtml(formatUsd(usage.costMicros))}</span>${
      average !== null ? ` <span class="muted small">(${escapeHtml(formatUsd(Math.round(average)))} each)</span>` : ""
    }${usage.unpriced ? ` <span class="muted small">${usage.unpriced} unpriced</span>` : ""}${usage.last ? `<br><span class="muted small">last on ${escapeHtml(usage.last.slice(0, 10))}</span>` : ""}`;
  }
  return "";
}

export interface CapabilityRow {
  capability: Capability;
  available: { ok: boolean; reason: string };
  usage?: Usage;
  decisions?: DecisionCounts;
  runs?: RunnerUsage;
}

// Thousands of tokens, short: "12.3k", "1.2M".
function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

// The runs of a runner capability (ADR 0004 § 4): tokens, and what they
// would cost on the API, even on the subscription.
function runsCell(runs: RunnerUsage | undefined): string {
  if (!runs) return `<span class="muted">No run yet</span>`;
  const notCounted = runs.runs - runs.counted;
  return `<span class="mono">${runs.runs}</span> run${runs.runs === 1 ? "" : "s"}${
    runs.counted
      ? ` · <span class="mono">${escapeHtml(formatUsd(runs.apiCostMicros))}</span> <span class="muted small">at API rates</span><br><span class="small">${tokens(runs.input + runs.cacheWrite)} new in, ${tokens(runs.cacheRead)} read from cache, ${tokens(runs.output)} out</span>${
          runs.subscription ? `<br><span class="small">${runs.subscription === runs.counted ? "All" : runs.subscription} on the subscription${runs.realCostMicros ? `; paid on the API: <span class="mono">${escapeHtml(formatUsd(runs.realCostMicros))}</span>` : ""}</span>` : runs.realCostMicros ? `<br><span class="small">Paid on the API</span>` : ""
        }`
      : ""
  }${notCounted ? `<br><span class="muted small">${notCounted} without reported usage (an older workflow)</span>` : ""}${runs.last ? `<br><span class="muted small">last on ${escapeHtml(runs.last.slice(0, 10))}</span>` : ""}`;
}

// How its proposals were decided (ADR 0006 § 3).
function decisionsCell(counts: DecisionCounts | undefined): string {
  if (!counts) return "";
  const parts = [
    counts.kept ? `${counts.kept} kept` : "",
    counts.partly ? `${counts.partly} partly kept` : "",
    counts.rejected ? `${counts.rejected} rejected` : "",
    counts.waiting ? `${counts.waiting} waiting` : "",
  ].filter(Boolean);
  return parts.length ? `<br><span class="small">Proposals: ${parts.join(" · ")}</span>` : "";
}

export function capabilitiesPage(viewer: Viewer, project: Project, rows: CapabilityRow[]): string {
  const name = project.check?.config?.nom || project.repo;
  const section = (place: (typeof PLACES)[number]) => {
    const own = rows.filter((row) => row.capability.place === place);
    if (!own.length) return "";
    const body = own
      .map(({ capability, available, usage, decisions, runs }) => {
        const writes = [...capability.writes.answer.map((line) => ({ line, when: "" })), ...capability.writes.decision.map((line) => ({ line, when: "Once decided: " }))];
        return `<tr id="${escapeHtml(capability.id)}"${capability.planned ? ' class="planned"' : ""}>
          <td><strong>${escapeHtml(capability.label)}</strong> <span class="mono muted small">${escapeHtml(capability.id)}</span>
            <p class="small">${escapeHtml(capability.does)}</p>
            <p class="muted small">${escapeHtml(capability.from)}</p></td>
          <td><span class="pill ${ENDING_PILL[capability.ending]}">${ENDING_LABELS[capability.ending]}</span></td>
          <td class="small"><ul class="plain">${writes.map((entry) => `<li>${entry.when ? `<span class="muted">${entry.when}</span>` : ""}${escapeHtml(entry.line)}</li>`).join("") || "<li class=\"muted\">Nothing</li>"}</ul></td>
          <td class="small">${escapeHtml(who(capability))}</td>
          <td class="small">${available.ok ? `<span class="pill ok small">${escapeHtml(available.reason)}</span>` : `<span class="pill small">${escapeHtml(available.reason)}</span>`}<br>${capability.place === "runner" && !capability.planned ? runsCell(runs) : usageCell(capability, usage)}${decisionsCell(decisions)}</td>
        </tr>`;
      })
      .join("");
    return `<section class="capabilities-place">
        <h2>${escapeHtml(PLACE_LABELS[place])}</h2>
        <table class="table capabilities"><thead><tr><th>Capability</th><th>Ends</th><th>Writes</th><th>Who launches it</th><th>On this project</th></tr></thead>
        <tbody>${body}</tbody></table>
      </section>`;
  };
  return layout(
    `Capabilities · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "capabilities")}
      <p class="lead">Everything that can be asked of Claude, or of a person, on this project, in one place: where it runs, how it ends, what it writes, who may launch it, and what it has cost here. A request that waits for a decision is never applied before a person keeps it; what is written at once keeps its earlier state, to restore.</p>
      <p class="muted small">How a request ends: ${(["decision", "pose", "report", "person"] as const).map((ending) => `<span class="pill ${ENDING_PILL[ending]} small">${ENDING_LABELS[ending]}</span>`).join(" ")} · La Fabrique's ADR 0006</p>
      ${PLACES.map(section).join("")}`,
    viewer,
    [],
    projectContext(project),
  );
}

