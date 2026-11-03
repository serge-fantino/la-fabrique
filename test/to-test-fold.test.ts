import { describe, expect, it } from "vitest";
import type { ProductionStatus } from "../src/production";
import { toTestContent } from "../src/to-test-views";
import type { StoryChecks } from "../src/validation";

// To test folds the validated stories away by default (la-fabrique#220),
// and its forms say they are being sent.
const REPO = "acme/widget";
const story = (number: number) => ({
  number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, author: null, labels: [], parent: null,
  subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [{ text: "Works", done: true }],
});
const status: ProductionStatus = {
  production: "main", integration: "integration", integrationHead: "abc", aheadBy: 2,
  groups: [{ branch: "feature/1", title: "", mergedAt: "2026-11-03T08:00:00Z", commits: [], issues: [1, 2] }],
  workflows: [], versions: [], waiting: [], ready: true, blockers: [],
};

describe("To test (la-fabrique#220)", () => {
  it("folds the validated stories away, and counts only those left to test", () => {
    const checks = new Map<number, StoryChecks>([[2, { validated: { by: "tess", at: "2026-11-03 09:00:00", version: "1.173" }, defects: [], feedbacks: [] } as unknown as StoryChecks]]);
    const content = toTestContent({ repo: REPO, installationId: 99, addedAt: "", addedBy: "", check: null }, {
      status,
      stories: [story(1), story(2)] as never,
      environment: null,
      latest: null,
      actions: { viewer: { login: "tess", role: "tester", csrfToken: "x" }, base: `/projects/${REPO}`, canValidate: true, checks },
    });
    expect(content).toContain("<strong>1 story and 0 changes to test</strong> (1 already validated)");
    const [open, folded] = content.split('<details class="validated-stories">');
    expect(open).toContain('id="story-1"');
    expect(open).not.toContain('id="story-2"');
    expect(folded).toContain("<summary>1 validated story, hidden</summary>");
    expect(folded).toContain('id="story-2"');
    expect(content).toContain('data-busy="Validating…"');
  });
});
