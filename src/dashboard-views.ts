import type { ProjectCard } from "./dashboard";
import { age } from "./in-dev-views";
import { escapeHtml, layout, type Viewer } from "./views";

export function cardHtml(card: ProjectCard, now = Date.now()): string {
  const { project } = card;
  const base = `/projects/${project.repo}`;
  const tiles = card.tiles
    .map(
      (tile) => `<a class="tile tile-link${tile.tone ? ` tone-${tile.tone}` : ""}" href="${escapeHtml(tile.path)}">
          <span class="tile-label">${escapeHtml(tile.label)}</span>
          <span class="tile-value mono">${escapeHtml(tile.value)}</span>
          ${tile.detail ? `<span class="tile-detail muted">${escapeHtml(tile.detail)}</span>` : ""}
        </a>`,
    )
    .join("");
  return `<section class="project-card">
      <div class="project-card-head">
        <h2><a href="${escapeHtml(base)}">${escapeHtml(project.check?.config?.nom || project.repo)}</a></h2>
        <span class="mono muted small">${escapeHtml(project.repo)}</span>
        <span class="muted small">${card.readAt ? `read ${age(card.readAt, now)}` : "not read yet"}</span>
      </div>
      <div class="tiles dashboard-tiles">${tiles}</div>
    </section>`;
}

// Cards read from snapshots at once; an old one is refreshed once shown.
export function dashboardPage(viewer: Viewer, cards: ProjectCard[]): string {
  const body = cards.length
    ? cards
        .map((card) =>
          card.stale
            ? `<div data-fragment="/projects/${escapeHtml(card.project.repo)}/card" aria-busy="true">${cardHtml(card)}</div>`
            : cardHtml(card),
        )
        .join("")
    : `<p>No project yet.${viewer.role === "super_admin" ? ` <a href="/projects/new">Add a project</a>.` : ""}</p>`;
  return layout(
    "Dashboard · La Fabrique extraordinaire",
    `<div class="title-row">
        <h1>Dashboard</h1>
        <a href="/projects">All projects</a>
      </div>
      ${body}`,
    viewer,
  );
}
