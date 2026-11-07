import { listProjects, type Project } from "./projects";
import { escapeHtml, layout, type Viewer } from "./views";

// Onboarding guides, one per profile (la-fabrique#264). Open without an
// account: the signed-out home page and the menu link here. Signed in, the
// links open the person's project; signed out, they go through sign-in.
export const HELP_PATH = "/help";
export const HELP_ROUTE = /^\/help(?:\/(product-engineer|tester|tech-lead|super-admin))?$/;

interface Guide {
  slug: string;
  title: string;
  summary: string;
  ready: boolean;
}

const GUIDES: Guide[] = [
  {
    slug: "product-engineer",
    title: "Product Engineer",
    summary: "Write the need, shape it with Claude, decide what goes into the release, validate it, give the go.",
    ready: true,
  },
  {
    slug: "tester",
    title: "Tester",
    summary: "Check the stories on the test environment, tick their criteria, report what fails.",
    ready: false,
  },
  {
    slug: "tech-lead",
    title: "Tech lead",
    summary: "Review requests and pull requests, launch Claude Code, follow the CI.",
    ready: false,
  },
  {
    slug: "super-admin",
    title: "Super admin",
    summary: "Projects, roles, connected apps, and the go.",
    ready: false,
  },
];

// Where a link into the app leads: the chosen project's page, the list of
// projects when there is none, sign-in first when signed out.
interface Links {
  project: Project | null;
  signedIn: boolean;
}

function appUrl(links: Links, path: string): string {
  if (!links.signedIn) return `/auth/login?next=${encodeURIComponent(links.project ? `/projects/${links.project.repo}${path}` : "/projects")}`;
  return links.project ? `/projects/${links.project.repo}${path}` : "/projects";
}

function to(links: Links, path: string, label: string): string {
  return `<a class="help-app" href="${escapeHtml(appUrl(links, path))}">${label}</a>`;
}

function projectName(project: Project): string {
  return project.check?.config?.nom || project.repo;
}

export async function showHelp(db: D1Database, viewer: Viewer | undefined, slug: string | undefined, search: URLSearchParams): Promise<{ status: number; body: string }> {
  if (!slug) return { status: 200, body: helpIndex(viewer) };
  const guide = GUIDES.find((candidate) => candidate.slug === slug);
  if (!guide?.ready) return { status: 200, body: comingSoon(viewer, guide) };
  // Signed out, nothing about the projects is shown.
  const projects = viewer ? await listProjects(db) : [];
  const wanted = search.get("project");
  const project = projects.find((candidate) => candidate.repo === wanted) ?? projects[0] ?? null;
  return { status: 200, body: productEngineerGuide(viewer, projects, { project, signedIn: !!viewer }) };
}

export function helpIndex(viewer: Viewer | undefined): string {
  const cards = GUIDES.map((guide) =>
    guide.ready
      ? `<a class="help-profile" href="${HELP_PATH}/${guide.slug}">
          <span class="eyebrow">Guide</span>
          <strong>${escapeHtml(guide.title)}</strong>
          <span>${escapeHtml(guide.summary)}</span>
          <span class="help-profile-go">Read the guide →</span>
        </a>`
      : `<div class="help-profile coming" aria-disabled="true">
          <span class="eyebrow">Coming</span>
          <strong>${escapeHtml(guide.title)}</strong>
          <span>${escapeHtml(guide.summary)}</span>
          <span class="help-profile-go muted">Not written yet</span>
        </div>`,
  ).join("");
  return layout(
    "Help · La Fabrique extraordinaire",
    `<header class="hero">
        <p class="eyebrow">Help</p>
        <h1>Getting started with La Fabrique</h1>
        <p class="lede">La Fabrique is the control panel of a software project built with Claude: the ideas and features before they are code, the stories on GitHub, what is being tested, and the go to production. Pick the guide of what you do.</p>
      </header>
      <section class="help-profiles" aria-label="Guides by profile">${cards}</section>
      <section>
        <h2>In one picture</h2>
        ${circuit()}
        <p class="muted small">GitHub holds the development (stories are issues, code is branches and pull requests); La Fabrique holds what comes before (the cards) and follows the rest, without copying it.</p>
      </section>
      ${viewer ? "" : `<section><h2>Access</h2><p>Access is by invitation: a super admin gives a role to your GitHub account, per project. Without a role, signing in only lets you connect a project's app to report a defect.</p><p><a class="button" href="/auth/login">Sign in with GitHub</a></p></section>`}`,
    viewer,
  );
}

