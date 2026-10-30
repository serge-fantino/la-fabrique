import type { InstalledRepo } from "./github-app";
import type { ConfigCheck, Project } from "./projects";
import { docUrl, githubBlobUrl, projectRefUrl, projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

const projectPath = projectUrl;

export type ProjectTab = "overview" | "stories" | "production" | "activity" | "requests";

const TABS: { id: ProjectTab; label: string; path: string }[] = [
  { id: "overview", label: "Overview", path: "" },
  { id: "stories", label: "Stories", path: "/stories" },
  { id: "production", label: "Production", path: "/production" },
  { id: "activity", label: "Activity", path: "/activity" },
  { id: "requests", label: "Requests", path: "/requests" },
];

export function projectHeader(project: Project, active: ProjectTab, heading?: string): string {
  const name = project.check?.config?.nom || project.repo;
  const tabs = TABS.map(
    (tab) =>
      `<a href="${escapeHtml(projectUrl(project.repo) + tab.path)}"${tab.id === active ? ' aria-current="page"' : ""}>${tab.label}</a>`,
  ).join("");
  return `<p class="eyebrow mono">${escapeHtml(project.repo)}</p>
      <h1>${escapeHtml(heading ?? name)}</h1>
      <nav class="tabs" aria-label="Project">${tabs}</nav>`;
}

function statusPill(check: ConfigCheck | null): string {
  if (!check) return `<span class="pill warn">Not checked</span>`;
  if (check.errors.length === 0) return `<span class="pill ok">Valid</span>`;
  const count = check.errors.length;
  return `<span class="pill alert">${count} problem${count > 1 ? "s" : ""}</span>`;
}

// Messages quote field names between backticks; they are escaped first.
function withCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function notice(text: string | undefined, tone: "ok" | "error"): string {
  return text ? `<p class="notice ${tone}" role="status">${escapeHtml(text)}</p>` : "";
}

export function projectsPage(viewer: Viewer, projects: Project[]): string {
  const isSuperAdmin = viewer.role === "super_admin";
  const rows = projects
    .map(
      (project) => `<tr>
          <td><a href="${escapeHtml(projectPath(project.repo))}">${escapeHtml(project.check?.config?.nom || project.repo)}</a></td>
          <td class="mono">${escapeHtml(project.repo)}</td>
          <td>${statusPill(project.check)}</td>
          <td class="mono muted">${project.check ? formatDate(project.check.checkedAt) : ""}</td>
        </tr>`,
    )
    .join("");

  const body = projects.length
    ? `<table>
        <thead><tr><th>Project</th><th>Repository</th><th>.fabrique.json</th><th>Checked</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p>No project yet.${isSuperAdmin ? " Install the GitHub App on a repository, then add it here." : ""}</p>`;

  return layout(
    "Projects · La Fabrique extraordinaire",
    `<div class="title-row">
        <h1>Projects</h1>
        ${isSuperAdmin ? `<a class="button" href="/projects/new">Add a project</a>` : ""}
      </div>
      ${body}`,
    viewer,
  );
}

const NEW_PROJECT_NOTICES: Record<string, string> = {
  invalid: "Choose a repository from the list.",
  not_installed: "The GitHub App is not installed on that repository.",
};

export function newProjectPage(
  viewer: Viewer,
  data: { repos: InstalledRepo[]; error?: string | undefined; notice?: string | undefined },
): string {
  const options = data.repos
    .map((repo) => `<option value="${escapeHtml(repo.repo)}">${escapeHtml(repo.repo)}</option>`)
    .join("");
  const form = data.repos.length
    ? `<form method="post" action="/projects" class="row">${csrfField(viewer)}
        <label>Repository
          <select name="repo">${options}</select>
        </label>
        <button type="submit" class="button">Add</button>
      </form>`
    : data.error
      ? ""
      : `<p>No repository left to add. Install the GitHub App on a repository first.</p>`;

  return layout(
    "Add a project · La Fabrique extraordinaire",
    `<h1>Add a project</h1>
      ${notice(data.error ?? (data.notice ? NEW_PROJECT_NOTICES[data.notice] : undefined), "error")}
      <p>A project is a repository where the GitHub App <em>La Fabrique extraordinaire</em> is installed.
        La Fabrique extraordinaire reads its <code>.fabrique.json</code> on the production branch.</p>
      ${form}`,
    viewer,
  );
}

const PROJECT_NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  added: { tone: "ok", text: "Project added." },
  added_unchecked: {
    tone: "error",
    text: "Project added, but its repository could not be read yet. Try “Check again”.",
  },
  checked: { tone: "ok", text: "File checked again." },
};

