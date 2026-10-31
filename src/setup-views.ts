import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import type { SetupItem, SetupKey, SetupState } from "./setup";
import { READY_CHECKS, type ReadyCheck } from "./fabrique-config";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, layout, type Viewer } from "./views";

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
    why: "They feed Production (what will ship), the Roadmap calendar and Releases, and what a defect can be about.",
    how: `<p>A JSON array, newest first; an entry without <code>heure</code> is not released yet; <code>stories</code> lists the issues it brings (the only link between a version and its stories: require it in your version check). ${guide("notes-de-version-format-fabrique")}.</p>
      ${code(`"version": { "fichier": "docs/release-notes.json", "forme": "0.N" }`)}
      ${code(`[\n  {\n    "version": "0.2",\n    "date": "2026-10-30",\n    "heure": "10:05",\n    "titre": "Sign in",\n    "changements": ["Sign in with GitHub."],\n    "stories": [3],\n    "liens": null\n  }\n]`)}`,
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
    how: `<p>List the checks a story must pass to be <em>Ready</em> (<code>criteres</code>: acceptance criteria under an <em>Acceptance criteria</em> heading; <code>epique</code>: a sub-issue of an epic, or made from a card; <code>priorite</code>: a priority label; <code>etiquette_prete</code>: the circuit's ready label, set by <em>Mark ready</em> in the sprint), and the priority labels, highest first. Change them below, in <a href="#lifecycle">Story lifecycle</a>. ${guide("cycle-dune-story", "The lifecycle")}.</p>
      ${code(`"cycle": {
  "pret": ["criteres", "epique", "priorite"],
  "priorites": ["P1", "P2", "P3"]
}`)}`,
  },
  promotion: {
    title: "Promotion workflow (the go)",
    why: "Optional. The super admin gives the go from the Production tab; the project's own workflow promotes, with its own secrets.",
    how: `<p>A workflow on the production branch, started by <code>workflow_dispatch</code>, with inputs <code>version</code> (the release to ship) and <code>par</code> (who gave the go). It promotes integration to production in the project's own way; its push must use a token that triggers the project's CI and deployment (the <code>GITHUB_TOKEN</code> does not). <a href="/guide/exemples/promouvoir.yml">The épicerie's, as an example</a>.</p>
      ${code(`"workflows": { "promouvoir": "promouvoir.yml" }`)}`,
  },
  merge_workflow: {
    title: "Merge workflow",
    why: "Optional. Merge on a pull request of the sprint starts it: the release notes are numbered and dated at the merge, so pull requests written at the same time do not conflict on the next version.",
    how: `<p>A workflow on the production branch, started by <code>workflow_dispatch</code>, with inputs <code>pr</code> (the pull request) and <code>par</code> (who merges). It merges the base branch into the pull request, numbers and dates its release-notes entries after the newest, checks again and merges; its push must use a token that triggers the project's CI and deployment. Into the production branch, Merge is a go: the super admin only. La Fabrique's own: <code>.github/workflows/merge.yml</code> and <code>scripts/release-at-merge.ts</code> in its repository.</p>
      ${code(`"workflows": { "fusionner": "merge.yml" }`)}`,
  },
  claude_workflow: {
    title: "Claude workflow",
    why: "Optional. Tech leads and super admins launch Claude Code on a ready story, from the sprint (Launch the next story) or the Backlog; the project's own workflow runs it, with its own key.",
    how: `<ol>
        <li><strong>The workflow</strong>, in <code>.github/workflows/</code> on the production branch: started by <code>workflow_dispatch</code> with inputs <code>issue</code> (the story's number), <code>par</code> (who launched it) and <code>pr</code> (a pull request of the story to bring up to date: “Update with Claude” in the sprint). It runs Claude Code on the issue, on a working branch created <em>linked to the issue</em> (GitHub's Development section: La Fabrique finds the story's pull request by it), and opens a pull request that starts with <code>Refs #N</code> and says how each acceptance criterion is checked; with <code>pr</code>, it merges the base branch into that pull request's branch, resolves the conflicts and pushes to it. It never pushes to production. Two lines it needs: <code>run-name: "Claude #${'$'}{{ inputs.issue }}"</code> (La Fabrique finds each story's run by it) and, on the action, <code>allowed_bots: la-fabrique-extraordinaire</code> (the action refuses to be started by a bot it was not told about). Start from an example: <a href="/guide/exemples/claude.yml">the épicerie's</a> (pull request to <code>integration</code>), or La Fabrique's own <code>.github/workflows/claude.yml</code> (no integration branch: pull request to <code>main</code>).</li>
        <li><strong>Claude's key</strong>, a repository secret (Settings → Secrets and variables → Actions), one of the two:
          <ul>
            <li><code>CLAUDE_CODE_OAUTH_TOKEN</code>: a Claude subscription (Pro or Max); create it with <code>claude setup-token</code> in a terminal. The runs count in the subscription's usage.</li>
            <li><code>ANTHROPIC_API_KEY</code>: an API key from the Anthropic Console; the runs are billed to that account. Not La Fabrique's own key: the project's.</li>
          </ul>
          The workflow uses whichever is there.</li>
        <li><strong><code>FABRIQUE_TOKEN</code></strong>, another repository secret: a fine-grained personal access token (GitHub → Settings → Developer settings → Fine-grained tokens), on this repository only, with <em>Contents</em>, <em>Pull requests</em> and <em>Issues</em> in read and write. Claude pushes its branch and opens its pull request with it, so that the CI runs on them (the workflow's <code>GITHUB_TOKEN</code> would not start it).</li>
        <li><strong>Declare it</strong> in <code>.fabrique.json</code>; <code>claude.plafond</code> caps the runs at once (2 by default, 1 to 10):</li>
      </ol>
      ${code(`"workflows": { "claude": "claude.yml" },
"claude": { "plafond": 2 }`)}
      <p>A story is launched only once <em>Ready</em> (<a href="#lifecycle">Definition of Ready</a>). Without the secrets, the run stops at its first step and says which is missing.</p>`,
  },
  app: {
    title: "Connected app (defect reports)",
    why: "Optional. The project's own app reports a defect from the page where it shows up, in the name of the person using it; it never gets a GitHub token.",
    how: `<p>Open reporting on an environment with <code>signalement</code>, say where the app comes back with <code>application.retour</code>, then register the app and put its identifiers in the project: everything is in <a href="#connected-app">Connected app</a> below.</p>`,
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

// Items a project may leave out.
const OPTIONAL = new Set<SetupKey>(["integration", "cycle", "promotion", "merge_workflow", "claude_workflow", "app"]);

const CHECK_LABELS: Record<ReadyCheck, string> = {
  criteres: "Acceptance criteria written, under an Acceptance criteria heading",
  epique: "Attached to an epic (a sub-issue), or made from a card",
  priorite: "Has a priority label",
  etiquette_prete: "Carries the circuit's ready label (demandes.etiquettes.prete)",
};

export interface LifecycleForm {
  canEdit: boolean;
  cycle: { pret: ReadyCheck[]; priorites: string[] };
  declared: boolean;
  base: string;
  proposed?: { number: number; url: string; base: string } | undefined;
}

// The story lifecycle, changed from here as a pull request on the project.
function lifecycleSection(viewer: Viewer, project: Project, form: LifecycleForm): string {
  const proposed = form.proposed
    ? `<p class="notice ok" role="status">Pull request <a href="${escapeHtml(form.proposed.url)}">#${form.proposed.number}</a> opened on <code>${escapeHtml(form.proposed.base)}</code>: the lifecycle applies once it reaches production.</p>`
    : "";
  const checks = READY_CHECKS.map(
    (check) => `<label class="check"><input type="checkbox" name="pret" value="${check}"${form.cycle.pret.includes(check) ? " checked" : ""}${
      form.canEdit ? "" : " disabled"
    } /> ${escapeHtml(CHECK_LABELS[check])} <code>${check}</code></label>`,
  ).join("");
  return `<section class="lifecycle" id="lifecycle">
      <h2>Story lifecycle</h2>
      ${proposed}
      <p class="muted">A story is <em>Ready</em> when it passes the checks below; the priority labels sort the backlog, highest first. ${
        form.declared ? "Read from the project's <code>.fabrique.json</code>." : "Not declared yet: the defaults are shown."
      }</p>
      <form method="post" action="${escapeHtml(projectUrl(project.repo))}/setup" class="lifecycle-form">
        ${csrfField(viewer)}
        <fieldset>
          <legend>Definition of Ready</legend>
          ${checks}
        </fieldset>
        <label for="priorites">Priority labels, highest first, separated by commas</label>
        <input id="priorites" name="priorites" value="${escapeHtml(form.cycle.priorites.join(", "))}" placeholder="P1, P2, P3"${form.canEdit ? "" : " disabled"} />
        ${
          form.canEdit
            ? `<p><button type="submit" class="button">Propose the change</button></p>
               <p class="muted small">La Fabrique opens a pull request on <code>${escapeHtml(form.base)}</code> under your GitHub name, changing only <code>cycle</code> in <code>.fabrique.json</code>; the project reviews and merges it as usual.</p>`
            : `<p class="muted small">Super admins and tech leads change it.</p>`
        }
      </form>
    </section>`;
}

export function setupPage(
  viewer: Viewer,
  project: Project,
  data: { items: SetupItem[]; failure?: string | undefined; notice?: string | undefined; lifecycle: LifecycleForm; app?: string },
): string {
  const name = project.check?.config?.nom || project.repo;
  const count = (state: SetupState) => data.items.filter((entry) => entry.state === state).length;
  const required = data.items.filter((entry) => !OPTIONAL.has(entry.key));
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
      ${notice(data.notice, "ok")}
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
      <ul class="setup-list">${items}</ul>
      ${data.app ?? ""}
      ${lifecycleSection(viewer, project, data.lifecycle)}`,
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
