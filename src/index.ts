import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { effectiveRole } from "./accounts";
import { APPS_PATH, changeApps, showApps } from "./apps";
import { finishLogin, startLogin } from "./auth";
import { safeEqual } from "./crypto";
import type { Env } from "./env";
import { html, json, redirect, svg, text } from "./http";
import { LOGO_SVG } from "./logo";
import { isAsset, serveAsset } from "./assets";
import { REFRESH_PATH, refreshHeaders, SETTINGS_PATH, settingsPage, SLOW_PATH, slowPage } from "./settings";
import { changePeople, showPeople } from "./people";
import { createProject, recheckProject, showActivity, showBranches, showDelivery, showReleases, showRoadmap, showNewProject, showProject, showProduction, showProjects, showRequestForm, showRequests, goToProduction, launchClaudeOn, prioritize, proposeLifecycle, showLog, showBacklog, showCard, showDashboard, showInDev, showSetup, showStories, showToTest, toTestAction, submitRequest } from "./project-routes";
import { isRepoName } from "./projects";
import { handleWebhook } from "./webhook";
import { showDoc } from "./docs";
import { ACCESS_TOKEN_TTL, api, AUTHORIZE_PATH, authorize, DEFECTS_SCOPE, discovery, DISCOVERY_PATH, REFRESH_TOKEN_TTL, revoke, REVOKE_PATH, TOKEN_PATH, type GrantProps } from "./oauth";
import { d1KeyValue } from "./oauth-store";

const PROJECT_ROUTE = /^\/projects\/([^/]+\/[^/]+?)(\/check|\/branches|\/card|\/log|\/backlog\/claude|\/production\/go|\/to-test\/criterion|\/to-test\/validate|\/to-test\/defect|\/backlog|\/setup|\/to-test|\/in-development|\/stories|\/roadmap|\/releases|\/production|\/delivery|\/activity|\/requests|\/requests\/new)?$/;
const DOC_ROUTE = /^\/projects\/([^/]+\/[^/]+)\/docs\/(.+)$/;
import { destroySession, readSession } from "./session";
import { applySecurityHeaders } from "./headers";
import { homePage, messagePage, noAccessPage, type Viewer } from "./views";
import releaseNotes from "../docs/release-notes.json";
import fabriqueJsonGuide from "../docs/fabrique-json.md";
import guideExample from "../docs/exemples/epicerie.fabrique.json";
import promotionExample from "../docs/exemples/promouvoir.yml";
import claudeExample from "../docs/exemples/claude.yml";
import { renderMarkdown } from "./markdown";
import { GUIDE_PATH, guidePage } from "./setup-views";

const GUIDE_EXAMPLE_PATH = "/guide/epicerie.fabrique.json";

// La Fabrique's own format documentation, so a project's Setup tab links
// stay inside it.
function renderGuide(): { html: string; title: string | null } {
  return renderMarkdown(fabriqueJsonGuide, {
    path: "docs/fabrique-json.md",
    isPage: (candidate) => candidate === "docs/exemples/epicerie.fabrique.json",
    pageUrl: () => GUIDE_EXAMPLE_PATH,
    githubUrl: () => GUIDE_PATH,
  });
}

type ViewerState = { kind: "anonymous" } | { kind: "revoked" } | { kind: "signed_in"; viewer: Viewer };

async function currentViewer(request: Request, env: Env): Promise<ViewerState> {
  const session = await readSession(request, env.DB);
  if (!session) return { kind: "anonymous" };
  const role = await effectiveRole(env, session.login);
  if (!role) return { kind: "revoked" };
  return { kind: "signed_in", viewer: { login: session.login, role, csrfToken: session.csrfToken } };
}

// Every state-changing request carries the session's CSRF token in its form.
async function protectedForm(request: Request, viewer: Pick<Viewer, "csrfToken">): Promise<FormData | null> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return null;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  const token = form.get("csrf");
  return typeof token === "string" && safeEqual(token, viewer.csrfToken) ? form : null;
}

function forbidden(viewer?: Viewer): Response {
  return html(messagePage("Not allowed", "Your role does not give access to this page.", viewer), {
    status: 403,
  });
}

