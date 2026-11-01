import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { effectiveRole } from "./accounts";
import { APPS_PATH, changeApps, showApps } from "./apps";
import { finishLogin, startLogin } from "./auth";
import { safeEqual } from "./crypto";
import type { Env } from "./env";
import { html, json, redirect, svg, text } from "./http";
import { LOGO_SVG } from "./logo";
import { isAsset, serveAsset } from "./assets";
import { isKitFile, KIT_GUIDE_PATH, reportKitGuide, serveKitFile } from "./kit";
import { CLAUDE_CHECK_PATH, REFRESH_PATH, refreshHeaders, SETTINGS_PATH, settingsPage, SLOW_PATH, slowPage } from "./settings";
import { checkKey, claudeSettings, usageReport } from "./llm";
import { consumeJobs } from "./jobs";
import { changePeople, showPeople } from "./people";
import { createProject, recheckProject, showActivity, showBranches, showDelivery, showReleases, showRoadmap, showNewProject, showProject, showProduction, showProjects, showRequestForm, showRequests, goToProduction, launchClaudeOn, prioritize, proposeLifecycle, projectAppAction, proposeKit, triage, showDefect, showDefects, showLog, showBacklog, showCard, showDashboard, showInDev, showSetup, showStories, showToTest, toTestAction, submitRequest } from "./project-routes";
import { isRepoName } from "./projects";
import { handleWebhook } from "./webhook";
import { showDoc } from "./docs";
import { ACCESS_TOKEN_TTL, api, AUTHORIZE_PATH, authorize, DEFECTS_SCOPE, discovery, DISCOVERY_PATH, TEST_SCOPE, REFRESH_TOKEN_TTL, REGISTER_PATH, revoke, REVOKE_PATH, TOKEN_PATH, type GrantProps } from "./oauth";
import { d1KeyValue } from "./oauth-store";
import { ICON_PNGS } from "./icons";
import { MCP_PATH, MCP_SCOPE } from "./mcp";
import { SCREENSHOT_ROUTE, serveScreenshot } from "./defects";
import { CARD_ROUTE, cardRoute } from "./card-routes";
import { cardUrl } from "./card-views";
import { findCardById } from "./cards";
import { availablePerspectives, choosePerspective, currentPerspective, isPerspective } from "./perspectives";

