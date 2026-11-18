import { describe, expect, it } from "vitest";
import type { CardStory } from "../src/card-stories";
import { sprintPage, type SprintData } from "../src/sprint-views";
import type { Project } from "../src/projects";
import type { Viewer } from "../src/views";

const project = { repo: "o/r", check: { config: { nom: "R" } } } as unknown as Project;
const viewer = { login: "pe", role: "tech_lead", csrfToken: "tok" } as unknown as Viewer;
const story: CardStory = {
  number: 5,
  title: "Five",
  stage: "in_dev",
  closed: false,
  criteria: [
    { text: "First", done: true },
    { text: "Second", done: false },
  ],
  priority: "P1",
  missing: [],
  pulls: [{ number: 9, url: "https://github.com/o/r/pull/9", state: "open" }],
} as unknown as CardStory;

function data(over: Partial<SprintData> = {}): SprintData {
  return {
    sprint: { release: "sprint", version: "1.0", name: null, id: 1, startedAt: "2026-11-01T00:00:00Z", startedBy: "pe" } as never,
    legacy: false,
    last: null,
    sprintCards: [{ id: 1, title: "Card", priority: null, backstage: false } as never],
    nextCards: [],
    keptCards: [],
    integration: null,
    integrationCards: [],
    stories: new Map([[5, story]]),
    links: { order: new Map([[1, [5]]]), byStory: new Map([[5, [1]]]), cards: new Map(), nice: new Set() } as never,
    canOrder: true,
    canClose: false,
    releaseWorkflow: null,
    noIntegration: true,
    pulls: new Map(),
    reviewers: ["lead"],
    priorities: ["P1", "P2"],
    readyLabel: null,
    claude: { canLaunch: true, canRelaunch: true, workflow: "claude.yml", cap: 2, launches: new Map(), next: null, held: new Map(), runs: [], runsUrl: null },
    ...over,
  };
}

describe("a story unfolded in the sprint's list", () => {
  it("is folded under its line, read when it opens", () => {
    const page = sprintPage(viewer, project, data());
    expect(page).toContain(`data-unfold="/projects/o/r/sprint?unfold=5"`);
    expect(page).not.toContain("Acceptance criteria <span");
  });

  it("answers with criteria, pull requests, feedbacks, actions and the story's page", () => {
    const fragment = sprintPage(viewer, project, data({ unfold: { story: 5, card: 1, feedbacks: [{ at: "2026-11-17T10:00:00Z", actor: "tester", criterion: "Second", text: "Broken", comment: "" }] } }));
    expect(fragment).not.toContain("<html");
    expect(fragment).toContain("1/2");
    expect(fragment).toContain("First");
    expect(fragment).toContain("PR #9");
    expect(fragment).toContain("Broken");
    expect(fragment).toContain(`name="priority"`);
    expect(fragment).toContain("/sprint/stories/5");
  });

  it("offers Launch Claude on a ready story, only with the right", () => {
    const ready = { ...story, stage: "ready", pulls: [] } as unknown as CardStory;
    const base = { story: 5, card: 1, feedbacks: [] };
    const withRight = sprintPage(viewer, project, data({ stories: new Map([[5, ready]]), unfold: base }));
    expect(withRight).toContain("Launch Claude");
    const without = sprintPage(viewer, project, data({ stories: new Map([[5, ready]]), unfold: base, canOrder: false, claude: { ...data().claude, canLaunch: false } }));
    expect(without).not.toContain("Launch Claude");
  });
});
