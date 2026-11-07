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
  it("shows the marks in the preview of a kept story only", () => {
    expect(storyBlocks(data(true, [0]))).toContain("priority: low");
    expect(storyBlocks(data(true, []))).not.toContain("priority: low");
  });
});
