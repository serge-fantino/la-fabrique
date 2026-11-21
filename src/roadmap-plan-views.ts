import type { Card } from "./cards";
import { cardRef, cardUrl, statusPill } from "./card-views";
import { HORIZONS, LATER, planLabel, SPRINT_NEXT, SPRINT_NOW, type EpicNode, type PlanColumn } from "./roadmap-plan";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, type Viewer } from "./views";

// The Roadmap: the sprints to come, then the dependency tree of the epics
// and their features.

const COLUMN_NOTES: Record<string, string> = {
  [SPRINT_NOW]: "Running now.",
  [SPRINT_NEXT]: "What the next sprint takes, refined on the Refinement page.",
};

function planChoice(viewer: Viewer, action: string, card: Card, current: number, manual: boolean): string {
  const options = [
    `<option value="next">Next release</option>`,
    ...Array.from({ length: HORIZONS }, (_, i) => i + 2).map((offset) => `<option value="${offset}"${manual && offset === current ? " selected" : ""}>${planLabel(offset)}</option>`),
    `<option value="auto"${manual ? "" : " selected"}>Proposed: ${escapeHtml(planLabel(current))}</option>`,
  ];
  return `<form method="post" action="${escapeHtml(action)}" class="plan-move">${csrfField(viewer)}
      <input type="hidden" name="action" value="plan" />
      <input type="hidden" name="card" value="${card.id}" />
      <label class="visually-hidden" for="plan-${card.id}">Plan ${cardRef(card.id)} in</label>
      <select id="plan-${card.id}" name="sprint" data-autosubmit>${options.join("")}</select>
      <noscript><button type="submit" class="button quiet small">Plan</button></noscript>
    </form>`;
}

function planCard(viewer: Viewer, repo: string, action: string, column: PlanColumn, one: PlanColumn["cards"][number], canWrite: boolean): string {
  const { card } = one;
  const future = column.offset > SPRINT_NEXT || one.toMove;
  const notes = [
    one.after.length ? `<span class="muted small">After ${one.after.map((id) => `<a class="mono" href="#plan-c${id}">${cardRef(id)}</a>`).join(", ")}</span>` : "",
    one.late.length ? `<span class="pill alert small" title="It depends on ${one.late.map(cardRef).join(", ")}, planned later">Before ${one.late.map(cardRef).join(", ")}</span>` : "",
  ].filter(Boolean);
  const move = one.toMove && canWrite
    ? `<form method="post" action="${escapeHtml(action)}" class="inline">${csrfField(viewer)}<input type="hidden" name="action" value="plan" /><input type="hidden" name="card" value="${card.id}" /><input type="hidden" name="sprint" value="next" /><button type="submit" class="button small">Move into Next release</button></form>`
    : "";
  return `<li class="plan-card${one.manual ? " manual" : future ? " proposed" : ""}" id="plan-c${card.id}">
      <div class="plan-card-top">
        <a class="mono" href="${escapeHtml(cardUrl(repo, card.id))}">${cardRef(card.id)}</a>
        ${statusPill(card)}
        ${card.priority ? `<span class="pill small">${escapeHtml(card.priority)}</span>` : ""}
        ${future ? (one.manual ? `<span class="pill kind small" title="Placed by hand">Planned</span>` : `<span class="pill small plan-proposed" title="Proposed from the priorities, the board's order and the dependencies">Proposed</span>`) : ""}
      </div>
      <a class="plan-title" href="${escapeHtml(cardUrl(repo, card.id))}">${escapeHtml(card.title)}</a>
      ${card.epic ? `<span class="tag"><span class="tag-dim">Epic</span> ${escapeHtml(card.epic)}</span>` : ""}
      ${notes.length ? `<p class="plan-notes">${notes.join(" ")}</p>` : ""}
      ${move}
      ${canWrite && future && !one.toMove ? planChoice(viewer, action, card, column.offset, one.manual) : ""}
    </li>`;
}

