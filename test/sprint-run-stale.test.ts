import { describe, expect, it } from "vitest";
import { runOfSprint, type RunState } from "../src/sprint-run";

const run = (startedAt: string, status: RunState["status"] = "done"): RunState => ({
  repo: "o/r",
  startedBy: "a",
  startedAt,
  status,
  cards: [{ id: 77 } as never],
});

describe("runOfSprint", () => {
  it("shows no previous card for a sprint started after a finished run", () => {
    expect(runOfSprint(run("2026-11-16T10:00:00.000Z"), { startedAt: "2026-11-17T09:00:00.000Z" })).toBeNull();
    expect(runOfSprint(run("2026-11-16T10:00:00.000Z", "running"), { startedAt: "2026-11-17T09:00:00.000Z" })).toBeNull();
  });
  it("keeps the run of the sprint in progress", () => {
    const state = run("2026-11-17T10:00:00.000Z", "running");
    expect(runOfSprint(state, { startedAt: "2026-11-17T09:00:00.000Z" })).toBe(state);
  });
  it("shows nothing without a sprint", () => {
    expect(runOfSprint(run("2026-11-17T10:00:00.000Z"), null)).toBeNull();
  });
});
