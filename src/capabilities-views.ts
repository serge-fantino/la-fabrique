import { ROLE_LABELS, type Role } from "./accounts";
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
  if (capability.place === "runner") return `<span class="muted small">Counted from the agents' queue (epic F15)</span>`;
  return "";
}

export interface CapabilityRow {
  capability: Capability;
  available: { ok: boolean; reason: string };
  usage?: Usage;
}

export function capabilitiesPage(viewer: Viewer, project: Project, rows: CapabilityRow[]): string {
  const name = project.check?.config?.nom || project.repo;
  const section = (place: (typeof PLACES)[number]) => {
    const own = rows.filter((row) => row.capability.place === place);
    if (!own.length) return "";
    const body = own
      .map(({ capability, available, usage }) => {
        const writes = [...capability.writes.answer.map((line) => ({ line, when: "" })), ...capability.writes.decision.map((line) => ({ line, when: "Once decided: " }))];
        return `<tr id="${escapeHtml(capability.id)}"${capability.planned ? ' class="planned"' : ""}>
          <td><strong>${escapeHtml(capability.label)}</strong> <span class="mono muted small">${escapeHtml(capability.id)}</span>
            <p class="small">${escapeHtml(capability.does)}</p>
            <p class="muted small">${escapeHtml(capability.from)}</p></td>
          <td><span class="pill ${ENDING_PILL[capability.ending]}">${ENDING_LABELS[capability.ending]}</span></td>
          <td class="small"><ul class="plain">${writes.map((entry) => `<li>${entry.when ? `<span class="muted">${entry.when}</span>` : ""}${escapeHtml(entry.line)}</li>`).join("") || "<li class=\"muted\">Nothing</li>"}</ul></td>
          <td class="small">${escapeHtml(who(capability))}</td>
          <td class="small">${available.ok ? `<span class="pill ok small">${escapeHtml(available.reason)}</span>` : `<span class="pill small">${escapeHtml(available.reason)}</span>`}<br>${usageCell(capability, usage)}</td>
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

