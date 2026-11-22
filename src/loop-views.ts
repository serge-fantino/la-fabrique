import { BREAK_LABELS, PHASE_LABELS, type LoopEvent } from "./loop-events";
import { escapeHtml } from "./views";

// The loop of a story on its page (ADR 0003, la-fabrique#424): each run's
// phases in order, with their numbers, and the break that stopped it.

function numbers(event: LoopEvent): string {
  const parts = [
    event.tests ? `tests ${event.tests.passed} passed${event.tests.failed ? `, ${event.tests.failed} failed` : ""}${event.tests.new ? `, ${event.tests.new} new` : ""}` : "",
    event.diff ? `${event.diff.files} file${event.diff.files === 1 ? "" : "s"}, ${event.diff.lines} lines` : "",
    event.findings ? `review: ${event.findings.blocking} blocking, ${event.findings.advice} advice` : "",
  ].filter(Boolean);
  return parts.length ? ` <span class="muted small">${escapeHtml(parts.join(" · "))}</span>` : "";
}

export function loopHtml(events: LoopEvent[]): string {
  if (!events.length) return "";
  const runs = new Map<number, LoopEvent[]>();
  for (const event of events) runs.set(event.runId, [...(runs.get(event.runId) ?? []), event]);
  const blocks = [...runs.entries()]
    .map(([run, list]) => {
      const items = list
        .map((event) => {
          const label = PHASE_LABELS[event.phase] ?? event.phase;
          const head = `<span class="mono small">${escapeHtml(event.at.slice(11, 16))}</span> <strong>${escapeHtml(label)}</strong>${event.iteration > 1 ? ` <span class="pill small">${event.iteration}</span>` : ""}`;
          const brk = event.phase === "break" && event.breakKind ? ` <span class="pill alert small">${escapeHtml(BREAK_LABELS[event.breakKind])}</span><br>${escapeHtml(event.breakReason ?? "")}` : "";
          return `<li class="loop-${escapeHtml(event.phase)}">${head}${numbers(event)}${brk}${event.summary ? `<br><span class="small">${escapeHtml(event.summary)}</span>` : ""}</li>`;
        })
        .join("");
      return `<h3 class="small">Run <span class="mono">${run}</span>, ${escapeHtml(list[0]?.at.slice(0, 10) ?? "")}</h3><ol class="loop">${items}</ol>`;
    })
    .join("");
  return `<h2>The loop</h2>${blocks}`;
}
