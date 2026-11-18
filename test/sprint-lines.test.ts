import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The sprint's list refreshes the lines an event concerns (la-fabrique#374).
const script = readFileSync("site/fabrique.js", "utf8");
const views = readFileSync("src/sprint-views.ts", "utf8");

describe("sprint list live refresh", () => {
  it("marks each story line so it can be replaced alone", () => {
    expect(views).toContain('data-story-line="${number}"');
  });
  it("replaces lines in list mode, waits while typing, and keeps the unfolded detail", () => {
    expect(script).toContain("function refreshLines");
    expect(script).toContain("if (typing() ||");
    expect(script).toContain('.sprint-views[data-mode="list"]');
    expect(script).toContain('querySelector(".sprint-head")');
    expect(script).not.toMatch(/swap\([^)]*sl-unfold/);
  });
});
