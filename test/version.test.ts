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

describe("The version online", () => {
  it("is the last release plus the changes online since", async () => {
    const { onlineVersion } = await import("../src/build");
    const notes = [{ version: "next" }, { version: "next" }, { version: "next" }, { version: "0.78" }, { version: "0.77" }];
    expect(onlineVersion(notes)).toBe("0.78 + 3 changes");
    expect(onlineVersion(notes.slice(2))).toBe("0.78 + 1 change");
    expect(onlineVersion(notes.slice(3))).toBe("0.78");
  });
});
