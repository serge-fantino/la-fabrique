import { effectiveRole } from "./accounts";
import { finishLogin, startLogin } from "./auth";
import { safeEqual } from "./crypto";
import type { Env } from "./env";
import { css, html, json, redirect, text } from "./http";
import { changePeople, showPeople } from "./people";
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
    }

    const state = await currentViewer(request, env);
    if (state.kind === "revoked") {
      return redirect("/no-access", [await destroySession(request, env.DB)]);
    }
    const viewer = state.kind === "signed_in" ? state.viewer : undefined;

    switch (pathname) {
      case "/":
      case "/index.html":
        return html(homePage(viewer));

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
