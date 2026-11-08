import { describe, expect, it } from "vitest";
import type { Card } from "../src/cards";
import { dependencyFirst, dependencyNotes } from "../src/sprint-dependencies";

const card = (id: number, epic: string | null = null) => ({ id, epic, archivedAt: null }) as unknown as Card;
const depends = (from: number, on: number) => ({ card_id: from, kind: "depends", ref: String(on) });

describe("dependency first in the sprint", () => {
  it("launches C74 before C90 and leaves the manual order alone", () => {
    const manual = [card(90), card(5), card(74)];
    const links = [depends(90, 74)];
    expect(dependencyFirst(manual, links).map((c) => c.id)).toEqual([74, 90, 5]);
    expect(manual.map((c) => c.id)).toEqual([90, 5, 74]);
  });
  it("ignores a dependency outside the sprint", () => {
    expect(dependencyFirst([card(90), card(5)], [depends(90, 74)]).map((c) => c.id)).toEqual([90, 5]);
  });
  it("follows an epic dependency and survives a loop", () => {
    const cards = [card(1), card(2, "E")];
    expect(dependencyFirst(cards, [{ card_id: 1, kind: "depends_epic", ref: "E" }]).map((c) => c.id)).toEqual([2, 1]);
    expect(dependencyFirst([card(1), card(2)], [depends(1, 2), depends(2, 1)])).toHaveLength(2);
  });
  it("says After, stopped and the order warning", () => {
    const notes = dependencyNotes([card(90), card(74)], [depends(90, 74)], new Set([74]));
    expect(notes.get(90)).toEqual({ after: [74], stopped: [74], below: [74] });
    expect(notes.has(74)).toBe(false);
  });
});
