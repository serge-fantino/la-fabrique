import { effectiveRole } from "./accounts";
import { finishLogin, startLogin } from "./auth";
import { safeEqual } from "./crypto";
import type { Env } from "./env";
import { css, html, json, redirect, text } from "./http";
import { changePeople, showPeople } from "./people";
import { createProject, recheckProject, showNewProject, showProject, showProduction, showProjects, showStories } from "./project-routes";
import { isRepoName } from "./projects";
import { handleWebhook } from "./webhook";
import { showDoc } from "./docs";

const PROJECT_ROUTE = /^\/projects\/([^/]+\/[^/]+?)(\/check|\/stories|\/production)?$/;
const DOC_ROUTE = /^\/projects\/([^/]+\/[^/]+)\/docs\/(.+)$/;
import { destroySession, readSession } from "./session";
import { homePage, messagePage, noAccessPage, type Viewer } from "./views";
import stylesCss from "../site/styles.css";

type ViewerState = { kind: "anonymous" } | { kind: "revoked" } | { kind: "signed_in"; viewer: Viewer };

async function currentViewer(request: Request, env: Env): Promise<ViewerState> {
  const session = await readSession(request, env.DB);
  if (!session) return { kind: "anonymous" };
  const role = await effectiveRole(env, session.login);
  if (!role) return { kind: "revoked" };
  return { kind: "signed_in", viewer: { login: session.login, role, csrfToken: session.csrfToken } };
}

// Every state-changing request carries the session's CSRF token in its form.
async function protectedForm(request: Request, viewer: Viewer): Promise<FormData | null> {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    switch (pathname) {
      case "/api/version":
        return json({ commit: env.COMMIT_SHA });
      case "/styles.css":
        return css(stylesCss);
      case "/auth/login":
        return method === "GET" ? startLogin(request, env) : methodNotAllowed();
      case "/auth/callback":
        return method === "GET" ? finishLogin(request, env) : methodNotAllowed();
      case "/no-access":
        return html(noAccessPage());
      case "/api/github/webhook":
        return method === "POST" ? handleWebhook(request, env) : methodNotAllowed();
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
      return showDoc(env, viewer, repo, path);
    }

    const projectRoute = PROJECT_ROUTE.exec(pathname);
    if (projectRoute) {
      const repo = projectRoute[1] ?? "";
      if (!viewer) return redirect("/");
      if (!isRepoName(repo)) return html(messagePage("Not found", "There is nothing at this address.", viewer), { status: 404 });
      if (!projectRoute[2]) return method === "GET" ? showProject(request, env, viewer, repo) : methodNotAllowed();
      if (projectRoute[2] === "/production") {
        return method === "GET" ? showProduction(env, viewer, repo) : methodNotAllowed();
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
        return viewer ? showProjects(env, viewer) : html(homePage());

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
