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

describe("The (i) next to the name", () => {
  it("says when the running version was deployed while changes wait for the release, then the release they follow", async () => {
    const { buildInfo, setCommit } = await import("../src/build");
    setCommit("abc1234", "2026-11-04 16:48");
    const info = buildInfo();
    const { layout } = await import("../src/views");
    const page = layout("Test", "<p>x</p>", { login: "someone", role: "super_admin", csrfToken: "t" });
    if (info.waiting) {
      expect(page).toContain('Deployed <span class="mono">2026-11-04 16:48</span> (Paris)');
      expect(page).toContain(`${info.version?.split(" ")[0]} released <span class="mono">${info.date}`);
    } else {
      expect(page).not.toContain("Deployed");
      expect(page).toContain(`Released <span class="mono">${info.date}`);
    }
  });
});