function fileSection(viewer: Viewer, project: Project, ref: string | null = null): string {
  const check = project.check;
  const recheck =
    viewer.role === "super_admin" && !ref
      ? `<form method="post" action="${escapeHtml(projectPath(project.repo))}/check" class="inline">${csrfField(viewer)}
          <button type="submit" class="button quiet">Check again</button>
        </form>`
      : "";
  const summary = check
    ? `<p>${statusPill(check)} Read from <code>${escapeHtml(check.branch)}</code> at
        <a class="mono" href="https://github.com/${escapeHtml(project.repo)}/blob/${escapeHtml(check.commitSha)}/.fabrique.json">${escapeHtml(check.commitSha.slice(0, 7))}</a>,
        checked <span class="mono">${formatDate(check.checkedAt)}</span>.</p>`
    : `<p>${statusPill(null)} The file has not been read yet.</p>`;
  const errors = check?.errors.length
    ? `<ul class="problems">${check.errors.map((error) => `<li>${withCode(error)}</li>`).join("")}</ul>`
    : "";
  return `<section>
      <h2><code>.fabrique.json</code></h2>
      ${summary}
      ${errors}
      ${recheck}
    </section>`;
}

function pageName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

function documentationSection(project: Project, ref: string | null = null): string {
  const entries = project.check?.config?.documentation ?? [];
  if (!entries.length) return "";
  const pages = project.check?.docPages ?? [];
  const link = (path: string, text: string) =>
    `<a href="${escapeHtml(docUrl(project.repo, path, ref))}">${escapeHtml(text)}</a>`;
  const items = entries.map((entry) => {
    if (!entry.chemin.endsWith("/")) return `<li>${link(entry.chemin, entry.titre)}</li>`;
    const inFolder = pages.filter((page) => page.startsWith(entry.chemin));
    return `<li>${escapeHtml(entry.titre)}
        <ul>${inFolder.map((page) => `<li>${link(page, pageName(page.slice(entry.chemin.length)))}</li>`).join("")}</ul>
      </li>`;
  });
  return `<section>
      <h2>Documentation</h2>
      <ul class="doc-list">${items.join("")}</ul>
    </section>`;
}

function declaredSection(project: Project): string {
  const config = project.check?.config;
  if (!config) return "";
  const rows: [string, string][] = [];
  const branches = config.branches;
  if (branches?.production) rows.push(["Production branch", `<code>${escapeHtml(branches.production)}</code>`]);
  if (branches?.integration) rows.push(["Integration branch", `<code>${escapeHtml(branches.integration)}</code>`]);
  if (config.workflows && Object.keys(config.workflows).length) {
    rows.push([
      "Workflows",
      Object.entries(config.workflows)
        .map(([key, file]) => `<span class="mono">${escapeHtml(key)}</span>: ${file ? `<code>${escapeHtml(file)}</code>` : `<span class="muted">none</span>`}`)
        .join("<br />"),
    ]);
  }
  if (config.demandes?.rubriques?.length) {
    rows.push(["Request form", `${config.demandes.rubriques.length} sections`]);
  }
  if (!rows.length) return "";
  return `<section>
      <h2>Declared in the file</h2>
      <dl class="facts">${rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>
    </section>`;
}

function branchNav(project: Project, choices: string[], current: string | null): string {
  if (choices.length < 2) return "";
  const production = choices[0];
  return `<nav class="branches" aria-label="Branch">
      <span class="muted">Branch</span>
      ${choices
        .map((branch) => {
          const ref = branch === production ? null : branch;
          const active = (current ?? production) === branch;
          return `<a href="${escapeHtml(projectRefUrl(project.repo, ref))}"${active ? ' aria-current="page"' : ""}><code>${escapeHtml(branch)}</code></a>`;
        })
        .join("")}
    </nav>`;
}

