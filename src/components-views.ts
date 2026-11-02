import { NATURE_LABELS, NATURES, stackLabel, type ComponentEntry, type ComponentsView, type Nature } from "./components";
import { renderMarkdown } from "./markdown";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { githubBlobUrl, projectUrl } from "./urls";
import { escapeHtml, layout, type Viewer } from "./views";

// The Components tab (la-fabrique#197): what the project's components are,
// read in its repository; a component's page.

function treeUrl(repo: string, sha: string, path: string): string {
  return `https://github.com/${repo}/tree/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function naturePill(nature: Nature): string {
  return `<span class="pill kind small">${NATURE_LABELS[nature]}</span>`;
}

function origin(entry: ComponentEntry): string {
  const from = entry.meta?.origine;
  if (!from) return "";
  const label = `${from.depot.replace(/^https:\/\/(github\.com\/)?/, "")}${from.chemin ? `/${from.chemin}` : ""}${from.version ? ` @ ${from.version}` : ""}`;
  return `<span class="muted small">taken from <a href="${escapeHtml(from.depot)}">${escapeHtml(label)}</a>${from.commit ? ` <span class="mono">${escapeHtml(from.commit.slice(0, 7))}</span>` : ""}</span>`;
}

export interface ComponentFilters {
  nature: Nature | null;
  stack: string | null;
}

export function componentsPage(viewer: Viewer, project: Project, data: ComponentsView & { filters: ComponentFilters; failure?: string | undefined }): string {
  const name = project.check?.config?.nom || project.repo;
  const base = `${projectUrl(project.repo)}/components`;
  const valid = data.components.filter((entry) => entry.meta);
  const stacks = [...new Set(valid.flatMap((entry) => (entry.meta?.implementations ?? []).map((implementation) => stackLabel(implementation.stack))))].sort();
  const shown = data.components.filter((entry) => {
    if (data.filters.nature && entry.meta?.nature !== data.filters.nature) return false;
    if (data.filters.stack && !(entry.meta?.implementations ?? []).some((implementation) => stackLabel(implementation.stack) === data.filters.stack)) return false;
    return true;
  });
  const filters = valid.length
    ? `<form method="get" action="${escapeHtml(base)}" class="filters components-filters">
        <label>Nature <select name="nature" data-autosubmit>
          <option value="">All</option>
          ${NATURES.map((nature) => `<option value="${nature}"${data.filters.nature === nature ? " selected" : ""}>${NATURE_LABELS[nature]}</option>`).join("")}
        </select></label>
        <label>Stack <select name="stack" data-autosubmit>
          <option value="">All</option>
          ${stacks.map((stack) => `<option value="${escapeHtml(stack)}"${data.filters.stack === stack ? " selected" : ""}>${escapeHtml(stack)}</option>`).join("")}
        </select></label>
        <noscript><button type="submit" class="button quiet small">Filter</button></noscript>
      </form>`
    : "";
  const card = (entry: ComponentEntry) => {
    const url = `${base}/${encodeURIComponent(entry.id)}`;
    if (!entry.meta) {
      return `<li class="component-tile invalid">
          <p><a class="mono" href="${escapeHtml(url)}">${escapeHtml(entry.id)}</a> <span class="pill alert small">Invalid</span></p>
          <ul class="small">${entry.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>
        </li>`;
    }
    const meta = entry.meta;
    return `<li class="component-tile">
        <h3><a href="${escapeHtml(url)}">${escapeHtml(meta.nom)}</a></h3>
        <p class="component-tags">${naturePill(meta.nature)}${meta.version ? ` <span class="pill small mono">${escapeHtml(meta.version)}</span>` : ""} <span class="mono muted small">${escapeHtml(entry.id)}</span></p>
        ${meta.resume ? `<p>${escapeHtml(meta.resume)}</p>` : ""}
        ${meta.implementations.length ? `<p class="small">${meta.implementations.map((implementation) => `<span class="chip">${escapeHtml(stackLabel(implementation.stack))}</span>`).join(" ")}</p>` : `<p class="muted small">No implementation yet: a spec only.</p>`}
        ${meta.origine ? `<p>${origin(entry)}</p>` : ""}
      </li>`;
  };
  const body = !data.folder
    ? `<div class="empty-state">
        <p>This project declares no components yet. A component is a folder of the repository that describes itself (<code>component.json</code>, with its README, spec, scenarios and code), under the folder <code>.fabrique.json</code> declares:</p>
        <pre><code>"composants": { "dossier": "components" }</code></pre>
        <p><a href="/guide/fabrique-json#composants">The format of a component</a></p>
      </div>`
    : !data.components.length
      ? `<p class="muted">No component in <code>${escapeHtml(data.folder)}/</code> yet: each one is a folder with a <code>component.json</code>. <a href="/guide/fabrique-json#composants">The format</a></p>`
      : `${filters}<ul class="component-list">${shown.map(card).join("") || `<li class="muted">No component matches.</li>`}</ul>`;
  return layout(
    `Components · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "components")}
      ${notice(data.failure, "error")}
      <p class="lead">What this project is made of, that could serve elsewhere: each component is a folder of its repository${data.folder ? ` (<code>${escapeHtml(data.folder)}/</code>)` : ""} that says what it brings, what it asks of the project, its spec and its code. Shared between projects through git, with a link to its origin.</p>
      ${body}`,
    viewer,
    [],
    projectContext(project),
  );
}

export interface ComponentFiles {
  readme: string | null;
  spec: string | null;
  changelog: string | null;
  privacy: string | null;
  scenarios: { path: string; text: string }[];
}

export function componentPage(viewer: Viewer, project: Project, entry: ComponentEntry, sha: string, files: ComponentFiles): string {
  const name = project.check?.config?.nom || project.repo;
  const base = `${projectUrl(project.repo)}/components`;
  const meta = entry.meta;
  const markdown = (source: string | null, path: string | null) =>
    source && path
      ? `<article class="markdown">${
          renderMarkdown(source, {
            path,
            isPage: () => false,
            pageUrl: (candidate) => githubBlobUrl(project.repo, sha, candidate),
            githubUrl: (candidate) => githubBlobUrl(project.repo, sha, candidate),
          }).html
        }</article>`
      : "";
  const section = (id: string, title: string, inner: string) => (inner ? `<section class="component-section" id="${id}"><h2>${title}</h2>${inner}</section>` : "");
  const head = meta
    ? `<p class="component-tags">${naturePill(meta.nature)}${meta.version ? ` <span class="pill small mono">${escapeHtml(meta.version)}</span>` : ""} <span class="mono muted small">${escapeHtml(entry.id)}</span> ${origin(entry)}</p>
      ${meta.resume ? `<p class="lead">${escapeHtml(meta.resume)}</p>` : ""}`
    : `<p><span class="pill alert">Invalid</span></p><ul>${entry.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
  const contract = meta
    ? `<div class="component-contract">
        <div><h3>It brings</h3>${meta.apporte.length ? `<ul>${meta.apporte.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">Not said.</p>`}</div>
        <div><h3>It asks of the project</h3>${meta.demande.length ? `<ul>${meta.demande.map((item) => `<li><span class="chip">${escapeHtml(item.type)}</span> ${escapeHtml(item.description)}</li>`).join("")}</ul>` : `<p class="muted">Nothing.</p>`}</div>
        ${meta.dependances.length ? `<div><h3>It needs</h3><ul>${meta.dependances.map((id) => `<li><a class="mono" href="${escapeHtml(base)}/${encodeURIComponent(id)}">${escapeHtml(id)}</a></li>`).join("")}</ul></div>` : ""}
      </div>`
    : "";
  const implementations = meta?.implementations.length
    ? `<ul>${meta.implementations
        .map((implementation) => `<li><span class="chip">${escapeHtml(stackLabel(implementation.stack))}</span> <a class="mono" href="${escapeHtml(treeUrl(project.repo, sha, implementation.chemin))}">${escapeHtml(implementation.chemin)}</a></li>`)
        .join("")}</ul>`
    : meta
      ? `<p class="muted">No implementation yet: the spec and the scenarios are enough to write one for any stack.</p>`
      : "";
  const scenarios = files.scenarios.length
    ? files.scenarios
        .map((scenario) => `<h3 class="mono small"><a href="${escapeHtml(githubBlobUrl(project.repo, sha, scenario.path))}">${escapeHtml(scenario.path.slice(entry.folder.length + 1))}</a></h3><pre class="gherkin">${escapeHtml(scenario.text)}</pre>`)
        .join("")
    : "";
  return layout(
    `${meta?.nom ?? entry.id} · Components · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "components", meta?.nom ?? entry.id)}
      <p class="crumbs"><a href="${escapeHtml(base)}">Components</a> <span aria-hidden="true">›</span> ${escapeHtml(meta?.nom ?? entry.id)}</p>
      ${head}
      <p class="doc-meta muted"><a href="${escapeHtml(treeUrl(project.repo, sha, entry.folder))}">${escapeHtml(entry.folder)}/ on GitHub</a> · <span class="mono">${escapeHtml(sha.slice(0, 7))}</span></p>
      ${contract}
      ${section("implementations", "Implementations", implementations)}
      ${section("readme", "About", markdown(files.readme, entry.files.readme))}
      ${section("spec", "Spec", markdown(files.spec, entry.files.spec))}
      ${section("scenarios", "Scenarios", scenarios)}
      ${section("personal-data", "Personal data", markdown(files.privacy, meta?.donnees_personnelles ?? entry.files.privacy))}
      ${section("changelog", "Changelog", markdown(files.changelog, entry.files.changelog))}`,
    viewer,
    [],
    projectContext(project),
  );
}
