import { PRODUCT_ENGINEER } from "./help-pe";
import { hostCookie } from "./http";
import { listProjects, type Project } from "./projects";
import { escapeHtml, layout, type Viewer } from "./views";

// Onboarding guides, one per profile (la-fabrique#264). Open without an
// account: the signed-out home page and the menu link here. Signed in, the
// links open the person's project; signed out, they go through sign-in.
//
// A guide has two entries that point at each other (la-fabrique#267): the
// user guide, made of use cases grouped by moment, and the reference, one
// page per area. A use case's step names the reference section that
// explains it; each reference section lists the use cases that use it.
export const HELP_PATH = "/help";
export const HELP_ROUTE = /^\/help(?:\/([a-z-]{1,40})(?:\/(use-cases|reference)\/([a-z0-9-]{1,60}))?)?$/;

// What a guide's text can use: links into the app, into the guide, and the
// name of a button.
export interface Helpers {
  // A page of the chosen project: "/board", "/sprint"…
  app(path: string, label: string): string;
  // A reference section: "board#lanes".
  ref(target: string, label: string): string;
  // A use case, by its slug.
  useCase(slug: string, label: string): string;
  // Whether the reader is signed in.
  signedIn: boolean;
}

export type Text = string | ((h: Helpers) => string);

export interface Step {
  text: Text;
  // The reference section that explains the step: "page#section".
  ref?: string;
}

export interface UseCase {
  slug: string;
  moment: string;
  title: string;
  situation: string;
  steps: Step[];
  after: Text;
  // More reference sections worth reading, beyond those of the steps.
  see?: string[];
}

export interface RefSection {
  id: string;
  title: string;
  body: Text;
}

export interface RefPage {
  slug: string;
  title: string;
  summary: string;
  sections: RefSection[];
}

export interface Moment {
  id: string;
  title: string;
  summary: string;
}

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  ready: boolean;
  // The guide's home page.
  heading?: string;
  lede?: string;
  intro?: Text;
  moments?: Moment[];
  useCases?: UseCase[];
  reference?: RefPage[];
}