export function projectPage(
  viewer: Viewer,
  project: Project,
  options: {
    notice?: string | undefined;
    failure?: string | undefined;
    choices?: string[];
    ref?: string | null;
    branchCheck?: ConfigCheck | null;
  } = {},
): string {
  const ref = options.ref ?? null;
  const viewed: Project = ref ? { ...project, check: options.branchCheck ?? null } : project;
  const config = viewed.check?.config ?? project.check?.config;
  const known = options.notice ? PROJECT_NOTICES[options.notice] : undefined;
  const links = [
    `<a href="https://github.com/${escapeHtml(project.repo)}">GitHub</a>`,
    ...Object.entries(config?.environnements ?? {}).map(
      ([name, environment]) => `<a href="${escapeHtml(environment.url)}">${escapeHtml(name)}</a>`,
    ),
  ];

  return layout(
    `${config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "overview")}
      ${config?.description ? `<p class="lede">${escapeHtml(config.description)}</p>` : ""}
      <p class="links">${links.join("")}</p>
      ${known ? notice(known.text, known.tone) : ""}
      ${notice(options.failure, "error")}
      ${branchNav(project, options.choices ?? [], ref)}
      ${
        ref && viewed.check
          ? `<p class="notice ok" role="status">Showing branch <code>${escapeHtml(ref)}</code> at <span class="mono">${escapeHtml(
              viewed.check.commitSha.slice(0, 7),
            )}</span>. The project list, Production and the webhooks keep following <code>${escapeHtml(options.choices?.[0] ?? "")}</code>.</p>`
          : ""
      }
      ${documentationSection(viewed, ref)}
      ${fileSection(viewer, viewed, ref)}
      ${declaredSection(viewed)}`,
    viewer,
  );
}

export function docPage(
  viewer: Viewer,
  project: Project & { check: ConfigCheck },
  path: string,
  rendered: { html: string; title: string | null },
  ref: string | null = null,
): string {
  const { check } = project;
  const name = check.config?.nom || project.repo;
  const entry = (check.config?.documentation ?? []).find((candidate) =>
    candidate.chemin.endsWith("/") ? path.startsWith(candidate.chemin) : candidate.chemin === path,
  );
  const title = rendered.title ?? entry?.titre ?? pageName(path);
  const siblings =
    entry?.chemin.endsWith("/")
      ? (check.docPages ?? []).filter((page) => page.startsWith(entry.chemin) && page !== path)
      : [];
  const version = `<code>${escapeHtml(check.branch)}</code> at
      <a class="mono" href="https://github.com/${escapeHtml(project.repo)}/commit/${escapeHtml(check.commitSha)}">${escapeHtml(check.commitSha.slice(0, 7))}</a>${
        check.committedAt ? `, <span class="mono">${formatDate(check.committedAt)}</span>` : ""
      }`;

  return layout(
    `${title} · ${name} · La Fabrique extraordinaire`,
    `<p class="crumbs"><a href="${escapeHtml(projectRefUrl(project.repo, ref))}">${escapeHtml(name)}</a>${
      entry ? ` <span aria-hidden="true">›</span> ${escapeHtml(entry.titre)}` : ""
    }</p>
      <p class="doc-meta muted">${escapeHtml(path)} · ${version} ·
        <a href="${escapeHtml(githubBlobUrl(project.repo, check.commitSha, path))}">View on GitHub</a></p>
      <article class="markdown">
${rendered.html}
      </article>
      ${
        siblings.length
          ? `<nav class="doc-siblings" aria-label="${escapeHtml(entry?.titre ?? "Section")}">
        <h2>Also in ${escapeHtml(entry?.titre ?? "this section")}</h2>
        <ul>${siblings
          .map((page) => `<li><a href="${escapeHtml(docUrl(project.repo, page, ref))}">${escapeHtml(pageName(page.slice(entry?.chemin.length ?? 0)))}</a></li>`)
          .join("")}</ul>
      </nav>`
          : ""
      }`,
    viewer,
  );
}
