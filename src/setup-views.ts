import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { SetupItem, SetupKey, SetupState } from "./setup";
import { escapeHtml, layout, type Viewer } from "./views";

export const GUIDE_PATH = "/guide/fabrique-json";

const STATES: Record<SetupState, string> = {
  done: `<span class="pill ok">Done</span>`,
  missing: `<span class="pill alert">Missing</span>`,
  optional: `<span class="pill">Optional</span>`,
  unknown: `<span class="pill warn">Unknown</span>`,
};

function code(text: string): string {
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

function guide(anchor: string, text = "The format"): string {
  return `<a href="${GUIDE_PATH}#${anchor}">${text}</a>`;
}

// What each item is for, and how to set it up.
const HOW_TO: Record<SetupKey, { title: string; why: string; how: string }> = {
  config: {
    title: "A valid .fabrique.json",
    why: "The project describes itself to La Fabrique: branches, environments, workflows, documentation, request form.",
    how: `<p>Add <code>.fabrique.json</code> at the root of the repository, on the production branch. ${guide("champs", "Every field")}, and ${guide("exemple-lépicerie-extraordinaire", "a full example")}.</p>
      ${code(`{\n  "nom": "My project",\n  "description": "One line on what it is."\n}`)}`,
  },
  production: {
    title: "The production branch",
    why: "What is online; everything else is compared with it.",
    how: code(`"branches": { "production": "main" }`),
  },
  environments: {
    title: "Environments that tell their version",
    why: "Production shows the version each environment runs, read live.",
    how: `<p>Each environment answers a JSON <code>{"numero": "1.12"}</code> at its version path: the first entry of the release notes.</p>
      ${code(`"environnements": {\n  "production": { "url": "https://example.com", "version": "/api/version" }\n}`)}`,
  },
  ci: {
    title: "A CI workflow",
    why: "Its state is shown for each branch, and production waits for it.",
    how: `<p>A workflow in <code>.github/workflows/</code> that runs the tests on every push and pull request, then:</p>
      ${code(`"workflows": { "ci": "ci.yml" }`)}`,
  },
  release_notes: {
    title: "Release notes in the Fabrique format",
    why: "They feed Production (what will ship), the Roadmap calendar and Releases.",
    how: `<p>A JSON array, newest first; an entry without <code>heure</code> is not released yet. ${guide("notes-de-version-format-fabrique")}.</p>
      ${code(`"version": { "fichier": "docs/release-notes.json", "forme": "0.N" }`)}
      ${code(`[\n  {\n    "version": "0.2",\n    "date": "2026-10-30",\n    "heure": "10:05",\n    "titre": "Sign in",\n    "changements": ["Sign in with GitHub."],\n    "liens": null\n  }\n]`)}`,
  },
  documentation: {
    title: "Published documentation",
    why: "The project's own docs read inside La Fabrique, on any branch.",
    how: code(`"documentation": [\n  { "titre": "The project", "chemin": "CLAUDE.md" },\n  { "titre": "Guides", "chemin": "docs/" }\n]`),
  },
  requests: {
    title: "Request form and circuit labels",
    why: "Product Engineers write requests from the project's own sections; labels mark where each one stands.",
    how: code(
      `"demandes": {\n  "etiquettes": { "demande": "request", "prete": "ready-for-claude", "a_valider": "to-validate" },\n  "rubriques": [\n    { "cle": "need", "titre": "Need", "obligatoire": true, "aide": "What the person must be able to do." }\n  ]\n}`,
    ),
  },
  epics: {
    title: "Epics with sub-issues",
    why: "Stories group by epic, and the Roadmap draws each epic's progress.",
    how: `<p>Label the epic <code>epique</code> and attach each story to it as a <strong>sub-issue</strong> (GitHub: <em>Create sub-issue</em> or <em>Add existing issue</em> on the epic).</p>`,
  },
  working_branches: {
    title: "Work linked to its story",
    why: "The board shows each story's branches and pull requests, and Production the stories it will get.",
    how: `<p>Declare the patterns of working branches; put the issue number in the branch name (<code>feature/42-sign-in</code>), or close the issue from the pull request (<code>Closes #42</code>).</p>
      ${code(`"branches": { "travail": ["feature/*", "claude/*"] }`)}`,
  },
  cycle: {
    title: "Definition of Ready and priorities",
    why: "Optional. Each story's stage (Backlog, Ready, In development, On int, In production) depends on it, and the backlog is sorted by priority.",
    how: `<p>List the checks a story must pass to be <em>Ready</em> (<code>criteres</code>: acceptance criteria under an <em>Acceptance criteria</em> heading; <code>epique</code>: a sub-issue of an epic; <code>priorite</code>: a priority label; <code>etiquette_prete</code>: the circuit's ready label), and the priority labels, highest first. ${guide("cycle-dune-story", "The lifecycle")}.</p>
      ${code(`"cycle": {
  "pret": ["criteres", "epique", "priorite"],
  "priorites": ["P1", "P2", "P3"]
}`)}`,
  },
  integration: {
    title: "An integration branch and its environment",
    why: "Optional. Work is gathered and validated on int before the go; Production then shows exactly what int has that production lacks.",
    how: `<ol>
        <li>Create the branch (<code>integration</code>) from production; merge working branches into it instead of production.</li>
        <li>Add a workflow that deploys it to its own environment on every push (<code>deploy-int.yml</code>).</li>
        <li>At the go, date the release-notes entry on integration, then fast-forward production to it.</li>
        <li>Declare it:</li>
      </ol>
      ${code(`"branches": { "production": "main", "integration": "integration" },\n"environnements": {\n  "int": { "url": "https://int.example.com", "version": "/api/version" }\n},\n"workflows": { "deploiement_int": "deploy-int.yml" }`)}
      <p>Without it, choose a working branch as reference in the header: Production compares it with production.</p>`,
  },
};

function withCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function setupPage(viewer: Viewer, project: Project, data: { items: SetupItem[]; failure?: string | undefined }): string {
  const name = project.check?.config?.nom || project.repo;
  const count = (state: SetupState) => data.items.filter((entry) => entry.state === state).length;
  const required = data.items.filter((entry) => entry.key !== "integration" && entry.key !== "cycle");
  const done = required.filter((entry) => entry.state === "done").length;
  const items = data.items
    .map((entry) => {
      const help = HOW_TO[entry.key];
      return `<li class="setup-item setup-${entry.state}">
          <details${entry.state === "missing" ? " open" : ""}>
            <summary>${STATES[entry.state]} <strong>${escapeHtml(help.title)}</strong>
              <span class="setup-found">${withCode(entry.found)}</span></summary>
            <div class="setup-how">
              <p class="muted">${escapeHtml(help.why)}</p>
              ${help.how}
            </div>
          </details>
        </li>`;
    })
    .join("");
  return layout(
    `Setup · ${name} · La Fabrique extraordinaire`,
    `${projectHeader(project, "setup")}
      ${notice(data.failure, "error")}
      <p class="setup-count"><strong>${done} of ${required.length} done</strong>${
        count("missing") ? ` · ${count("missing")} missing` : ""
      }${count("unknown") ? ` · ${count("unknown")} unknown` : ""}${
        data.items.some((entry) => entry.key === "integration" && entry.state === "optional") ? " · integration optional" : ""
      }</p>
      <p class="muted">What La Fabrique needs to follow this project well, read from its files and GitHub. Open an item for how to do it; ${guide(
        "le-fichier-fabriquejson",
        "the .fabrique.json format",
      )} is the reference.</p>
      <ul class="setup-list">${items}</ul>`,
    viewer,
    [],
    projectContext(project),
  );
}

export function guidePage(viewer: Viewer, rendered: { html: string; title: string | null }): string {
  return layout(
    `${rendered.title ?? "The .fabrique.json format"} · La Fabrique extraordinaire`,
    `<article class="markdown">
${rendered.html}
      </article>`,
    viewer,
  );
}