export function planSection(viewer: Viewer, project: { repo: string }, columns: PlanColumn[], capacity: number, canWrite: boolean, kept: number): string {
  const base = projectUrl(project.repo);
  const action = `${base}/roadmap`;
  const proposed = columns.filter((column) => column.offset > SPRINT_NEXT).flatMap((column) => column.cards.filter((one) => !one.manual)).length;
  const manual = columns.flatMap((column) => column.cards.filter((one) => one.manual)).length;
  const body = columns
    .map(
      (column) => `<section class="plan-column${column.offset === SPRINT_NOW ? " now" : column.offset === SPRINT_NEXT ? " next" : ""}" aria-label="${escapeHtml(column.label)}">
        <h3>${column.offset === SPRINT_NOW ? `<a href="${escapeHtml(base)}/sprint">${column.label}</a>` : column.offset === SPRINT_NEXT ? `<a href="${escapeHtml(base)}/refinement">${column.label}</a>` : escapeHtml(column.label)}
          <span class="mono muted small">${column.cards.length}${column.offset > SPRINT_NEXT && Number.isFinite(column.offset) ? `/${capacity}` : ""}</span></h3>
        ${COLUMN_NOTES[String(column.offset)] ? `<p class="muted small">${COLUMN_NOTES[String(column.offset)]}</p>` : column.offset === LATER ? `<p class="muted small">Beyond ${HORIZONS} sprints.</p>` : ""}
        ${column.cards.length ? `<ul class="plan-cards">${column.cards.map((one) => planCard(viewer, project.repo, action, column, one, canWrite)).join("")}</ul>` : `<p class="muted small">Nothing yet.</p>`}
      </section>`,
    )
    .join("");
  return `<section class="roadmap-plan" id="plan">
      <h2>Sprints to come</h2>
      <p class="muted">The sprint running, Next release, then the features not placed yet, proposed sprint by sprint: by priority, then the board's order, each one after what it depends on. Change a feature's sprint to plan it by hand; <em>Keep the proposal</em> plans them all as shown. Nothing moves into Next release by itself.</p>
      ${kept ? `<p class="notice ok" role="status">${kept} feature${kept === 1 ? "" : "s"} planned as proposed.</p>` : ""}
      <div class="plan-tools">
        <form method="get" action="${escapeHtml(action)}" class="plan-capacity">
          <label>Features per sprint <input type="number" name="per" min="1" max="12" value="${capacity}" /></label>
          <button type="submit" class="button quiet">Propose</button>
        </form>
        ${
          canWrite
            ? `${proposed ? `<form method="post" action="${escapeHtml(action)}" class="inline">${csrfField(viewer)}<input type="hidden" name="action" value="plan_keep" /><input type="hidden" name="per" value="${capacity}" /><button type="submit" class="button">Keep the proposal</button></form>` : ""}
               ${manual ? `<form method="post" action="${escapeHtml(action)}" class="inline">${csrfField(viewer)}<input type="hidden" name="action" value="plan_clear" /><input type="hidden" name="per" value="${capacity}" /><button type="submit" class="button quiet">Clear the plan</button></form>` : ""}`
            : ""
        }
      </div>
      <div class="plan-scroll"><div class="plan-columns">${body}</div></div>
    </section>`;
}

// ---- The dependency tree -------------------------------------------------