function comingSoon(viewer: Viewer | undefined, guide: Guide | undefined): string {
  return layout(
    `${guide?.title ?? "Guide"} · Help · La Fabrique extraordinaire`,
    `<p class="help-crumbs"><a href="${HELP_PATH}">Help</a></p>
      <h1>${escapeHtml(guide?.title ?? "Guide")}</h1>
      <p class="lede">This guide is not written yet. Meanwhile, the <a href="${HELP_PATH}/product-engineer">Product Engineer's guide</a> walks through the whole circuit, from a card to the version in production.</p>`,
    viewer,
  );
}

// The circuit, from a card to production: who moves each step.
function circuit(): string {
  const steps: [string, string, string][] = [
    ["Card", "You write the need on the board", "you"],
    ["Spec", "Claude asks, you answer, Claude writes", "claude"],
    ["Stories", "Claude splits, you review, GitHub receives", "you"],
    ["Sprint", "The release's features, in order", "you"],
    ["Code", "Claude Code opens a pull request", "claude"],
    ["Test", "The criteria checked, the story validated", "you"],
    ["Go", "The version goes to production", "you"],
  ];
  return `<ol class="help-circuit">${steps
    .map(
      ([name, what, who]) =>
        `<li class="help-step ${who}"><strong>${name}</strong><span>${what}</span><span class="pill">${who === "claude" ? "Claude" : "You"}</span></li>`,
    )
    .join("")}</ol>`;
}

function projectPicker(projects: Project[], links: Links): string {
  if (!links.signedIn) {
    return `<aside class="help-note"><p><strong>Reading without an account.</strong> The links into La Fabrique ask you to sign in first, then open the page. Once signed in, they open the tabs of your project.</p><p><a class="button" href="/auth/login?next=${encodeURIComponent(`${HELP_PATH}/product-engineer`)}">Sign in with GitHub</a></p></aside>`;
  }
  if (!links.project) return `<aside class="help-note"><p>No project yet: the links lead to the list of projects. A super admin adds a project in <a href="/projects">Projects</a>.</p></aside>`;
  if (projects.length < 2) return `<aside class="help-note"><p>The links open <strong>${escapeHtml(projectName(links.project))}</strong>.</p></aside>`;
  const options = projects
    .map((project) => `<option value="${escapeHtml(project.repo)}"${project.repo === links.project?.repo ? " selected" : ""}>${escapeHtml(projectName(project))}</option>`)
    .join("");
  return `<aside class="help-note">
      <form method="get" action="${HELP_PATH}/product-engineer" class="help-picker">
        <label for="help-project">The links open</label>
        <select id="help-project" name="project">${options}</select>
        <button type="submit" class="button quiet small">Use this project</button>
      </form>
    </aside>`;
}

function useCase(id: string, title: string, situation: string, steps: string[], after: string): string {
  return `<details class="help-case" id="${id}">
      <summary><span class="eyebrow">Use case</span><strong>${title}</strong><span class="muted">${situation}</span></summary>
      <ol class="help-steps">${steps.map((step) => `<li>${step}</li>`).join("")}</ol>
      <p class="help-after"><strong>What happens next.</strong> ${after}</p>
    </details>`;
}

