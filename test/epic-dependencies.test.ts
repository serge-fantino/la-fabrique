import { describe, expect, it } from "vitest";
import { epicDependencies, epicDependenciesSection } from "../src/epic-dependencies";
import type { Card } from "../src/cards";

const card = (id: number, over: Partial<Card> = {}): Card =>
  ({ id, repo: "o/r", title: `T${id}`, kind: "feature", status: "draft", epic: null, archivedAt: null, data: {}, ...over }) as unknown as Card;

describe("epic dependencies", () => {
  const epicA = card(1, { kind: "epic", title: "Alpha" });
  const cards = [epicA, card(2, { epic: "Alpha" }), card(3, { epic: "Alpha" }), card(4, { epic: "Beta" }), card(5, { epic: "Beta" }), card(6, { epic: "Alpha" })];
  const links = [
    { card_id: 2, kind: "depends", ref: "4" },
    { card_id: 2, kind: "depends", ref: "3" },
    { card_id: 3, kind: "depends_epic", ref: "Gamma" },
    { card_id: 6, kind: "depends_epic", ref: "Alpha" },
  ];
  const deps = epicDependencies(epicA, cards, links);

  it("lists each feature's dependencies, other epics included", () => {
    const two = deps.features.find((f) => f.feature.id === 2)!;
    expect(two.dependsOn.map((d) => d.name)).toEqual(["C4", "C3"]);
    expect(two.dependsOn[0]!.epic).toBe("Beta");
  });
  it("derives the epics from both kinds of link, not its own", () => {
    expect(deps.epics).toEqual(["Beta", "Gamma"]);
  });
  it("renders the section", () => {
    const html = epicDependenciesSection(deps, () => null);
    expect(html).toContain("Depends on epics");
    expect(html).toContain("epic Gamma");
  });
});
