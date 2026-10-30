import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /", () => {
  it("serves the home page with security headers and no script", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");

    const body = await response.text();
    expect(body).toContain("<title>La Fabrique extraordinaire</title>");
    expect(body).toContain('href="/auth/login"');
    expect(body).not.toMatch(/<script\b/i);
  });

  it("shows only the no-access page to an account without a role", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/no-access");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No access yet");
  });
});
