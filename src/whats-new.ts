import releaseNotes from "../docs/release-notes.json";
import { listProjects } from "./projects";
import { parseReleases, type Release } from "./roadmap";
import { releaseAnchor } from "./urls";
import { escapeHtml, layout, type Viewer } from "./views";

// La Fabrique's own release notes, newest first (the file the deployed
// Worker was built with).
export function ownReleases(): Release[] {
  return parseReleases(JSON.stringify(releaseNotes));
}

// La Fabrique's own repository, when it is a project here: the one whose
// `.fabrique.json` declares an environment at this address. Nothing about
// a repository is written in the code.
export async function selfRepo(db: D1Database, origin: string): Promise<string | null> {
  for (const project of await listProjects(db)) {
    const environments = Object.values(project.check?.config?.environnements ?? {});
    if (environments.some((environment) => sameOrigin(environment.url, origin))) return project.repo;
  }
  return null;
}

function sameOrigin(url: string | undefined, origin: string): boolean {
  try {
    return !!url && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function storyLinks(stories: number[] | null, repo: string | null): string {
  if (!stories?.length) return "";
  const items = stories.map((number) =>
    repo
      ? `<a class="mono" href="https://github.com/${escapeHtml(repo)}/issues/${number}">#${number}</a>`
      : `<span class="mono">#${number}</span>`,
  );
  return `<p class="muted small">${stories.length > 1 ? "Stories" : "Story"} ${items.join(", ")}</p>`;
}

function entry(release: Release, repo: string | null): string {
  const when = release.version === "next"
    ? `<span class="pill">Online</span> <span class="mono">${escapeHtml(release.date)}</span>`
    : release.upcoming
    ? `<span class="pill">Not released yet</span>`
    : `<span class="mono">${escapeHtml(release.date)}${release.time ? ` ${escapeHtml(release.time)}` : ""}</span>${release.time ? ` <span class="muted">(Paris)</span>` : ""}`;
  const changes = release.changes.length ? `<ul>${release.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : "";
  if (release.version === "next") {
    return `<article class="whats-new-entry">
      <h2>${escapeHtml(release.title ?? "Next release")}</h2>
      <p class="whats-new-when">${when}</p>
      ${changes}
      ${storyLinks(release.stories, repo)}
    </article>`;
  }
  return `<article class="whats-new-entry" id="${releaseAnchor(release.version)}">
      <h2><a class="mono" href="#${releaseAnchor(release.version)}">${escapeHtml(release.version)}</a>${release.title ? ` ${escapeHtml(release.title)}` : ""}</h2>
      <p class="whats-new-when">${when}</p>
      ${changes}
      ${storyLinks(release.stories, repo)}
    </article>`;
}

export function whatsNewPage(viewer: Viewer, releases: Release[], repo: string | null): string {
  // Merged and online, not released yet: the `next` entries, above the last release.
  const online = releases.filter((release) => release.version === "next");
  const released = releases.filter((release) => release.version !== "next");
  const body = `<h1>What's new</h1>
    <p class="lede">What changed in La Fabrique, version by version, newest first.</p>
    ${online.length ? `<section id="online"><h2 class="whats-new-group">Online, not released yet</h2>${online.map((release) => entry(release, repo)).join("")}</section>` : ""}
    ${released.length ? released.map((release) => entry(release, repo)).join("") : online.length ? "" : `<p class="muted">No release notes.</p>`}`;
  return layout("What's new · La Fabrique", body, viewer);
}
