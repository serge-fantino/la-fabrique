import { env, SELF } from "cloudflare:test";
import type { Role } from "../src/accounts";
import { createSession } from "../src/session";

export const BASE = "https://la-fabrique.test";

export async function grantRole(login: string, role: Role): Promise<void> {
  await env.DB.prepare("INSERT INTO accounts (github_login, role) VALUES (?, ?)").bind(login, role).run();
}

export async function signIn(login: string): Promise<{ cookie: string; csrf: string }> {
  const session = await createSession(env.DB, login, 1, {
    accessToken: "gho_session_token",
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
  });
  return { cookie: session.cookie.split(";")[0] ?? "", csrf: session.csrfToken };
}

export function get(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

export function post(path: string, fields: Record<string, string>, cookie?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

export async function logActions(): Promise<{ actor: string; action: string; details: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT actor, action, details FROM activity_log ORDER BY id",
  ).all<{ actor: string; action: string; details: string | null }>();
  return results;
}
