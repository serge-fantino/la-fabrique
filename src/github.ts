import type { GitHubTokens } from "./session";

const USER_AGENT = "la-fabrique";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

function inSeconds(seconds: number | undefined): string | null {
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

// GitHub answers token errors with HTTP 200 and an `error` field.
async function requestToken(params: Record<string, string>): Promise<GitHubTokens | null> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as TokenResponse;
  if (data.error || !data.access_token) return null;
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: inSeconds(data.expires_in),
    refreshToken: data.refresh_token ?? null,
    refreshTokenExpiresAt: inSeconds(data.refresh_token_expires_in),
  };
}

export function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GitHubTokens | null> {
  return requestToken({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
}

export function refreshUserToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<GitHubTokens | null> {
  return requestToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export interface GitHubUser {
  login: string;
  id: number;
  name?: string | null;
  avatarUrl?: string | null;
}

export async function fetchUser(accessToken: string): Promise<GitHubUser | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { login?: unknown; id?: unknown; name?: unknown; avatar_url?: unknown };
  if (typeof data.login !== "string" || typeof data.id !== "number") return null;
  return {
    login: data.login,
    id: data.id,
    name: typeof data.name === "string" ? data.name : null,
    avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : null,
  };
}
