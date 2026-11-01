import { env, fetchMock, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { BASE, get, post, signIn } from "./helpers";

// A project's app connected to La Fabrique, as in the contract with the
// épicerie (la-fabrique#65).
export const REPO = "acme/widget";
export const RETURN = "https://widget-int.example.com/auth/fabrique/retour";
export const LOCAL_RETURN = "http://localhost:8787/auth/fabrique/retour";
export const VERIFIER = "a-code-verifier-long-enough-to-be-accepted-by-pkce-0123456789";



export function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function challenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export const INT_URL = "https://widget-int.example.com";

export const CONFIG = {
  nom: "The Widget",
  langue: "en",
  environnements: {
    int: { url: INT_URL, version: "/api/version", type: "integration", signalement: true },
    production: { url: "https://widget.example.com", version: "/api/version", type: "production", signalement: false },
  },
};

export async function addProject(config: Record<string, unknown> = CONFIG): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', ?, ?, '[]', '[]')",
    ).bind(REPO, "1".repeat(40), JSON.stringify(config)),
  ]);
}

// The super admin registers the project's app, as the owner does.
export async function registerApp(): Promise<{ clientId: string; clientSecret: string }> {
  const { cookie, csrf } = await signIn("admin-one");
  const response = await post(
    `/projects/${REPO}/app`,
    { csrf, action: "register", name: "Widget app", redirect_uris: `${RETURN}\n${LOCAL_RETURN}` },
    cookie,
  );
  expect(response.status).toBe(200);
  const page = await response.text();
  const clientId = /<dt>client_id<\/dt><dd><code>([^<]+)<\/code>/.exec(page)?.[1] ?? "";
  const clientSecret = /<dt>client_secret<\/dt><dd><code>([^<]+)<\/code>/.exec(page)?.[1] ?? "";
  expect(clientId).not.toBe("");
  expect(clientSecret).not.toBe("");
  return { clientId, clientSecret };
}

export async function authorizePath(clientId: string, scope = "defects:report", redirect = RETURN): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope,
    state: "state-123",
    code_challenge: await challenge(VERIFIER),
    code_challenge_method: "S256",
  });
  return `/oauth/authorize?${query}`;
}

export function mockRepoAccess(status = 200): void {
  fetchMock.get("https://api.github.com").intercept({ method: "GET", path: `/repos/${REPO}` }).reply(status, JSON.stringify({ full_name: REPO }), {
    headers: { "content-type": "application/json" },
  });
}

export function mockUser(login: string): void {
  fetchMock
    .get("https://api.github.com")
    .intercept({ method: "GET", path: "/user" })
    .reply(200, JSON.stringify({ login, id: 7, name: "Mona Tester", avatar_url: "https://avatars.example.com/u/7" }), {
      headers: { "content-type": "application/json" },
    });
}

export function token(fields: Record<string, string>, path = "/oauth/token"): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

export function me(accessToken: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } });
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

// The whole flow for an account without a role, which only has to see the
// repository on GitHub.
export async function connect(login = "mona", config: Record<string, unknown> = CONFIG, scope = "defects:report"): Promise<{ app: { clientId: string; clientSecret: string }; tokens: Tokens; cookie: string; csrf: string }> {
  await addProject(config);
  const app = await registerApp();
  const { cookie, csrf } = await signIn(login);
  const path = await authorizePath(app.clientId, scope);

  mockRepoAccess();
  const consent = await get(path, cookie);
  expect(consent.status).toBe(200);

  mockRepoAccess();
  mockUser(login);
  const approved = await post(path, { csrf, decision: "allow" }, cookie);
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(RETURN);
  expect(location.searchParams.get("state")).toBe("state-123");
  const code = location.searchParams.get("code") ?? "";

  const response = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: RETURN,
    code_verifier: VERIFIER,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  expect(response.status).toBe(200);
  return { app, tokens: (await response.json()) as Tokens, cookie, csrf };
}