export function productEngineerGuide(viewer: Viewer | undefined, projects: Project[], links: Links): string {
  const a = (path: string, label: string): string => to(links, path, label);
  const tabs: [string, string, string][] = [
    ["", "Overview", "Where the project is: what is in production, on test, in development."],
    ["/board", "Board", "Your cards (features, ideas, questions), in lanes: by release, status, priority… Drag them, filter them."],
    ["/refinement", "Refinement", "The features of Next release, each with its next step, the release's progress and GO / NO-GO."],
    ["/sprint", "Sprint", "The release in progress: its features and their stories in order, Claude at work, the open pull requests."],
    ["/stories", "Stories", "Every story on GitHub, grouped by card, with its stage."],
    ["/backlog", "Backlog", "What is not started yet, in priority order."],
    ["/to-test", "To test", "The stories to check: their criteria, Validate, Fail with a comment."],
    ["/defects", "Defects", "The defects reported, to link to their story."],
    ["/roadmap", "Roadmap", "The releases, past and coming."],
    ["/releases", "Releases", "The release notes, version by version."],
    ["/requests", "Requests", "The requests written by hand with the project's form."],
  ];
  const lifecycle: [string, string, string][] = [
    ["Draft", "You wrote the card. Nothing is decided.", "you"],
    ["Shaping", "You asked Claude: it asks its questions, then writes the spec.", "claude"],
    ["To validate", "Claude knows enough (or you closed the questions). You read the spec.", "you"],
    ["Validated", "The spec holds. Now the stories.", "you"],
    ["Stories to prepare", "Stories exist on GitHub; some still miss what makes them ready.", "auto"],
    ["Ready for dev", "Every story is ready: priority, criteria, its card.", "auto"],
    ["In sprint", "The card is in the running sprint.", "auto"],
    ["In development", "Claude Code works on a story; a pull request is open.", "auto"],
    ["To test", "The work is merged: check it.", "auto"],
    ["In production", "Released. The card says which version shipped it.", "auto"],
  ];
  const rights: [string, string | null][] = [
    ["Write cards, import them, move them on the board", null],
    ["Ask Claude for a spec, a split into stories, a review of the stories, test cases", null],
    ["Create the stories on GitHub, set their priority, mark them ready", null],
    ["Start, run, stop and close the sprint", null],
    ["Tick criteria, validate a story, write a test feedback", null],
    ["Triage a defect: link it to its story", null],
    ["Give the go to production", null],
    ["Relaunch Claude on a story it left without a pull request", null],
    ["Launch Claude Code on a story by hand, Rework with Claude, Update with Claude", "Tech lead"],
    ["Merge a pull request by hand, change the project's Setup", "Tech lead"],
    ["Give roles, add projects, register an app", "Super admin"],
  ];
  const body = `<p class="help-crumbs"><a href="${HELP_PATH}">Help</a> › Product Engineer</p>
    <header class="hero">
      <p class="eyebrow">Onboarding guide · Product Engineer</p>
      <h1>From a need to the version in production</h1>
      <p class="lede">You own the what and the why. La Fabrique gives you a place to write it, Claude to sharpen it and turn it into stories, and a circuit that follows each story to production, where you give the go.</p>
    </header>

    ${projectPicker(projects, links)}

    <nav class="help-toc" aria-label="In this guide">
      <a href="#role">Your role</a>
      <a href="#first">Your first visit</a>
      <a href="#card">The life of a card</a>
      <a href="#cases">Use cases</a>
      <a href="#habits">Good habits</a>
      <a href="#words">Words</a>
    </nav>

    <section id="role">
      <h2>Your role, in five minutes</h2>
      <div class="help-columns">
        <div>
          <h3>Two places, one circuit</h3>
          <p><strong>GitHub</strong> holds the development: a story is an issue, the code is a branch and a pull request, a deployment is a workflow. <strong>La Fabrique</strong> holds what comes before: the <em>cards</em> (features, ideas, questions), their spec, the order of the release. A card becomes stories on GitHub; La Fabrique keeps the link and follows them.</p>
          <p>Nothing is copied: what you read about a story is read on GitHub. What GitHub does not keep (who validated, who gave the go) is in La Fabrique's log, never erased.</p>
        </div>
        <div>
          <h3>What you do</h3>
          <ol class="help-plain">
            <li>Write the need on a card.</li>
            <li>Shape it with Claude, then validate the spec.</li>
            <li>Split it into stories, each deliverable alone.</li>
            <li>Choose what goes into the next release, in order.</li>
            <li>Run the sprint, check the work, validate.</li>
            <li>Give the go.</li>
          </ol>
        </div>
      </div>
      <h3>What you can do, and what you cannot</h3>
      <ul class="help-rights">${rights
        .map(([what, who]) => `<li class="${who ? "no" : "yes"}"><span class="pill">${who ?? "You"}</span> ${what}</li>`)
        .join("")}</ul>
      <p class="muted small">Each role has the rights of those below it: tester, Product Engineer, tech lead, super admin. The go is the exception: the Product Engineer and the super admin give it, not the tech lead.</p>
    </section>

    <section id="first">
      <h2>Your first visit</h2>
      <ol class="help-steps">
        <li><strong>Sign in with GitHub.</strong> A super admin gave a role to your GitHub account; without it, La Fabrique politely refuses.</li>
        <li><strong>The dashboard</strong> (${links.signedIn ? `<a class="help-app" href="/">open it</a>` : "after sign-in"}) shows your projects and what waits for you.</li>
        <li><strong>The Product perspective</strong> is chosen for you, in the header next to your login. It shows the tabs of your work and hides the others; <em>All</em> shows every tab. A perspective hides, it never forbids.</li>
        <li><strong>Open your project.</strong> Its tabs, in the Product perspective:</li>
      </ol>
      <dl class="help-tabs">${tabs.map(([path, label, what]) => `<dt>${a(path, label)}</dt><dd>${what}</dd>`).join("")}</dl>
      <p>The <strong>(i)</strong> next to La Fabrique's name says the version running and leads to ${links.signedIn ? `<a href="/whats-new">What's new</a>` : "What's new"}. In ${links.signedIn ? `<a class="help-app" href="/settings#claude">Settings → Claude</a>` : "Settings → Claude"}, you see what your calls to Claude cost and how many you have left today.</p>
    </section>

    <section id="card">
      <h2>The life of a card</h2>
      <p>A card has one status. The first four say where its spec is, and you move them; once validated with stories, the status follows the stories and the sprint by itself, with a count (<span class="mono">1/3 developed</span>).</p>
      <ol class="help-life">${lifecycle
        .map(([name, what, who]) => `<li class="${who}"><span class="pill">${name}</span><span>${what}</span><span class="help-who">${who === "you" ? "You" : who === "claude" ? "Claude" : "By itself"}</span></li>`)
        .join("")}</ol>
      <p>A card only moves forward. One exception: if the feature changes once <em>Validated</em> (its text, its spec, an older version taken back), it goes back to <em>To validate</em> until its stories are reviewed. <em>Dropped</em> is always possible, and a card keeps all its versions.</p>
    </section>

    <section id="cases">
      <h2>Use cases</h2>
      <p>Real situations, step by step, with the buttons as they are named. Open the one you need.</p>
      ${useCase(
        "case-feature",
        "A new feature, from the idea to its stories",
        "The shop's customers ask to be told when a recipe they saved changes.",
        [
          `On the ${a("/board", "Board")}, <strong>New card</strong>. Kind <em>Feature</em>. Write what happens today, for whom, and what they must be able to do. Not the technical solution.`,
          `Annotate as you write: <code>{segment: Families}</code> for a value, <code>#12</code> for an issue, <code>@login</code> for a person, <code>[[Recipe]]</code> for a term of the glossary.`,
          `On the card's page, <strong>Ask Claude</strong>. The card goes <em>Shaping</em>; you can leave the page, Claude works in the background and the page updates live when you come back.`,
          `Claude asks at most five questions, each with its answer field under the spec. Answer, send; it does not ask twice. When you know it has enough, <strong>Enough questions</strong>.`,
          `The card is <em>To validate</em>. Read the spec section by section. Something is wrong: <strong>Ask Claude for a change</strong>, in your words. It holds: <strong>Validate the feature</strong>.`,
          `<strong>Split into stories with Claude</strong>. Each proposed story comes with its acceptance criteria; Claude marks some <em>nice to have</em>.`,
          `In the editor, keep, rename, rewrite, reorder the criteria (one per line: <em>When I…, I see…</em>). The preview shows what GitHub will receive. <strong>Create the checked stories on GitHub</strong>.`,
        ],
        "Each story is an issue on GitHub, signed with your login, with a permanent link to the exact version of the spec (“story 2 of 3”). The card lists them with their stage.",
      )}
      ${useCase(
        "case-small",
        "A small change that needs no split",
        "A label is wrong on the order page.",
        [
          `${a("/board", "New card")}, write the need in two lines and the criterion that proves it is fixed.`,
          `<strong>Ask Claude</strong> for the spec, or answer its single question and close with <strong>Enough questions</strong>.`,
          `<strong>Validate the feature</strong>, then <strong>Make one story on GitHub</strong>: one card, one story.`,
        ],
        "The story goes into the next release like any other. A defect seen by a user is not a card: it is reported from the app and triaged in Defects.",
      )}
      ${useCase(
        "case-refinement",
        "Prepare the next release, up to GO / NO-GO",
        "Next Monday's sprint should carry the recipes features; you want to know if it can start.",
        [
          `On the ${a("/board", "Board")}, drag the cards into the <em>Next release</em> lane (or set it on the card).`,
          `Open ${a("/refinement", "Refinement")}. Each feature shows its status and its next step: <em>Specify</em>, <em>Answer</em>, <em>Refine</em>, <em>Validate</em>.`,
          `Set the priorities (the list on each card) and drag the cards into the order you want them built.`,
          `Tick several features and <strong>Launch Claude on the ticked features</strong>: Specify for those without a spec, Refine for those with a complete spec and no stories. The cost is shown before; two jobs run at a time, the others wait their turn, each card shows its place in line.`,
          `Answer Claude's questions in each card, validate each feature when its stories are ready. <strong>Write test cases for all features</strong> if you want Gherkin scenarios for the testers.`,
          `The bar at the top counts features specified, refined, ready, and the stories; below it, <strong>GO</strong> or <strong>NO-GO</strong> for the next sprint, with what is missing.`,
          `For someone without access: <strong>Download the preparation document</strong> (HTML or PDF, three levels of detail) or <strong>Create a share link</strong>, secret, expiring, revocable.`,
        ],
        "GO: the next sprint can take the release. NO-GO says which feature holds it back and why.",
      )}
      ${useCase(
        "case-sprint",
        "Run the sprint",
        "Refinement says GO. You start the release.",
        [
          `On ${a("/sprint", "Sprint")}, <strong>Start the sprint</strong>: the version is proposed (the next one after the latest release), you can type another and give it a name. The cards of <em>Next release</em> move into the sprint.`,
          `Order the cards and, inside each, the stories (drag the handle or use the arrow keys). A story says what it lacks to be ready: set its priority, <strong>Mark ready</strong>.`,
          `<strong>Run the sprint</strong> shows first what will run: the cards in lanes, their stories in order, <em>nice to have</em> last, and where each would stop. Confirm.`,
          `La Fabrique launches Claude Code on each story, waits for its pull request, has it merged by the project's workflow, then takes the next one. One story at a time per card; several cards side by side.`,
          `A card stops when something goes wrong (a story not ready, a failed run, a merge refused) and says why with a link; the others go on. Once fixed: <strong>Resume this card</strong>, or <strong>Relaunch Claude on #n</strong> when Claude left a story without a pull request. <strong>Pause</strong>, <strong>Resume</strong>, <strong>Stop</strong> at any time.`,
        ],
        "Nothing is validated, released or closed by the run: the stories wait in To test for a person.",
      )}
      ${useCase(
        "case-test",
        "Check a story and send it back",
        "Claude's work on “Notify a changed recipe” is merged. You try it.",
        [
          `Open ${a("/to-test", "To test")}. Each story shows its card, its criteria and the defects linked to it.`,
          `Try the story on the test environment (int, or production for a project without one). From the project's app itself, the round La Fabrique button opens <strong>Test</strong>: the same stories and criteria, floating above the app, from page to page.`,
          `Tick each criterion that holds, then <strong>Validate</strong>.`,
          `A criterion fails: <strong>Fail</strong>, write what happened (a screenshot of the page if you want). It becomes a comment on the story, in your name, citing the criterion.`,
        ],
        "A failed story goes back to In development with the rework label. Nothing restarts by itself: a tech lead launches Rework with Claude; once its pull request is merged, the story is to test again.",
      )}
      ${useCase(
        "case-defect",
        "A defect reported from the app",
        "A tester reports “the total is wrong after removing a product” from the shop's app.",
        [
          `Open ${a("/defects", "Defects")}: the defects reported, with their story and version when the reporter chose them, the others <em>to triage</em>.`,
          `Open the defect: its text, its screenshot, its comments, read on GitHub. Choose the story it concerns.`,
        ],
        "La Fabrique says it on GitHub (a comment on the story and on the defect) and removes to triage. To test shows the defect under its story.",
      )}
      ${useCase(
        "case-go",
        "Give the go",
        "Every story of the sprint is validated.",
        [
          `Project with an integration branch: on ${a("/production", "Production")}, <strong>Give the go</strong>. It shows what production will receive and what is not validated yet (<strong>Give the go anyway</strong> if you decide so). The project's own workflow promotes; La Fabrique never holds its deployment keys.`,
          `Project without one: on ${a("/sprint", "Sprint")}, <strong>Close the sprint</strong>. The release is numbered with the sprint's version, its release note written, and merged on the production branch. The sprint says <em>Closing</em> until the release is out.`,
        ],
        "The validated stories are closed with a word in the project's language; each card takes the version that shipped it. Your go is in the log, with your login and the time.",
      )}
      ${useCase(
        "case-change",
        "The feature changes after it was validated",
        "The customers want the notification by e-mail too.",
        [
          `Edit the card's text, or <strong>Ask Claude for a change</strong> of the spec. The card goes back to <em>To validate</em>.`,
          `<strong>Review the stories with Claude</strong>: it reads each story against the new spec and says which hold, which to change (a comment on their issue, which you read before it is sent) and which stories are missing.`,
          `Create the missing ones, send the comments, validate the feature again.`,
        ],
        "The card is Validated again and its status follows its stories. Every version of the spec stays readable.",
      )}
      ${useCase(
        "case-mcp",
        "Work from Claude (claude.ai or Claude Code)",
        "You prefer to think aloud with Claude, then file the cards.",
        [
          `In Claude, add La Fabrique as a connector: the address is <code>/mcp</code> on La Fabrique. You sign in with GitHub and consent.`,
          `Ask: “Read the board of the shop, and create a draft card for the recipe notifications.” Claude reads with your rights and writes in your name: cards, specs, stories, the sprint.`,
          `Disconnect it at any time in ${links.signedIn ? `<a class="help-app" href="/apps">Connected apps</a>` : "Connected apps"}.`,
        ],
        "Every write is in the log with the tool used. The go is never given through Claude.",
      )}
    </section>

    <section id="habits">
      <h2>Good habits</h2>
      <ul class="help-habits">
        <li><strong>The need, not the solution.</strong> “The customer must know the recipe changed”, not “add a websocket”.</li>
        <li><strong>Criteria you can check.</strong> One per line, “When I…, I see…”. The tester ticks them, Claude Code writes one line per criterion in its pull request.</li>
        <li><strong>A story is deliverable alone.</strong> If it cannot go to production without another one, merge them or make one depend on the other.</li>
        <li><strong>Mark what can wait.</strong> A <em>nice to have</em> story never holds its card back, and is built last.</li>
        <li><strong>Answer Claude's questions.</strong> Its answers are kept with the spec; a spec written without them guesses.</li>
        <li><strong>Watch the cost.</strong> Each call to Claude counts against a daily quota per person and a monthly budget; the cost of a card is on its page.</li>
        <li><strong>Personal data, always stated.</strong> Each request says which personal data it adds, or <em>None</em>.</li>
      </ul>
    </section>

    <section id="words">
      <h2>Words</h2>
      <dl class="help-words">
        <dt>Card</dt><dd>A feature, an idea or a question, before it is development. It lives in La Fabrique, never assigned, estimated or put in a sprint by itself.</dd>
        <dt>Spec</dt><dd>The card's functional description, in the project's sections, written with Claude. Versioned.</dd>
        <dt>Story</dt><dd>An issue on GitHub, made from a card, with its acceptance criteria. What Claude Code builds.</dd>
        <dt>Epic</dt><dd>An issue that groups stories on GitHub (label <code>epique</code>).</dd>
        <dt>Definition of Ready</dt><dd>What a story needs before Claude Code takes it: the project's rule (criteria, priority, its card or epic).</dd>
        <dt>Next release</dt><dd>The board's lane where the next sprint's cards wait.</dd>
        <dt>Sprint</dt><dd>The release in progress, with its version, from Start to Close.</dd>
        <dt>int</dt><dd>The integration environment, where the work merged waits for the go and is tested.</dd>
        <dt>Go</dt><dd>The decision to put a version in production. Yours, or a super admin's.</dd>
      </dl>
    </section>

    <section class="help-next">
      <h2>Next</h2>
      <p>${links.signedIn ? `Start with ${a("/board", "your project's board")}` : `<a class="button" href="/auth/login">Sign in with GitHub</a>`} · Other guides on the <a href="${HELP_PATH}">Help page</a>${links.signedIn ? ` · What changed lately in <a href="/whats-new">What's new</a>` : ""}.</p>
    </section>`;
  return layout("Product Engineer · Help · La Fabrique extraordinaire", body, viewer);
}
