import { randomToken, sha256Hex } from "./crypto";
import { clearHostCookie, hostCookie, readCookie } from "./http";

export const SESSION_COOKIE = "__Host-lf_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface GitHubTokens {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
}

export interface Session {
  login: string;
  csrfToken: string;
}

export async function createSession(
  db: D1Database,
  login: string,
  githubUserId: number,
  tokens: GitHubTokens,
): Promise<{ cookie: string; csrfToken: string }> {
  const id = randomToken();
  const csrfToken = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
    db
      .prepare(
        `INSERT INTO sessions (id_hash, github_login, github_user_id, csrf_token,
           access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256Hex(id),
        login,
        githubUserId,
        csrfToken,
        tokens.accessToken,
        tokens.accessTokenExpiresAt,
        tokens.refreshToken,
        tokens.refreshTokenExpiresAt,
        expiresAt.toISOString(),
      ),
  ]);

  return { cookie: hostCookie(SESSION_COOKIE, id, SESSION_TTL_SECONDS), csrfToken };
}

export async function readSession(request: Request, db: D1Database): Promise<Session | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return null;
  const row = await db
    .prepare("SELECT github_login, csrf_token FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(id), new Date().toISOString())
    .first<{ github_login: string; csrf_token: string }>();
  return row ? { login: row.github_login, csrfToken: row.csrf_token } : null;
}

export async function destroySession(request: Request, db: D1Database): Promise<string> {
  const id = readCookie(request, SESSION_COOKIE);
  if (id) {
    await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(id)).run();
  }
  return clearHostCookie(SESSION_COOKIE);
}

export function destroySessionsOf(db: D1Database, login: string): D1PreparedStatement {
  return db.prepare("DELETE FROM sessions WHERE github_login = ?").bind(login);
}

interface StoredTokens {
  id_hash: string;
  access_token: string;
  access_token_expires_at: string | null;
  refresh_token: string | null;
  refresh_token_expires_at: string | null;
}

// The signed-in person's GitHub token, refreshed when it has expired.
// Null when GitHub no longer accepts the session's tokens.
export async function userToken(
  request: Request,
  db: D1Database,
  refresh: (refreshToken: string) => Promise<GitHubTokens | null>,
): Promise<string | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return null;
  const row = await db
    .prepare(
      `SELECT id_hash, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at
       FROM sessions WHERE id_hash = ?`,
    )
    .bind(await sha256Hex(id))
    .first<StoredTokens>();
  if (!row) return null;

  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  if (!row.access_token_expires_at || row.access_token_expires_at > soon) return row.access_token;
  if (!row.refresh_token || (row.refresh_token_expires_at && row.refresh_token_expires_at <= soon)) return null;

  const tokens = await refresh(row.refresh_token);
  if (!tokens) return null;
  await db
    .prepare(
      `UPDATE sessions SET access_token = ?, access_token_expires_at = ?, refresh_token = ?, refresh_token_expires_at = ?
       WHERE id_hash = ?`,
    )
    .bind(
      tokens.accessToken,
      tokens.accessTokenExpiresAt,
      tokens.refreshToken ?? row.refresh_token,
      tokens.refreshTokenExpiresAt ?? row.refresh_token_expires_at,
      row.id_hash,
    )
    .run();
  return tokens.accessToken;
}
