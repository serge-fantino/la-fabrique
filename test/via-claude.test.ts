import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { activityStatement } from "../src/activity-log";
import { describe as describeEntry } from "../src/log-views";
import { storyStatus } from "../src/stories-views";
import { storyChecks } from "../src/validation";

const REPO = "acme/shop-via";

describe("via Claude (la-fabrique#387)", () => {
  it("reads the mark of a validation and a feedback from the log, and only for MCP", async () => {
    await env.DB.batch([
      activityStatement(env.DB, { actor: "tess", action: "story_validated", repo: REPO, issueNumber: 1, details: { version: "1.1", via: "mcp" } }),
      activityStatement(env.DB, { actor: "tess", action: "story_validated", repo: REPO, issueNumber: 2, details: { version: "1.1" } }),
      activityStatement(env.DB, { actor: "tess", action: "story_feedback", repo: REPO, issueNumber: 3, details: { text: "Broken", via: "mcp" } }),
      activityStatement(env.DB, { actor: "tess", action: "story_feedback", repo: REPO, issueNumber: 3, details: { text: "Still broken" } }),
    ]);
    const checks = await storyChecks(env.DB, REPO);
    expect(checks.get(1)?.validated?.via).toBe("mcp");
    expect(checks.get(2)?.validated?.via).toBeUndefined();
    expect(checks.get(3)?.feedbacks?.map((feedback) => feedback.via)).toEqual(["mcp", undefined]);
  });

  it("says it in the status and in the log sentences, and not for a person", () => {
    const base = { stage: "on_int" as never, validated: { by: "tess", at: "2026-11-18T10:00:00" } };
    expect(storyStatus(base)).not.toContain("via Claude");
    expect(storyStatus({ ...base, validated: { ...base.validated, via: "mcp" } })).toContain("by @tess via Claude");
    const entry = (action: string, via?: string) => ({ id: 1, at: "2026-11-18 10:00:00", actor: "tess", action, issue: 5, details: { text: "x", steps: [], ...(via ? { via } : {}) } });
    for (const action of ["criterion_checked", "criterion_unchecked", "story_test_recorded", "story_validated", "story_feedback"]) {
      expect(describeEntry(entry(action, "mcp"), REPO), action).toContain("via Claude");
      expect(describeEntry(entry(action), REPO), action).not.toContain("via Claude");
    }
  });
});
