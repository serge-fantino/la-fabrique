import type { Env } from "./env";
import { withSecurityHeaders } from "./headers";
import homeHtml from "../site/index.html";
import stylesCss from "../site/styles.css";

function json(data: unknown, init?: ResponseInit): Response {
  const response = new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
  return withSecurityHeaders(response);
}

function html(body: string): Response {
  const response = new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  return withSecurityHeaders(response);
}

function css(body: string): Response {
  const response = new Response(body, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
  return withSecurityHeaders(response);
}

function notFound(): Response {
  return withSecurityHeaders(
    new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/version") {
      return json({ commit: env.COMMIT_SHA });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return html(homeHtml);
    }

    if (url.pathname === "/styles.css") {
      return css(stylesCss);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
