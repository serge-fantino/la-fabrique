import { describe, expect, it } from "vitest";
import type { CardStory } from "../src/card-stories";
import { nextAction, type NextInput } from "../src/sprint-list";

const story = (number: number, over: Partial<CardStory> = {}): CardStory => ({ number, title: `S${number}`, stage: "backlog", closed: false, criteria: [], priority: null, missing: [], pulls: [], ...over });

function input(stories: CardStory[], nice: number[] = [], over: Partial<NextInput> = {}): NextInput {
  return {
    stories: stories.map((s) => ({ number: s.number, nice: nice.includes(s.number) })),
    byNumber: new Map(stories.map((s) => [s.number, s])),
    held: new Map(),
    running: new Set(),
    canMerge: () => true,
    canLaunch: true,
    ...over,
  };
}

describe("the next action of a feature in the sprint list", () => {
  it("tests first, then merges, launches, prepares", () => {
    const test = story(1, { stage: "to_validate" });
    const merge = story(2, { stage: "in_dev", pulls: [{ number: 9, url: "u", state: "open" }] });
    const ready = story(3, { stage: "ready" });
    const prep = story(4);
    expect(nextAction(input([prep, ready, merge, test]))).toEqual({ kind: "test", story: 1 });
    expect(nextAction(input([prep, ready, merge]))).toEqual({ kind: "merge", story: 2, pull: 9 });
    expect(nextAction(input([prep, ready]))).toEqual({ kind: "launch", story: 3 });
    expect(nextAction(input([prep]))).toEqual({ kind: "prepare", story: 4 });
  });

  it("does not launch a story held by another of the feature, and says why", () => {
    const busy = story(215, { stage: "in_dev" });
    const waiting = story(216, { stage: "ready" });
    const held = new Map([[216, { story: 215, claude: true, pull: null }]]);
    expect(nextAction(input([busy, waiting], [], { held, running: new Set([215]) }))).toEqual({ kind: "none", reason: "#216 waits for #215" });
  });

  it("offers nice to have stories only when nothing else is left", () => {
    const nice = story(5, { stage: "ready" });
    const needed = story(6, { stage: "backlog" });
    expect(nextAction(input([nice, needed], [5]))).toEqual({ kind: "prepare", story: 6 });
    expect(nextAction(input([nice], [5]))).toEqual({ kind: "launch", story: 5 });
  });

  it("says why there is none", () => {
    const validated = story(224, { stage: "to_validate", validated: { by: "a", at: "t" } });
    expect(nextAction(input([validated]))).toEqual({ kind: "none", reason: "#224 validated, waits for the go" });
    const done = story(1, { stage: "done", closed: true });
    expect(nextAction(input([done], [], { shipped: "Shipped in 1.173" }))).toEqual({ kind: "none", reason: "Shipped in 1.173" });
  });
});