export const GUIDES: Guide[] = [
  PRODUCT_ENGINEER,
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

// Where the links lead: the chosen project's pages, the list of projects
// when there is none, sign-in first when signed out. The project chosen by
// hand follows the reader from page to page (`?project=`).
export const HELP_PROJECT_COOKIE = "__Host-help-project";

interface Links {
  project: Project | null;
  signedIn: boolean;
  chosen: boolean;
}

function appUrl(links: Links, path: string): string {
  const target = links.project ? `/projects/${links.project.repo}${path}` : "/projects";
  return links.signedIn ? target : `/auth/login?next=${encodeURIComponent(target)}`;
}

function guideUrl(links: Links, path: string): string {
  const [base, hash] = path.split("#");
  const query = links.chosen && links.project ? `?project=${encodeURIComponent(links.project.repo)}` : "";
  return `${base}${query}${hash ? `#${hash}` : ""}`;
}

function projectName(project: Project): string {
  return project.check?.config?.nom || project.repo;
}

function useCaseUrl(guide: Guide, slug: string): string {
  return `${HELP_PATH}/${guide.slug}/use-cases/${slug}`;
}

function referenceUrl(guide: Guide, target: string): string {
  const [page, section] = target.split("#");
  return `${HELP_PATH}/${guide.slug}/reference/${page}${section ? `#${section}` : ""}`;
}

function helpers(guide: Guide, links: Links): Helpers {
  return {
    app: (path, label) => `<a class="help-app" href="${escapeHtml(appUrl(links, path))}">${label}</a>`,
    ref: (target, label) => `<a href="${escapeHtml(guideUrl(links, referenceUrl(guide, target)))}">${label}</a>`,
    useCase: (slug, label) => `<a href="${escapeHtml(guideUrl(links, useCaseUrl(guide, slug)))}">${label}</a>`,
    signedIn: links.signedIn,
  };
}

function render(text: Text, h: Helpers): string {
  return typeof text === "function" ? text(h) : text;
}

// A reference target's page and section, when they exist.
export function resolveRef(guide: Guide, target: string): { page: RefPage; section: RefSection | null } | null {
  const [slug, id] = target.split("#");
  const page = guide.reference?.find((candidate) => candidate.slug === slug);
  if (!page) return null;
  if (!id) return { page, section: null };
  const section = page.sections.find((candidate) => candidate.id === id);
  return section ? { page, section } : null;
}

// Every reference target a use case leads to, in order, without repeats.
export function useCaseRefs(useCase: UseCase): string[] {
  return [...new Set([...useCase.steps.flatMap((step) => (step.ref ? [step.ref] : [])), ...(useCase.see ?? [])])];
}

// The use cases that lead to a reference section (or to its page).
function usedIn(guide: Guide, page: RefPage, section: RefSection): UseCase[] {
  return (guide.useCases ?? []).filter((useCase) =>
    useCaseRefs(useCase).some((target) => target === `${page.slug}#${section.id}`),
  );
}

export async function showHelp(
  db: D1Database,
  viewer: Viewer | undefined,
  match: RegExpExecArray,
  search: URLSearchParams,
  remembered: { cookie?: string | undefined; referer?: string | null } = {},
): Promise<{ status: number; body: string; cookie?: string }> {
  const [, slug, kind, page] = match;
  if (!slug) return { status: 200, body: helpIndex(viewer) };
  const guide = GUIDES.find((candidate) => candidate.slug === slug);
  if (!guide) return { status: 404, body: notFound(viewer) };
  if (!guide.ready) return { status: 200, body: comingSoon(viewer, guide) };
  // Signed out, nothing about the projects is shown.
  const projects = viewer ? await listProjects(db) : [];
  const asked = projects.find((candidate) => candidate.repo === search.get("project"));
  // Otherwise the project chosen earlier (cookie), then the one the reader
  // came from (a page of /projects/{owner}/{repo}), then the first.
  const earlier = projects.find((candidate) => candidate.repo === decodeURIComponent(remembered.cookie ?? ""));
  const origin = projects.find((candidate) => (remembered.referer ?? "").includes(`/projects/${candidate.repo}`));
  const chosen = asked ?? earlier;
  const links: Links = { project: chosen ?? origin ?? projects[0] ?? null, signedIn: !!viewer, chosen: !!(chosen ?? origin) };
  const cookie = asked ? hostCookie(HELP_PROJECT_COOKIE, encodeURIComponent(asked.repo), 60 * 60 * 24 * 365) : undefined;
  const done = (page: { status: number; body: string }): { status: number; body: string; cookie?: string } => (cookie ? { ...page, cookie } : page);
  if (!kind) return done({ status: 200, body: guideHome(viewer, guide, projects, links) });
  if (kind === "use-cases") {
    const useCase = guide.useCases?.find((candidate) => candidate.slug === page);
    return done(useCase ? { status: 200, body: useCasePage(viewer, guide, useCase, projects, links) } : { status: 404, body: notFound(viewer, guide) });
  }
  const reference = guide.reference?.find((candidate) => candidate.slug === page);
  return done(reference ? { status: 200, body: referencePage(viewer, guide, reference, projects, links) } : { status: 404, body: notFound(viewer, guide) });
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

function comingSoon(viewer: Viewer | undefined, guide: Guide): string {
  return layout(
    `${guide.title} · Help · La Fabrique extraordinaire`,
    `<p class="help-crumbs"><a href="${HELP_PATH}">Help</a> › ${escapeHtml(guide.title)}</p>
      <h1>${escapeHtml(guide.title)}</h1>
      <p class="lede">This guide is not written yet. Meanwhile, the <a href="${HELP_PATH}/product-engineer">Product Engineer's guide</a> walks through the whole circuit, from a card to the version in production.</p>`,
    viewer,
  );
}

function notFound(viewer: Viewer | undefined, guide?: Guide): string {
  return layout(
    "Not found · Help · La Fabrique extraordinaire",
    `<p class="help-crumbs"><a href="${HELP_PATH}">Help</a>${guide ? ` › <a href="${HELP_PATH}/${guide.slug}">${escapeHtml(guide.title)}</a>` : ""}</p>
      <h1>Not found</h1>
      <p>There is no such page in the help. ${guide ? `See the <a href="${HELP_PATH}/${guide.slug}">${escapeHtml(guide.title)}'s guide</a>.` : `See <a href="${HELP_PATH}">all the guides</a>.`}</p>`,
    viewer,
  );
}

// The circuit, from a card to production: who moves each step.
export function circuit(): string {
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

function projectPicker(projects: Project[], links: Links, action: string, compact = false): string {
  if (!links.signedIn && compact) {
    return `<p class="help-note help-note-line small">Reading without an account: the links into La Fabrique go through <a href="/auth/login?next=${encodeURIComponent(action)}">sign-in</a>.</p>`;
  }
  if (!links.signedIn) {
    return `<aside class="help-note"><p><strong>Reading without an account.</strong> The links into La Fabrique ask you to sign in first, then open the page. Once signed in, they open the tabs of your project.</p><p><a class="button" href="/auth/login?next=${encodeURIComponent(action)}">Sign in with GitHub</a></p></aside>`;
  }
  if (!links.project) return `<aside class="help-note"><p>No project yet: the links lead to the list of projects. A super admin adds a project in <a href="/projects">Projects</a>.</p></aside>`;
  if (projects.length < 2) {
    return compact ? "" : `<aside class="help-note"><p>The links open <strong>${escapeHtml(projectName(links.project))}</strong>.</p></aside>`;
  }
  const options = projects
    .map((project) => `<option value="${escapeHtml(project.repo)}"${project.repo === links.project?.repo ? " selected" : ""}>${escapeHtml(projectName(project))}</option>`)
    .join("");
  return `<aside class="help-note">
      <form method="get" action="${escapeHtml(action)}" class="help-picker">
        <label for="help-project">The links open</label>
        <select id="help-project" name="project">${options}</select>
        <button type="submit" class="button quiet small">Use this project</button>
      </form>
    </aside>`;
}

// The guide's menu, on every page: its home, the use cases by moment, the
// reference pages. On a phone it folds under "Guide menu".
function sideNav(guide: Guide, links: Links, current: string): string {
  const item = (path: string, label: string): string =>
    `<li><a href="${escapeHtml(guideUrl(links, path))}"${path === current ? ` aria-current="page"` : ""}>${escapeHtml(label)}</a></li>`;
  const moments = (guide.moments ?? [])
    .map((moment) => {
      const cases = (guide.useCases ?? []).filter((useCase) => useCase.moment === moment.id);
      return cases.length
        ? `<li><span class="help-nav-moment">${escapeHtml(moment.title)}</span><ul>${cases.map((useCase) => item(useCaseUrl(guide, useCase.slug), useCase.title)).join("")}</ul></li>`
        : "";
    })
    .join("");
  const reference = (guide.reference ?? []).map((page) => item(referenceUrl(guide, page.slug), page.title)).join("");
  const home = `${HELP_PATH}/${guide.slug}`;
  const menu = `<ul class="help-nav-top">${item(home, `${guide.title}: start here`)}</ul>
        <p class="help-nav-title">User guide</p>
        <ul class="help-nav-cases">${moments}</ul>
        <p class="help-nav-title">Reference</p>
        <ul>${reference}</ul>`;
  // Folded on a phone, always open beside the page on a wide screen.
  return `<details class="help-nav help-nav-phone">
      <summary>Guide menu</summary>
      <nav aria-label="${escapeHtml(guide.title)}'s guide (menu)">${menu}</nav>
    </details>
    <nav class="help-nav help-nav-wide" aria-label="${escapeHtml(guide.title)}'s guide">${menu}</nav>`;
}

function guideLayout(viewer: Viewer | undefined, guide: Guide, links: Links, current: string, title: string, crumbs: string, body: string): string {
  return layout(
    `${title} · Help · La Fabrique extraordinaire`,
    `<p class="help-crumbs"><a href="${HELP_PATH}">Help</a> › ${crumbs}</p>
      <div class="help-shell">
        ${sideNav(guide, links, current)}
        <div class="help-body">${body}</div>
      </div>`,
    viewer,
  );
}

function guideHome(viewer: Viewer | undefined, guide: Guide, projects: Project[], links: Links): string {
  const h = helpers(guide, links);
  const path = `${HELP_PATH}/${guide.slug}`;
  const moments = (guide.moments ?? [])
    .map((moment) => {
      const cases = (guide.useCases ?? []).filter((useCase) => useCase.moment === moment.id);
      if (!cases.length) return "";
      return `<section class="help-moment" id="${escapeHtml(moment.id)}">
          <h3>${escapeHtml(moment.title)}</h3>
          <p class="muted">${escapeHtml(moment.summary)}</p>
          <ul class="help-case-list">${cases
            .map(
              (useCase) =>
                `<li><a href="${escapeHtml(guideUrl(links, useCaseUrl(guide, useCase.slug)))}"><strong>${escapeHtml(useCase.title)}</strong><span>${escapeHtml(useCase.situation)}</span></a></li>`,
            )
            .join("")}</ul>
        </section>`;
    })
    .join("");
  const reference = (guide.reference ?? [])
    .map(
      (page) =>
        `<li><a href="${escapeHtml(guideUrl(links, referenceUrl(guide, page.slug)))}"><strong>${escapeHtml(page.title)}</strong><span>${escapeHtml(page.summary)}</span></a></li>`,
    )
    .join("");
  const body = `<header class="hero">
      <p class="eyebrow">Onboarding guide · ${escapeHtml(guide.title)}</p>
      <h1>${escapeHtml(guide.heading ?? guide.title)}</h1>
      ${guide.lede ? `<p class="lede">${escapeHtml(guide.lede)}</p>` : ""}
    </header>
    ${projectPicker(projects, links, path)}
    ${guide.intro ? render(guide.intro, h) : ""}
    <div class="help-entries">
      <section id="user-guide">
        <h2>User guide: what do you want to do?</h2>
        <p class="muted">Real situations, step by step, with the buttons as they are named. Each step leads to the reference when you want the details.</p>
        ${moments}
      </section>
      <section id="reference">
        <h2>Reference: how it works</h2>
        <p class="muted">One page per area: what you see, each button, the rules, who can do what.</p>
        <ul class="help-ref-list">${reference}</ul>
      </section>
    </div>`;
  return guideLayout(viewer, guide, links, path, guide.title, escapeHtml(guide.title), body);
}

function neighbours<T>(items: T[], index: number): { previous: T | undefined; next: T | undefined } {
  return { previous: index > 0 ? items[index - 1] : undefined, next: items[index + 1] };
}

function pager(previous: { url: string; title: string } | null, next: { url: string; title: string } | null): string {
  if (!previous && !next) return "";
  return `<nav class="help-pager" aria-label="Previous and next">
      ${previous ? `<a class="help-pager-prev" href="${escapeHtml(previous.url)}"><span class="muted small">Previous</span>${escapeHtml(previous.title)}</a>` : "<span></span>"}
      ${next ? `<a class="help-pager-next" href="${escapeHtml(next.url)}"><span class="muted small">Next</span>${escapeHtml(next.title)}</a>` : ""}
    </nav>`;
}

function useCasePage(viewer: Viewer | undefined, guide: Guide, useCase: UseCase, projects: Project[], links: Links): string {
  const h = helpers(guide, links);
  const path = useCaseUrl(guide, useCase.slug);
  const moment = guide.moments?.find((candidate) => candidate.id === useCase.moment);
  const steps = useCase.steps
    .map((step) => {
      const target = step.ref ? resolveRef(guide, step.ref) : null;
      const more = step.ref && target
        ? `<a class="help-ref-link" href="${escapeHtml(guideUrl(links, referenceUrl(guide, step.ref)))}">Reference: ${escapeHtml(target.page.title)}${target.section ? ` › ${escapeHtml(target.section.title)}` : ""}</a>`
        : "";
      return `<li><div>${render(step.text, h)}</div>${more}</li>`;
    })
    .join("");
  const related = useCaseRefs(useCase)
    .map((target) => ({ target, found: resolveRef(guide, target) }))
    .filter((entry) => entry.found)
    .map(
      ({ target, found }) =>
        `<li><a href="${escapeHtml(guideUrl(links, referenceUrl(guide, target)))}">${escapeHtml(found!.page.title)}${found!.section ? ` › ${escapeHtml(found!.section.title)}` : ""}</a></li>`,
    )
    .join("");
  const cases = guide.useCases ?? [];
  const { previous, next } = neighbours(cases, cases.indexOf(useCase));
  const body = `<header class="help-page-head">
      <p class="eyebrow">Use case${moment ? ` · ${escapeHtml(moment.title)}` : ""}</p>
      <h1>${escapeHtml(useCase.title)}</h1>
      <p class="lede">${escapeHtml(useCase.situation)}</p>
    </header>
    ${projectPicker(projects, links, path, true)}
    <ol class="help-steps help-steps-big">${steps}</ol>
    <p class="help-after"><strong>What happens next.</strong> ${render(useCase.after, h)}</p>
    ${related ? `<section class="help-related"><h2>In the reference</h2><ul>${related}</ul></section>` : ""}
    ${pager(
      previous ? { url: guideUrl(links, useCaseUrl(guide, previous.slug)), title: previous.title } : null,
      next ? { url: guideUrl(links, useCaseUrl(guide, next.slug)), title: next.title } : null,
    )}`;
  return guideLayout(
    viewer,
    guide,
    links,
    path,
    useCase.title,
    `<a href="${escapeHtml(guideUrl(links, `${HELP_PATH}/${guide.slug}`))}">${escapeHtml(guide.title)}</a> › <a href="${escapeHtml(guideUrl(links, `${HELP_PATH}/${guide.slug}#user-guide`))}">User guide</a>`,
    body,
  );
}

function referencePage(viewer: Viewer | undefined, guide: Guide, page: RefPage, projects: Project[], links: Links): string {
  const h = helpers(guide, links);
  const path = referenceUrl(guide, page.slug);
  const toc = page.sections.map((section) => `<a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a>`).join("");
  const sections = page.sections
    .map((section) => {
      const cases = usedIn(guide, page, section);
      const used = cases.length
        ? `<p class="help-used-in"><span class="muted">Used in</span> ${cases
            .map((useCase) => `<a href="${escapeHtml(guideUrl(links, useCaseUrl(guide, useCase.slug)))}">${escapeHtml(useCase.title)}</a>`)
            .join(" · ")}</p>`
        : "";
      return `<section class="help-ref-section" id="${escapeHtml(section.id)}">
          <h2>${escapeHtml(section.title)}</h2>
          ${render(section.body, h)}
          ${used}
        </section>`;
    })
    .join("");
  const pages = guide.reference ?? [];
  const { previous, next } = neighbours(pages, pages.indexOf(page));
  const body = `<header class="help-page-head">
      <p class="eyebrow">Reference</p>
      <h1>${escapeHtml(page.title)}</h1>
      <p class="lede">${escapeHtml(page.summary)}</p>
    </header>
    ${projectPicker(projects, links, path, true)}
    ${page.sections.length > 2 ? `<nav class="help-toc" aria-label="On this page">${toc}</nav>` : ""}
    ${sections}
    ${pager(
      previous ? { url: guideUrl(links, referenceUrl(guide, previous.slug)), title: previous.title } : null,
      next ? { url: guideUrl(links, referenceUrl(guide, next.slug)), title: next.title } : null,
    )}`;
  return guideLayout(
    viewer,
    guide,
    links,
    path,
    page.title,
    `<a href="${escapeHtml(guideUrl(links, `${HELP_PATH}/${guide.slug}`))}">${escapeHtml(guide.title)}</a> › <a href="${escapeHtml(guideUrl(links, `${HELP_PATH}/${guide.slug}#reference`))}">Reference</a>`,
    body,
  );
}