const PROJECT_ROUTE = /^\/projects\/([^/]+\/[^/]+?)(\/check|\/app|\/kit|\/branches|\/card|\/log|\/backlog\/claude|\/production\/go|\/to-test\/criterion|\/to-test\/validate|\/to-test\/defect|\/backlog|\/setup|\/to-test|\/defects\/\d+|\/defects|\/in-development|\/stories|\/roadmap|\/releases|\/production|\/delivery|\/activity|\/requests|\/requests\/new)?$/;
const DOC_ROUTE = /^\/projects\/([^/]+\/[^/]+)\/docs\/(.+)$/;
import { destroySession, readSession } from "./session";
import { applySecurityHeaders } from "./headers";
import { homePage, messagePage, noAccessPage, type Viewer } from "./views";
import { WHATS_NEW_PATH } from "./urls";
import { ownReleases, selfRepo, whatsNewPage } from "./whats-new";
import { onlineVersion, setCommit } from "./build";
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
  const perspective = await currentPerspective(env.DB, session.login, role);
  return { kind: "signed_in", viewer: { login: session.login, role, csrfToken: session.csrfToken, perspective } };
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
    if (isKitFile(pathname)) return method === "GET" || method === "HEAD" ? serveKitFile(pathname) : methodNotAllowed();

    switch (pathname) {
      case "/favicon.svg":
        return svg(LOGO_SVG);
      // PNG for what does not read SVG (favicon readers, assistants).
      case "/favicon.ico":
        return png("32");
      case "/apple-touch-icon.png":
        return png("180");
      case "/icon-192.png":
        return png("192");
      case "/icon-512.png":
        return png("512");
      case "/api/version":
        return json({ numero: onlineVersion(), commit: env.COMMIT_SHA });
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

    const screenshot = SCREENSHOT_ROUTE.exec(pathname);
    if (screenshot) {
      if (method !== "GET") return methodNotAllowed();
      const image = await serveScreenshot(env, screenshot[1] ?? "", screenshot[2] ?? "");
      return image ?? text("Not found", 404);
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

    // A card's permanent address (in the stories made from it): the same
    // whatever the project's repository is called, with the version of
    // its spec.
    const permalink = /^\/c\/(\d{1,9})$/.exec(pathname);
    if (permalink) {
      const { search } = new URL(request.url);
      if (!viewer) return redirect(`/auth/login?next=${encodeURIComponent(pathname + search)}`);
      const card = await findCardById(env.DB, Number(permalink[1]));
      if (!card) return html(messagePage("Not found", "There is no such card in La Fabrique extraordinaire.", viewer), { status: 404 });
      const rev = Number(new URL(request.url).searchParams.get("rev"));
      return redirect(`${cardUrl(card.repo, card.id)}${Number.isInteger(rev) && rev > 0 && rev !== card.rev ? `?rev=${rev}` : ""}`);
    }

    const cardMatch = CARD_ROUTE.exec(pathname);
    if (cardMatch) {
      if (!viewer) return redirect("/");
      if (!isRepoName(cardMatch[1] ?? "")) return html(messagePage("Not found", "There is nothing at this address.", viewer), { status: 404 });
      return cardRoute(request, env, viewer, cardMatch, () => protectedForm(request, viewer));
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
      if (projectRoute[2] === "/kit") {
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? proposeKit(request, env, viewer, repo) : forbidden(viewer);
      }
      if (projectRoute[2] === "/app") {
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? projectAppAction(request, form, env, viewer, repo) : forbidden(viewer);
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
      if (projectRoute[2]?.startsWith("/defects/")) {
        return method === "GET" ? showDefect(request, env, viewer, repo, Number(projectRoute[2].slice("/defects/".length))) : methodNotAllowed();
      }
      if (projectRoute[2] === "/defects") {
        if (method === "GET") return showDefects(request, env, viewer, repo);
        if (method !== "POST") return methodNotAllowed();
        const form = await protectedForm(request, viewer);
        return form ? triage(request, form, env, viewer, repo) : forbidden(viewer);
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

      // The perspective chosen in the header; back to the page it was chosen on.
      case "/perspective": {
        if (method !== "POST") return methodNotAllowed();
        if (!viewer) return redirect("/");
        const form = await protectedForm(request, viewer);
        if (!form) return forbidden(viewer);
        const chosen = form.get("perspective");
        if (isPerspective(chosen) && availablePerspectives(viewer.role).includes(chosen)) {
          await choosePerspective(env.DB, viewer.login, chosen);
        }
        const referer = request.headers.get("referer");
        const back = referer ? new URL(referer, request.url) : null;
        return redirect(back && back.origin === new URL(request.url).origin ? `${back.pathname}${back.search}` : "/");
      }

      case "/auth/logout": {
        if (method !== "POST") return methodNotAllowed();
        if (!viewer) return redirect("/");
        if (!(await protectedForm(request, viewer))) return forbidden(viewer);
        return redirect("/", [await destroySession(request, env.DB)]);
      }

      case GUIDE_PATH:
        if (!viewer) return redirect("/");
        return method === "GET" ? html(guidePage(viewer, renderGuide())) : methodNotAllowed();

      case KIT_GUIDE_PATH:
        if (!viewer) return redirect("/");
        return method === "GET"
          ? html(
              guidePage(
                viewer,
                renderMarkdown(reportKitGuide, {
                  path: "docs/report-kit.md",
                  // Its links point at La Fabrique's own addresses.
                  isPage: (candidate) => candidate.startsWith("kit/") || candidate.startsWith("guide/"),
                  pageUrl: (candidate) => `/${candidate}`,
                  githubUrl: () => KIT_GUIDE_PATH,
                }),
              ),
            )
          : methodNotAllowed();

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
        const params = new URL(request.url).searchParams;
        return html(
          settingsPage(viewer, {
            version: onlineVersion(),
            commit: env.COMMIT_SHA,
            notice: params.get("notice"),
            claude: {
              settings: claudeSettings(env),
              report: await usageReport(env.DB, viewer.login),
              failure: params.get("notice") === "claude_failed" ? (params.get("reason") ?? "Claude did not answer.").slice(0, 300) : null,
            },
          }),
        );
      }

      // A tiny call to Claude, to check the key and the model: super admin.
      case CLAUDE_CHECK_PATH: {
        if (method !== "POST") return methodNotAllowed();
        if (!viewer) return redirect("/");
        if (viewer.role !== "super_admin") return forbidden(viewer);
        if (!(await protectedForm(request, viewer))) return forbidden(viewer);
        if (!claudeSettings(env).configured) return redirect(`${SETTINGS_PATH}#claude`);
        const outcome = await checkKey(env, viewer.login);
        return redirect(
          outcome.ok
            ? `${SETTINGS_PATH}?notice=claude_ok#claude`
            : `${SETTINGS_PATH}?notice=claude_failed&reason=${encodeURIComponent(outcome.message ?? "")}#claude`,
        );
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

      case WHATS_NEW_PATH: {
        if (!viewer) return redirect("/");
        if (method !== "GET") return methodNotAllowed();
        return html(whatsNewPage(viewer, ownReleases(), await selfRepo(env.DB, new URL(request.url).origin)));
      }

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
      apiRoute: ["/api/me", "/api/projects/", MCP_PATH],
      apiHandler: {
        fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown }) {
          return api(request, env, ctx.props as GrantProps);
        },
      },
      defaultHandler: app,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
      // Claude registers itself (RFC 7591), as MCP clients do; it can only
      // ask for the `fabrique` scope (src/oauth.ts, authorizeMcp).
      clientRegistrationEndpoint: REGISTER_PATH,
      scopesSupported: [DEFECTS_SCOPE, TEST_SCOPE, MCP_SCOPE],
      resourceMetadata: { resource: origin, resource_name: "La Fabrique extraordinaire" },
      accessTokenTTL: ACCESS_TOKEN_TTL,
      refreshTokenTTL: REFRESH_TOKEN_TTL,
      // Claude Code registers as a public client (PKCE, no secret).
      disallowPublicClientRegistration: false,
      // A refusal (expired code, wrong secret, revoked token) leaves a line
      // in the Worker's logs, without any token or secret.
      onError({ code, description, status, request }) {
        console.warn(`OAuth ${status} ${code} on ${request ? new URL(request.url).pathname : "?"}: ${description}`);
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

// An MCP client may name the MCP server's own address as the resource
// (RFC 8707: `resource=https://…/mcp`); the tokens are bound to the
// Worker's origin, which covers it. Read as the origin.
async function mcpResourceAsOrigin(request: Request, origin: string): Promise<Request> {
  const mcp = `${origin}${MCP_PATH}`;
  const same = (value: string) => value.replace(/\/+$/, "") === mcp;
  const url = new URL(request.url);
  let changed = false;
  const resources = url.searchParams.getAll("resource");
  if (resources.some(same)) {
    url.searchParams.delete("resource");
    for (const value of resources) url.searchParams.append("resource", same(value) ? origin : value);
    changed = true;
  }
  let body: string | null = null;
  if (request.method === "POST" && (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    body = await request.clone().text();
    const params = new URLSearchParams(body);
    const inBody = params.getAll("resource");
    if (inBody.some(same)) {
      params.delete("resource");
      for (const value of inBody) params.append("resource", same(value) ? origin : value);
      body = params.toString();
      changed = true;
    }
  }
  if (!changed) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(url.href, { method: request.method, headers, ...(request.method === "POST" ? { body: body ?? (await request.text()) } : {}) });
}

const PNG_BYTES = new Map<string, Uint8Array>();

function png(size: string): Response {
  let bytes = PNG_BYTES.get(size);
  if (!bytes) {
    bytes = Uint8Array.from(atob(ICON_PNGS[size] ?? ""), (char) => char.charCodeAt(0));
    PNG_BYTES.set(size, bytes);
  }
  return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}

function withSecurityHeaders(response: Response): Response {
  if (response.headers.has("content-security-policy") || response.status === 101) return response;
  const copy = new Response(response.body, response);
  applySecurityHeaders(copy.headers);
  return copy;
}

// Claude's background jobs (src/jobs.ts) and the object that pushes their
// progress to the card's open pages.
export { CardLive } from "./live";
export { SprintRun } from "./sprint-run";

export default {
  async queue(batch: MessageBatch<{ job: number }>, env: Env): Promise<void> {
    await consumeJobs(batch, env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setCommit(env.COMMIT_SHA);
    const oauthEnv: Env = { ...env, OAUTH_KV: d1KeyValue(env.DB) };
    const { pathname, origin } = new URL(request.url);
    const provider = providerFor(origin);
    if (pathname === REVOKE_PATH) return withSecurityHeaders(await revoke(request, provider, oauthEnv, ctx));
    if (pathname === AUTHORIZE_PATH || pathname === TOKEN_PATH) request = await mcpResourceAsOrigin(request, origin);
    const response = await provider.fetch(request, oauthEnv, ctx);
    if (pathname === DISCOVERY_PATH && request.method === "GET") return discovery(response, request);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env, { job: number }>;
