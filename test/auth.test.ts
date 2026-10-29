import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions } from "./helpers";

const ACCESS_TOKEN = "ghu_secret_access_token";
const REFRESH_TOKEN = "ghr_secret_refresh_token";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function mockGitHub(login: string, id = 4242): void {
  fetchMock
    .get("https://github.com")
    .intercept({ method: "POST", path: "/login/oauth/access_token" })
    .reply(
      200,
      JSON.stringify({
        access_token: ACCESS_TOKEN,
        expires_in: 28800,
        refresh_token: REFRESH_TOKEN,
        refresh_token_expires_in: 15811200,
        token_type: "bearer",
      }),
      { headers: { "content-type": "application/json" } },
    );
  fetchMock
    .get("https://api.github.com")
    .intercept({ method: "GET", path: "/user" })
    .reply(200, JSON.stringify({ login, id }), {
      headers: { "content-type": "application/json" },
    });
}

async function startLogin(): Promise<{ state: string; stateCookie: string }> {
  const response = await get("/auth/login");
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("client_id")).toBe("Iv1.test-client");
  expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/callback`);
  const state = location.searchParams.get("state") ?? "";
  const setCookie = response.headers.getAll("set-cookie").join("\n");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  return { state, stateCookie: `__Host-lf_oauth_state=${state}` };
}

describe("GitHub sign-in", () => {
  it("signs in a listed person and keeps GitHub tokens out of responses and the log", async () => {
    await grantRole("product-person", "product_engineer");
    mockGitHub("Product-Person");
    const { state, stateCookie } = await startLogin();

    const callback = await get(`/auth/callback?code=abc&state=${state}`, stateCookie);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/");

    const cookies = callback.headers.getAll("set-cookie");
    const session = cookies.find((cookie) => cookie.startsWith("__Host-lf_session="));
    expect(session).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const everything = [...callback.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")
      + (await callback.text());
    expect(everything).not.toContain(ACCESS_TOKEN);
    expect(everything).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(await logActions())).not.toContain(ACCESS_TOKEN);

    const home = await get("/", session?.split(";")[0]);
    const page = await home.text();
    expect(page).toContain("@product-person");
    expect(page).toContain("Product Engineer");
    expect(page).not.toContain(ACCESS_TOKEN);
  });

  it("treats logins in SUPER_ADMINS as super admins", async () => {
    mockGitHub("admin-one");
    const { state, stateCookie } = await startLogin();
    const callback = await get(`/auth/callback?code=abc&state=${state}`, stateCookie);
    const session = callback.headers.getAll("set-cookie").find((c) => c.startsWith("__Host-lf_session="));

    const people = await get("/people", session?.split(";")[0]);
    expect(people.status).toBe(200);
  });

  it("sends an unlisted account to the no-access page and records the request", async () => {
    mockGitHub("stranger", 777);
    const { state, stateCookie } = await startLogin();

    const callback = await get(`/auth/callback?code=abc&state=${state}`, stateCookie);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/no-access");
    const cookies = callback.headers.getAll("set-cookie");
    expect(cookies.some((cookie) => cookie.startsWith("__Host-lf_session="))).toBe(false);

    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect(await logActions()).toEqual([
      { actor: "stranger", action: "access_requested", details: JSON.stringify({ github_user_id: 777 }) },
    ]);
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const response = await get("/auth/callback?code=abc&state=forged", "__Host-lf_oauth_state=other");
    expect(response.status).toBe(400);
  });
});
