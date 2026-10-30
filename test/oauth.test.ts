import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const RETURN = "https://widget-int.example.com/auth/fabrique/retour";
const LOCAL_RETURN = "http://localhost:8787/auth/fabrique/retour";
const VERIFIER = "a-code-verifier-long-enough-to-be-accepted-by-pkce-0123456789";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function addProject(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', ?, ?, '[]', '[]')",
    ).bind(REPO, "1".repeat(40), JSON.stringify({ nom: "The Widget" })),
  ]);
}

// The super admin registers the project's app, as the owner does.
async function registerApp(): Promise<{ clientId: string; clientSecret: string }> {
  const { cookie, csrf } = await signIn("admin-one");
  const response = await post(
    "/apps",
    { csrf, action: "register", name: "Widget app", repo: REPO, redirect_uris: `${RETURN}\n${LOCAL_RETURN}` },
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

async function authorizePath(clientId: string, scope = "defects:report", redirect = RETURN): Promise<string> {
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

function mockRepoAccess(status = 200): void {
  fetchMock.get("https://api.github.com").intercept({ method: "GET", path: `/repos/${REPO}` }).reply(status, JSON.stringify({ full_name: REPO }), {
    headers: { "content-type": "application/json" },
  });
}

function mockUser(login: string): void {
  fetchMock
    .get("https://api.github.com")
    .intercept({ method: "GET", path: "/user" })
    .reply(200, JSON.stringify({ login, id: 7, name: "Mona Tester", avatar_url: "https://avatars.example.com/u/7" }), {
      headers: { "content-type": "application/json" },
    });
}

function token(fields: Record<string, string>, path = "/oauth/token"): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function me(accessToken: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

// The whole flow for an account without a role, which only has to see the
// repository on GitHub.
async function connect(login = "mona"): Promise<{ app: { clientId: string; clientSecret: string }; tokens: Tokens; cookie: string; csrf: string }> {
  await addProject();
  const app = await registerApp();
  const { cookie, csrf } = await signIn(login);
  const path = await authorizePath(app.clientId);

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

describe("Registering a project's app", () => {
  it("is for the super admin, shows the secret once, and lists the app with its return addresses", async () => {
    await addProject();
    const { clientId, clientSecret } = await registerApp();
    const { cookie } = await signIn("admin-one");
    const page = await (await get("/apps", cookie)).text();
    expect(page).toContain("Widget app");
    expect(page).toContain(clientId);
    expect(page).toContain(RETURN);
    expect(page).toContain(LOCAL_RETURN);
    expect(page).not.toContain(clientSecret);
    const row = await env.DB.prepare("SELECT repo, created_by FROM oauth_apps WHERE client_id = ?").bind(clientId).first();
    expect(row).toEqual({ repo: REPO, created_by: "admin-one" });
    expect(JSON.stringify(await logActions())).not.toContain(clientSecret);

    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    const refused = await post("/apps", { csrf: tester.csrf, action: "register", name: "X", repo: REPO, redirect_uris: RETURN }, tester.cookie);
    expect(refused.status).toBe(403);
    expect(await (await get("/apps", tester.cookie)).text()).not.toContain("Register an app");
  });

  it("refuses a plain http return address outside this machine", async () => {
    await addProject();
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post("/apps", { csrf, action: "register", name: "X", repo: REPO, redirect_uris: "http://example.com/cb" }, cookie);
    expect(response.headers.get("location")).toBe("/apps?notice=invalid");
  });
});

describe("Discovery", () => {
  it("names the contract's endpoints and its single scope", async () => {
    const response = await get("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata["authorization_endpoint"]).toBe(`${BASE}/oauth/authorize`);
    expect(metadata["token_endpoint"]).toBe(`${BASE}/oauth/token`);
    expect(metadata["revocation_endpoint"]).toBe(`${BASE}/oauth/revoke`);
    expect(metadata["scopes_supported"]).toEqual(["defects:report"]);
    expect(metadata["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(metadata["registration_endpoint"]).toBeUndefined();
  });
});

describe("Connecting an app", () => {
  it("sends a signed-out person to GitHub, then back to the consent page", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const path = await authorizePath(clientId);
    const response = await get(path);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent(path)}`);

    const login = await get(response.headers.get("location") ?? "");
    const cookies = login.headers.getAll("set-cookie").join("\n");
    expect(cookies).toContain(`__Host-lf_next=${encodeURIComponent(path)}`);
  });

  it("lets an account without a role sign in for the consent page only", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const path = await authorizePath(clientId);
    const login = await get(`/auth/login?next=${encodeURIComponent(path)}`);
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
    fetchMock
      .get("https://github.com")
      .intercept({ method: "POST", path: "/login/oauth/access_token" })
      .reply(200, JSON.stringify({ access_token: "ghu_x", expires_in: 28800, token_type: "bearer" }), {
        headers: { "content-type": "application/json" },
      });
    mockUser("Mona");
    const callback = await get(
      `/auth/callback?code=abc&state=${state}`,
      `__Host-lf_oauth_state=${state}; __Host-lf_next=${encodeURIComponent(path)}`,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(path);
    const session = callback.headers.getAll("set-cookie").find((cookie) => cookie.startsWith("__Host-lf_session="))?.split(";")[0] ?? "";
    expect(session).not.toBe("");
    expect(await logActions()).not.toContainEqual(expect.objectContaining({ action: "access_requested" }));

    // The rest of La Fabrique still turns the account away.
    const home = await get("/projects", session);
    expect(home.headers.get("location")).toBe("/no-access");
  });

  it("asks consent with the contract's wording, letting the form end on the app", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const { cookie } = await signIn("mona");
    mockRepoAccess();
    const response = await get(await authorizePath(clientId), cookie);
    const page = await response.text();
    expect(page).toContain("<strong>Widget app</strong> will be able to report defects in your name on <strong>The Widget</strong>.");
    expect(page).toContain("no role in La Fabrique: your reports will be triaged");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://widget-int.example.com");
  });

  it("refuses an account that cannot see the repository", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const { cookie } = await signIn("stranger");
    mockRepoAccess(404);
    const response = await get(await authorizePath(clientId), cookie);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("cannot see acme/widget");
  });

  it("does not ask GitHub for a person with a role", async () => {
    await addProject();
    const { clientId } = await registerApp();
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    const response = await get(await authorizePath(clientId), cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Tester");
  });

  it("sends a refusal back to the app", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const { cookie, csrf } = await signIn("tess-two");
    await grantRole("tess-two", "tester");
    const path = await authorizePath(clientId);
    const response = await post(path, { csrf, decision: "deny" }, cookie);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("refuses a scope other than defects:report, and a form without its token", async () => {
    await addProject();
    const { clientId } = await registerApp();
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    const wide = await get(await authorizePath(clientId, "defects:report repo"), cookie);
    expect(new URL(wide.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_scope");
    const forged = await post(await authorizePath(clientId), { csrf: "wrong", decision: "allow" }, cookie);
    expect(forged.status).toBe(403);
  });

  it("refuses an unregistered return address without going there", async () => {
    await addProject();
    const { clientId } = await registerApp();
    const response = await get(await authorizePath(clientId, "defects:report", "https://evil.example.com/cb"));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("Tokens and /api/me", () => {
  it("gives tokens for an hour and thirty days, and /api/me as the contract says", async () => {
    const { tokens } = await connect();
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("defects:report");
    expect(tokens.refresh_token).toBeTruthy();

    const response = await me(tokens.access_token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      login: "mona",
      name: "Mona Tester",
      avatar_url: "https://avatars.example.com/u/7",
      project: { id: "widget", role: null },
      can: { report_defect: true },
    });
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "mona", action: "app_connected" }));
  });

  it("reads the role live", async () => {
    const { tokens } = await connect();
    await grantRole("mona", "product_engineer");
    expect(((await (await me(tokens.access_token)).json()) as { project: { role: string } }).project.role).toBe("product_engineer");
  });

  it("refuses a missing or wrong token, and a wrong client secret", async () => {
    expect((await SELF.fetch(`${BASE}/api/me`)).status).toBe(401);
    expect((await me("mona:abc:def")).status).toBe(401);
    const { app } = await connect();
    const response = await token({ grant_type: "refresh_token", refresh_token: "x", client_id: app.clientId, client_secret: "wrong" });
    expect(response.status).toBe(401);
  });

  it("refreshes, then revokes at /oauth/revoke: the API answers 401", async () => {
    const { app, tokens } = await connect();
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect((await me(next.access_token)).status).toBe(200);

    const revoked = await token(
      { token: next.refresh_token, token_type_hint: "refresh_token", client_id: app.clientId, client_secret: app.clientSecret },
      "/oauth/revoke",
    );
    expect(revoked.status).toBe(200);
    expect((await me(next.access_token)).status).toBe(401);
  });

  it("does not take a grant at /oauth/revoke", async () => {
    const response = await token({ grant_type: "refresh_token", refresh_token: "x" }, "/oauth/revoke");
    expect(response.status).toBe(400);
  });

  it("lets the person disconnect the app from Connected apps", async () => {
    const { tokens, cookie, csrf } = await connect();
    const page = await (await get("/apps", cookie)).text();
    expect(page).toContain("Widget app");
    expect(page).toContain("without a role in La Fabrique");
    const grant = /name="grant" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const response = await post("/apps", { csrf, action: "revoke", grant }, cookie);
    expect(response.headers.get("location")).toBe("/apps?notice=revoked");
    expect((await me(tokens.access_token)).status).toBe(401);
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "mona", action: "app_disconnected" }));
  });

  it("revokes every connection when the super admin removes the app", async () => {
    const { app, tokens } = await connect();
    const admin = await signIn("admin-one");
    const response = await post("/apps", { csrf: admin.csrf, action: "remove", client: app.clientId }, admin.cookie);
    expect(response.headers.get("location")).toBe("/apps?notice=removed");
    expect((await me(tokens.access_token)).status).toBe(401);
  });
});
