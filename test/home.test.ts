import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /", () => {
  it("serves the home page with security headers", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/");
    expect(response.status).toBe(200);

    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");

    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");

    const body = await response.text();
    expect(body).toContain("<title>La Fabrique</title>");
    expect(body).not.toMatch(/<script\b/i);
  });
});
