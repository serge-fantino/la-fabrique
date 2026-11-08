import { describe, expect, it } from "vitest";
import { dependencyWarnings } from "../src/dependency-warnings";
import type { Card } from "../src/cards";

const mk = (id: number, extra: Partial<Card> = {}): Card =>
  ({ id, repo: "a/b", kind: "feature", status: "validated", progress: "in_production", epic: null, release: null, archivedAt: null, title: `T${id}`, ...extra }) as unknown as Card;
const dep = (card_id: number, ref: string) => ({ card_id, kind: "depends", ref });
const depEpic = (card_id: number, ref: string) => ({ card_id, kind: "depends_epic", ref });

describe("dependencyWarnings", () => {
  it("warns on a feature not in production, with its state", () => {
    const cards = [mk(90, { status: "draft", progress: null }), mk(74, { progress: "in_dev" })];
    const w = dependencyWarnings(cards[0]!, cards, [dep(90, "74")]);
    expect(w).toEqual([{ name: "C74", card: 74, state: "In development" }]);
  });
  it("does not warn when it is in production (nice to have left is ignored by the status)", () => {
    const cards = [mk(90), mk(74)];
    expect(dependencyWarnings(cards[0]!, cards, [dep(90, "74")])).toEqual([]);
  });
  it("warns on an epic with a feature not in production, ignoring dropped ones", () => {
    const cards = [mk(90), mk(1, { epic: "E", progress: "to_test" }), mk(2, { epic: "E" }), mk(3, { epic: "E", status: "dropped", progress: null })];
    expect(dependencyWarnings(cards[0]!, cards, [depEpic(90, "E")])).toEqual([{ name: "epic E", state: "1 of 2 features in production" }]);
    expect(dependencyWarnings(cards[0]!, cards.filter((c) => c.id !== 1), [depEpic(90, "E")])).toEqual([]);
  });
  it("skips a dependency in the same release only when asked", () => {
    const cards = [mk(90, { release: "Next release" }), mk(74, { status: "draft", progress: null, release: "Next release" })];
    expect(dependencyWarnings(cards[0]!, cards, [dep(90, "74")], { sameRelease: true })).toEqual([]);
    expect(dependencyWarnings(cards[0]!, cards, [dep(90, "74")])).toHaveLength(1);
  });
});