const NODE_W = 230;
const NODE_H = 58;
const GAP_X = 76;
const GAP_Y = 18;

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function epicGraph(repo: string, nodes: EpicNode[]): string {
  if (!nodes.length) return `<p class="muted">No epic yet: an epic card groups features; its dependencies come from theirs.</p>`;
  const levels = Math.max(...nodes.map((node) => node.level)) + 1;
  const rows: EpicNode[][] = Array.from({ length: levels }, (_, level) => nodes.filter((node) => node.level === level));
  const place = new Map<number, { x: number; y: number }>();
  rows.forEach((row, level) => row.forEach((node, index) => place.set(node.epic.id, { x: 8 + level * (NODE_W + GAP_X), y: 8 + index * (NODE_H + GAP_Y) })));
  const width = 16 + levels * NODE_W + (levels - 1) * GAP_X;
  const height = 16 + Math.max(...rows.map((row) => row.length)) * (NODE_H + GAP_Y) - GAP_Y;
  const edges = nodes
    .flatMap((node) =>
      node.dependsOn.flatMap((from) => {
        const a = place.get(from);
        const b = place.get(node.epic.id);
        if (!a || !b) return [];
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const bend = Math.max(30, Math.abs(x2 - x1) / 2);
        return [`<path class="graph-edge" d="M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 4} ${y2}" marker-end="url(#graph-arrow)" />`];
      }),
    )
    .join("");
  const boxes = nodes
    .map((node) => {
      const at = place.get(node.epic.id)!;
      const done = node.features ? node.inProduction / node.features : 0;
      const label = `${cardRef(node.epic.id)} ${node.epic.title}: ${node.inProduction} of ${node.features} features in production${node.dependsOn.length ? `; after ${node.dependsOn.map((id) => nodes.find((other) => other.epic.id === id)?.epic.title ?? cardRef(id)).join(", ")}` : ""}`;
      return `<a href="${escapeHtml(cardUrl(repo, node.epic.id))}" class="graph-node${node.features && node.inProduction === node.features ? " done" : ""}">
          <title>${escapeHtml(label)}</title>
          <rect x="${at.x}" y="${at.y}" width="${NODE_W}" height="${NODE_H}" rx="14" />
          <text x="${at.x + 14}" y="${at.y + 23}" class="graph-title">${escapeHtml(short(node.epic.title, 27))}</text>
          <text x="${at.x + 14}" y="${at.y + 42}" class="graph-sub">${cardRef(node.epic.id)} · ${node.inProduction}/${node.features} in production</text>
          <rect x="${at.x + 14}" y="${at.y + NODE_H - 8}" width="${NODE_W - 28}" height="3" rx="1.5" class="graph-track" />
          <rect x="${at.x + 14}" y="${at.y + NODE_H - 8}" width="${Math.round((NODE_W - 28) * done)}" height="3" rx="1.5" class="graph-done" />
        </a>`;
    })
    .join("");
  return `<div class="graph-scroll"><svg class="epic-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="The epics, left to right in the order their dependencies ask for">
      <defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" /></marker></defs>
      ${edges}${boxes}
    </svg></div>`;
}

export interface TreeGroup {
  epic: Card | null;
  // Features to do by wave, then those done.
  waves: { wave: number; cards: { card: Card; after: number[] }[] }[];
  done: Card[];
}

export function dependencyTree(repo: string, groups: TreeGroup[]): string {
  if (!groups.length) return "";
  return groups
    .map((group) => {
      const todo = group.waves.reduce((total, wave) => total + wave.cards.length, 0);
      const title = group.epic
        ? `<a class="mono" href="${escapeHtml(cardUrl(repo, group.epic.id))}">${cardRef(group.epic.id)}</a> ${escapeHtml(group.epic.title)}`
        : "No epic";
      const waves = group.waves
        .map(
          (wave) => `<li class="tree-wave"><span class="tree-wave-label mono small">${wave.wave === 1 ? "Can start" : `Wave ${wave.wave}`}</span><ul>${wave.cards
            .map(
              ({ card, after }) =>
                `<li><a class="mono" href="${escapeHtml(cardUrl(repo, card.id))}">${cardRef(card.id)}</a> ${escapeHtml(card.title)} ${statusPill(card)}${
                  after.length ? ` <span class="muted small">after ${after.map(cardRef).join(", ")}</span>` : ""
                }</li>`,
            )
            .join("")}</ul></li>`,
        )
        .join("");
      return `<details class="tree-group"${todo ? " open" : ""}>
          <summary>${title} <span class="muted small">${todo} to do${group.done.length ? `, ${group.done.length} in production` : ""}</span></summary>
          ${waves ? `<ol class="tree-waves">${waves}</ol>` : ""}
          ${group.done.length ? `<p class="muted small">In production: ${group.done.map((card) => `<a class="mono" href="${escapeHtml(cardUrl(repo, card.id))}" title="${escapeHtml(card.title)}">${cardRef(card.id)}</a>`).join(", ")}</p>` : ""}
        </details>`;
    })
    .join("");
}
