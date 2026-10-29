import { effectiveRole, normalizeLogin } from "./accounts";
import { activityStatement } from "./activity-log";
import { randomToken } from "./crypto";
import type { Env } from "./env";
import { exchangeCode, fetchUser } from "./github";
import { clearHostCookie, hostCookie, html, readCookie, redirect } from "./http";
import { createSession } from "./session";
import { messagePage } from "./views";

const STATE_COOKIE = "__Host-lf_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/auth/callback`;
}

function notConfigured(): Response {
  return html(
    messagePage("Sign-in unavailable", "GitHub sign-in is not configured yet on this Worker."),
    { status: 503 },
  );
}

export function startLogin(request: Request, env: Env): Response {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) return notConfigured();

  const state = randomToken();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackUrl(request));
  authorize.searchParams.set("state", state);

  return redirect(authorize.toString(), [hostCookie(STATE_COOKIE, state, STATE_TTL_SECONDS)]);
}

export async function finishLogin(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) return notConfigured();

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = readCookie(request, STATE_COOKIE);
  const clearState = clearHostCookie(STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return html(
      messagePage("Sign-in expired", "This sign-in link is no longer valid. Please sign in again."),
      { status: 400, cookies: [clearState] },
    );
  }

  const tokens = await exchangeCode(
    env.GITHUB_APP_CLIENT_ID,
    env.GITHUB_APP_CLIENT_SECRET,
    code,
    callbackUrl(request),
  );
  const user = tokens ? await fetchUser(tokens.accessToken) : null;
  if (!tokens || !user) {
    return html(
      messagePage("Sign-in failed", "GitHub did not confirm your identity. Please try again."),
      { status: 502, cookies: [clearState] },
    );
  }

  const login = normalizeLogin(user.login);
  const role = await effectiveRole(env, login);
  if (!role) {
    await activityStatement(env.DB, {
      actor: login,
      action: "access_requested",
      details: { github_user_id: user.id },
    }).run();
    return redirect("/no-access", [clearState]);
  }

  const session = await createSession(env.DB, login, user.id, tokens);
  return redirect("/", [clearState, session.cookie]);
}
