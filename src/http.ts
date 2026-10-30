import { applySecurityHeaders } from "./headers";

interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  cookies?: string[];
}

function respond(body: string | null, options: ResponseOptions): Response {
  const headers = new Headers(options.headers);
  for (const cookie of options.cookies ?? []) {
    headers.append("set-cookie", cookie);
  }
  applySecurityHeaders(headers);
  return new Response(body, { status: options.status ?? 200, headers });
}

export function html(body: string, options: ResponseOptions = {}): Response {
  return respond(body, {
    ...options,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...options.headers,
    },
  });
}

export function css(body: string, headers: Record<string, string> = {}): Response {
  return respond(body, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-cache",
      ...headers,
    },
  });
}

export function script(body: string, headers: Record<string, string> = {}): Response {
  return respond(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      ...headers,
    },
  });
}

export function svg(body: string): Response {
  return respond(body, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    },
  });
}

export function json(data: unknown, options: ResponseOptions = {}): Response {
  return respond(JSON.stringify(data), {
    ...options,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...options.headers,
    },
  });
}

export function text(body: string, status: number): Response {
  return respond(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function redirect(location: string, cookies: string[] = [], headers: Record<string, string> = {}): Response {
  return respond(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", ...headers },
    cookies,
  });
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

// `__Host-` cookies must be Secure, Path=/ and carry no Domain.
export function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearHostCookie(name: string): string {
  return hostCookie(name, "", 0);
}