function methodNotAllowed(): Response {
  return text("Method not allowed", 405);
}

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (isAsset(pathname)) return method === "GET" || method === "HEAD" ? serveAsset(request, pathname) : methodNotAllowed();

    switch (pathname) {
      case "/favicon.svg":
      case "/favicon.ico":
        return svg(LOGO_SVG);
      case "/api/version":
        return json({ numero: releaseNotes[0]?.version ?? null, commit: env.COMMIT_SHA });
      case "/auth/login":
        return method === "GET" ? startLogin(request, env) : methodNotAllowed();
      case "/auth/callback":
        return method === "GET" ? finishLogin(request, env) : methodNotAllowed();
      case "/no-access":
        return html(noAccessPage());
      case "/api/github/webhook":
        return method === "POST" ? handleWebhook(request, env) : methodNotAllowed();
      case AUTHORIZE_PATH:
        return authorize(request, env);
      case APPS_PATH: {
        // Open to accounts without a role, which sign in only to connect
        // an app and to disconnect it.
        const session = await readSession(request, env.DB);
        if (!session) return redirect(`/auth/login?next=${encodeURIComponent(APPS_PATH)}`);
        const person = { login: session.login, role: await effectiveRole(env, session.login), csrfToken: session.csrfToken };
        if (method === "GET") return showApps(request, env, person);
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, person);
        return form ? changeApps(form, env, person) : html(messagePage("Not allowed", "This form expired: reload the page."), { status: 403 });
      }
    }

    const state = await currentViewer(request, env);
    if (state.kind === "revoked") {
      return redirect("/no-access", [await destroySession(request, env.DB)]);
    }
    const viewer = state.kind === "signed_in" ? state.viewer : undefined;

    const docRoute = DOC_ROUTE.exec(pathname);
    if (docRoute) {
      if (!viewer) return redirect("/");
      if (method !== "GET") return methodNotAllowed();
      const repo = docRoute[1] ?? "";
      let path: string;
      try {
        path = decodeURIComponent(docRoute[2] ?? "");
      } catch {
        path = "";
      }
      if (!isRepoName(repo) || !path) {
        return html(messagePage("Not found", "There is nothing at this address.", viewer), { status: 404 });
      }
      return showDoc(request, env, viewer, repo, path);
    }

    const projectRoute = PROJECT_ROUTE.exec(pathname);
    if (projectRoute) {
      const repo = projectRoute[1] ?? "";
      if (!viewer) return redirect("/");
      if (!isRepoName(repo)) return html(messagePage("Not found", "There is nothing at this address.", viewer), { status: 404 });
      if (!projectRoute[2]) return method === "GET" ? showProject(request, env, viewer, repo) : methodNotAllowed();
      if (projectRoute[2] === "/requests/new") {
        return method === "GET" ? showRequestForm(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/requests") {
        if (method === "GET") return showRequests(request, env, viewer, repo);
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? submitRequest(request, form, env, viewer, repo) : forbidden(viewer);
      }
      if (projectRoute[2] === "/production/go") {
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? goToProduction(request, form, env, viewer, repo) : forbidden(viewer);
      }
      if (projectRoute[2] === "/backlog/claude") {
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? launchClaudeOn(request, form, env, viewer, repo) : forbidden(viewer);
      }
      if (projectRoute[2] === "/log") {
        return method === "GET" ? showLog(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/card") {
        return method === "GET" ? showCard(env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/backlog") {
        if (method === "GET") return showBacklog(request, env, viewer, repo);
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? prioritize(request, form, env, viewer, repo) : forbidden(viewer);
      }
      if (projectRoute[2] === "/in-development") {
        return method === "GET" ? showInDev(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2]?.startsWith("/to-test/")) {
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        const action = projectRoute[2].slice("/to-test/".length) as "criterion" | "validate" | "defect";
        return form ? toTestAction(request, form, env, viewer, repo, action) : forbidden(viewer);
      }
      if (projectRoute[2] === "/to-test") {
        return method === "GET" ? showToTest(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/setup") {
        if (method === "GET") return showSetup(request, env, viewer, repo);
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? proposeLifecycle(request, form, env, viewer, repo) : forbidden(viewer);
      }
      if (projectRoute[2] === "/branches") {
        return method === "GET" ? showBranches(env, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/roadmap") {
        return method === "GET" ? showRoadmap(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/releases") {
        return method === "GET" ? showReleases(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/delivery") {
        return method === "GET" ? showDelivery(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/activity") {
        return method === "GET" ? showActivity(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/production") {
        return method === "GET" ? showProduction(request, env, viewer, repo) : methodNotAllowed();
      }
      if (projectRoute[2] === "/stories") {
        return method === "GET" ? showStories(request, env, viewer, repo) : methodNotAllowed();
      }
      if (method !== "POST") return methodNotAllowed();
      if (viewer.role !== "super_admin") return forbidden(viewer);
      return (await protectedForm(request, viewer)) ? recheckProject(env, viewer, repo) : forbidden(viewer);
    }

    switch (pathname) {
      case "/":
      case "/index.html":
        return viewer ? showDashboard(env, viewer) : html(homePage());

      case "/projects": {
        if (!viewer) return redirect("/");
        if (method === "GET") return showProjects(env, viewer);
        if (method !== "POST") return methodNotAllowed();
        if (viewer.role !== "super_admin") return forbidden(viewer);
        const form = await protectedForm(request, viewer);
        return form ? createProject(form, env, viewer) : forbidden(viewer);
      }

      case "/projects/new":
        if (!viewer) return redirect("/");
        if (viewer.role !== "super_admin") return forbidden(viewer);
        return method === "GET" ? showNewProject(request, env, viewer) : methodNotAllowed();

      case "/auth/logout": {
        if (method !== "POST") return methodNotAllowed();
        if (!viewer) return redirect("/");
        if (!(await protectedForm(request, viewer))) return forbidden(viewer);
        return redirect("/", [await destroySession(request, env.DB)]);
      }

      case GUIDE_PATH:
        if (!viewer) return redirect("/");
        return method === "GET" ? html(guidePage(viewer, renderGuide())) : methodNotAllowed();

      case "/guide/exemples/promouvoir.yml":
      case "/guide/exemples/claude.yml":
        if (!viewer) return redirect("/");
        return method === "GET"
          ? text(pathname.endsWith("claude.yml") ? claudeExample : promotionExample, 200)
          : methodNotAllowed();

      case GUIDE_EXAMPLE_PATH:
        if (!viewer) return redirect("/");
        return method === "GET" ? json(guideExample) : methodNotAllowed();

      case SETTINGS_PATH: {
        if (!viewer) return redirect("/");
        if (method !== "GET") return methodNotAllowed();
        const notice = new URL(request.url).searchParams.get("notice");
        return html(settingsPage(viewer, { version: releaseNotes[0]?.version ?? null, commit: env.COMMIT_SHA, notice }));
      }

      case REFRESH_PATH:
        if (method !== "POST") return methodNotAllowed();
        if (!viewer) return redirect("/");
        if (!(await protectedForm(request, viewer))) return forbidden(viewer);
        return redirect(`${SETTINGS_PATH}?notice=refreshed`, [], refreshHeaders());

      case SLOW_PATH:
        if (!viewer) return redirect("/");
        if (method !== "GET") return methodNotAllowed();
        await slowPage();
        return redirect(`${SETTINGS_PATH}?notice=tried`);

      case "/people": {
        if (!viewer) return redirect("/");
        if (viewer.role !== "super_admin") return forbidden(viewer);
        if (method === "GET") return showPeople(request, env, viewer);
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? changePeople(form, env, viewer) : forbidden(viewer);
      }
    }

    return html(messagePage("Not found", "There is nothing at this address.", viewer), {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;

// La Fabrique is also an OAuth provider for the projects' own apps
// (la-fabrique#65): the library answers the token endpoint, discovery and
// the API's tokens; everything else is the app above. Its store is the D1
// base, so no other binding is needed.
// The library binds tokens to the API's address (RFC 9728), which is the
// address the Worker is called at: one provider per origin.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: ["/api/me", "/api/projects/"],
      apiHandler: {
        fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown }) {
          return api(request, env, ctx.props as GrantProps);
        },
      },
      defaultHandler: app,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
      scopesSupported: [DEFECTS_SCOPE],
      resourceMetadata: { resource: origin, resource_name: "La Fabrique extraordinaire" },
      accessTokenTTL: ACCESS_TOKEN_TTL,
      refreshTokenTTL: REFRESH_TOKEN_TTL,
      disallowPublicClientRegistration: true,
    });
    providers.set(origin, provider);
  }
  return provider;
}

function withSecurityHeaders(response: Response): Response {
  if (response.headers.has("content-security-policy") || response.status === 101) return response;
  const copy = new Response(response.body, response);
  applySecurityHeaders(copy.headers);
  return copy;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const oauthEnv: Env = { ...env, OAUTH_KV: d1KeyValue(env.DB) };
    const { pathname, origin } = new URL(request.url);
    const provider = providerFor(origin);
    if (pathname === REVOKE_PATH) return withSecurityHeaders(await revoke(request, provider, oauthEnv, ctx));
    const response = await provider.fetch(request, oauthEnv, ctx);
    if (pathname === DISCOVERY_PATH && request.method === "GET") return discovery(response, request);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
