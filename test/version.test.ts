import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /api/version", () => {
  it("returns the deployed commit as JSON", async () => {
    const response = await SELF.fetch("https://la-fabrique.test/api/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as { commit: string };
    expect(body.commit).toBe("test-commit");
  });
});
