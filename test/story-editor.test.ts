import { describe, expect, it } from "vitest";
import { priorityLine, storyBlocks } from "../src/story-editor";

const priorityOf = (nice: boolean) => (nice ? "low" : "high");
const data = (nice: boolean, kept: number[]) => ({
  repo: "a/b",
  split: { stories: [{ title: "T", answers: {}, nice }] } as never,
  rubriques: [],
  kept: new Set(kept),
  bodies: ["body"],
  errors: {},
  priorityOf,
});

describe("story editor preview", () => {
  it("follows nice to have", () => {
    expect(priorityLine(false, priorityOf)).toContain("priority: high");
    expect(priorityLine(true, priorityOf)).toContain("Nice to have");
    expect(priorityLine(true, priorityOf)).toContain("priority: low");
    expect(priorityLine(false)).toContain("no priority");
  });
  it("shows the marks in the preview, and marks a story left out without dropping its preview (a box checked again needs it)", () => {
    expect(storyBlocks(data(true, [0]))).toContain("priority: low");
    const out = storyBlocks(data(true, []));
    expect(out).toContain('class="split-story left-out"');
    expect(out).toContain("priority: low");
  });
  it("folds each story to its title and context, unfolded on an error", () => {
    const rubriques = [{ cle: "contexte", titre: "Contexte", obligatoire: true }, { cle: "criteres", titre: "Critères", obligatoire: true }] as never;
    const split = { stories: [{ title: "Reprendre", answers: { contexte: "La semaine passée revient.", criteres: "- [ ] Un\n- [ ] Deux" } }] } as never;
    const html = storyBlocks({ ...data(false, [0]), rubriques, split, bodies: [""] });
    expect(html).toMatch(/<details class="split-body" data-split-body>\s*<summary>[\s\S]*Reprendre[\s\S]*<span class="split-context">La semaine passée revient\.<\/span>/);
    expect(html).toContain("+ Add a criterion");
    expect(html.match(/data-crit-grip/g)).toHaveLength(2);
    expect(storyBlocks({ ...data(false, [0]), rubriques, split, bodies: [""], errors: { 0: "Fill in: Title." } })).toContain('<details class="split-body" open data-split-body>');
  });
});
