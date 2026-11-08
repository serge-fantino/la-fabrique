import { describe, expect, it } from "vitest";
import type { Card } from "../src/cards";
import { epicProgress, epicProgressSection, epicProgressSummary } from "../src/epic-progress";

let next = 10;
function feature(status: string, progress: string | null = null, extra: Partial<Card> = {}): Card {
  return { id: next++, repo: "acme/widget", kind: "feature", status, title: `F${next}`, epic: "Big epic", progress, archivedAt: null, ...extra } as unknown as Card;
}
const epic = { id: 1, title: "Big epic" };

describe("epic progress", () => {
  it("counts features by status in order, and omits absent ones", () => {
    const p = epicProgress(epic, [feature("shaping"), feature("draft"), feature("validated", "in_production"), feature("draft")]);
    expect(p.parts.map((part) => `${part.label}:${part.count}`)).toEqual(["Draft:2", "Shaping:1", "In production:1"]);
    expect(p.inProduction).toBe(1);
    expect(p.status).toBe("draft");
  });
  it("is Ready when all are at stories to prepare or beyond, In production when all are out", () => {
    expect(epicProgress(epic, [feature("validated", "to_prepare"), feature("validated", "in_production")]).status).toBe("ready");
    expect(epicProgress(epic, [feature("validated", "in_production")]).status).toBe("in_production");
  });
  it("ignores dropped, other epics and dependencies; lists archived apart", () => {
    const p = epicProgress(epic, [
      feature("dropped"),
      feature("draft", null, { epic: "Other" }),
      feature("validated", "in_production", { archivedAt: "2026-01-01" }),
      feature("validated", "ready"),
    ]);
    expect(p.features).toHaveLength(1);
    expect(p.archived).toHaveLength(1);
    expect(p.status).toBe("ready");
    const html = epicProgressSection(p);
    expect(html).toContain("Archives");
    expect(html).toContain("0/1");
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain("stories");
  });
  it("shows an empty progress without features", () => {
    const p = epicProgress(epic, []);
    expect(p.status).toBeNull();
    expect(epicProgressSection(p)).toContain("No features yet");
  });
  it("lists shipped versions oldest first and the features left", () => {
    const a = feature("validated", "in_production");
    const b = feature("validated", "ready");
    const c = feature("validated", "in_production");
    const progresses = new Map([
      [a.id, { shipped: { versions: ["0.82", "0.80"], left: [], nice: [] } }],
      [c.id, { shipped: { versions: ["0.81"], left: [], nice: [] } }],
    ]) as never;
    const p = epicProgress(epic, [a, b, c], progresses);
    expect(p.shipped?.versions).toEqual(["0.80", "0.81", "0.82"]);
    expect(p.shipped?.left.map((card) => card.id)).toEqual([b.id]);
    const html = epicProgressSection(p);
    expect(html).toContain("Shipped in");
    expect(html).toContain("Still to come");
    expect(epicProgress(epic, [b]).shipped).toBeUndefined();
  });
  it("renders the same bar, counts and status on the page, in the Epics tab and in a lane header", () => {
    const p = epicProgress(epic, [feature("draft"), feature("validated", "in_production")]);
    const summary = epicProgressSummary(p);
    expect(epicProgressSection(p)).toContain(summary);
    const compact = epicProgressSummary(p, true);
    for (const part of ["Epic status", "1/2", "Draft: 1 feature", 'tabindex="0"', "epic-bar compact"]) expect(compact).toContain(part);
  });
});
