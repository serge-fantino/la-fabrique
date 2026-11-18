import { describe, expect, it } from "vitest";
import { get } from "./helpers";

// The sprint's list refreshes the lines an event concerns (la-fabrique#374).
describe("sprint list live refresh", () => {
  it("serves a script that replaces lines in list mode, waits while typing and keeps the unfolded detail", async () => {
    const script = await (await get("/fabrique.js")).text();
    expect(script).toContain("function refreshLines");
    expect(script).toContain("if (typing() ||");
    expect(script).toContain('.sprint-views[data-mode="list"]');
    expect(script).toContain('querySelector(".sprint-head")');
    expect(script).toContain("[data-story-line]");
  });
});
