import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("security headers", () => {
  it("sets a strict CSP: scripts only from this origin, never inline or remote", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/api/version");
    const csp = response.headers.get("content-security-policy");

    expect(csp).not.toBeNull();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("sets the baseline security headers", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/api/version");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=",
    );
  });
});
