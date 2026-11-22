import type { Env } from "./env";
import type { JobKind } from "./jobs";
import type { Project } from "./projects";
import type { Action } from "./rights";

// The catalogue of capabilities (ADR 0006, epic F15, after LimaLibri's
// capacites.py): everything an agent, or a person, can be asked to do for a
// project, in one place. Each capability says what it does, its parameters,
// where it runs, how it ends, what it writes, and who may launch it. It is
// the vocabulary of the Agents page and, later, of plans and of the MCP's
// launches: a new kind of agent task is an entry here first.

// How a request ends (ADR 0006 § 4):
//   decision  proposals wait for a person, who keeps, changes or rejects them;
//   pose      written at once (a new revision of a card, a pull request): the
//             earlier state stays (the card's history, git) and can be restored;
//   report    a reading, written where it is read (a review);
//   person    a task only a person can do; what waits on it waits.
export const ENDINGS = ["decision", "pose", "report", "person"] as const;
export type Ending = (typeof ENDINGS)[number];

export const ENDING_LABELS: Record<Ending, string> = {
  decision: "Waits for a decision",
  pose: "Written at once",
  report: "A report",
  person: "A person's task",
};

// Where it runs (principle 3: what writes a project's code runs in the
// project, with its secrets).
export const PLACES = ["fabrique", "runner", "person"] as const;
export type Place = (typeof PLACES)[number];

export const PLACE_LABELS: Record<Place, string> = {
  fabrique: "In La Fabrique, with its own key",
  runner: "In the project's runner, with its secrets",
  person: "A person",
};

export type ParamType = "card" | "epic" | "story" | "pull" | "decision" | "text" | "answers";

export interface Capability {
  id: string;
  label: string;
  does: string;
  // name -> type; required when the name ends with "!".
  params: Record<string, ParamType>;
  place: Place;
  ending: Ending;
  // What it writes: when it answers, and when a person decides.
  writes: { answer: string[]; decision: string[] };
  // Who may launch it (src/rights.ts).
  right: Action;
  // Where it is launched from today.
  from: string;
  // In La Fabrique: the background jobs that run it and the purposes its
  // calls are counted under (llm_calls.purpose).
  jobs?: JobKind[];
  purposes?: string[];
  // In the runner: the workflow of .fabrique.json it needs.
  workflow?: "claude" | "revue";
  // Not built yet: the decision that describes it.
  planned?: string;
}

export const CAPABILITIES: Capability[] = [
  {
    id: "spec",
    label: "Write or revise a card's spec",
    does: "Claude asks its questions (five at most), then writes the card's functional spec in the project's sections, or revises it with an instruction and the answers.",
    params: { "card!": "card", instruction: "text", answers: "answers" },
    place: "fabrique",
    ending: "pose",
    writes: { answer: ["A new revision of the card's spec, with Claude's questions; the earlier revisions kept, any of them can be taken back"], decision: [] },
    right: "request",
    from: "The card's page: Write the spec with Claude, then Ask Claude for a change",
    jobs: ["spec_draft", "spec_revise", "spec_answer"],
    purposes: ["spec_draft", "spec_revise"],
  },
  {
    id: "epic_document",
    label: "Write or revise an epic's document",
    does: "Claude writes the epic's document (what and why), or revises it with an instruction and the answers.",
    params: { "epic!": "epic", instruction: "text", answers: "answers" },
    place: "fabrique",
    ending: "pose",
    writes: { answer: ["A new revision of the epic's document; the earlier revisions kept"], decision: [] },
    right: "request",
    from: "The epic's page: Write the document with Claude, Revise the document with Claude",
    purposes: ["epic_draft", "epic_revise"],
  },
  {
    id: "stories",
    label: "Split a card into stories, or review its stories",
    does: "Claude proposes stories that each deliver on their own, with their criteria; on a card that already has stories, it reads them against the spec: those that hold, those to change, and the stories missing.",
    params: { "card!": "card", instruction: "text" },
    place: "fabrique",
    ending: "decision",
    writes: {
      answer: ["The proposal, kept with the card (nothing on GitHub yet)"],
      decision: ["The stories kept, created on GitHub in the person's name and linked to the card", "The comments kept, posted on the stories to change"],
    },
    right: "request",
    from: "The card's page: Split into stories with Claude, Review the stories with Claude",
    jobs: ["spec_split"],
    purposes: ["spec_split"],
  },
  {
    id: "test_cases",
    label: "Write a card's test cases",
    does: "Claude writes the test cases of each story of the card, from its criteria.",
    params: { "card!": "card", instruction: "text" },
    place: "fabrique",
    ending: "pose",
    writes: { answer: ["The card's test cases, per story"], decision: [] },
    right: "request",
    from: "The card's page: Write test cases with Claude",
    jobs: ["spec_tests"],
    purposes: ["spec_tests"],
  },
  {
    id: "epic_features",
    label: "Propose an epic's features",
    does: "Claude reads the epic's document and proposes its features, each a card to be.",
    params: { "epic!": "epic", instruction: "text" },
    place: "fabrique",
    ending: "decision",
    writes: { answer: ["The proposal, kept with the epic"], decision: ["The features kept, created as cards under the epic"] },
    right: "request",
    from: "The epic's page: Propose features with Claude",
    jobs: ["epic_features"],
    purposes: ["epic_features"],
  },
  {
    id: "epic_review",
    label: "Review an epic against its features",
    does: "Claude reads the epic's document and its features, and reports what no feature covers, features that overlap, a feature that goes against a decision, and missing dependencies.",
    params: { "epic!": "epic", instruction: "text" },
    place: "fabrique",
    ending: "decision",
    writes: { answer: ["The findings, kept with the epic; nothing changed"], decision: ["Each finding applied or dismissed, one by one"] },
    right: "request",
    from: "The epic's page: Review with Claude",
    jobs: ["epic_review"],
    purposes: ["epic_review"],
  },
  {
    id: "code",
    label: "Code a story",
    does: "The project's Claude workflow works on a ready story: its branch linked to the issue, the code and its tests, a pull request \"Refs #N\" with one line per criterion.",
    params: { "story!": "story" },
    place: "runner",
    ending: "pose",
    writes: { answer: ["A branch and a pull request on the project (git keeps every earlier state)", "A comment on the story: what is done, what is left"], decision: [] },
    right: "launch_claude",
    from: "The sprint: Launch the next story, Run the sprint",
    workflow: "claude",
  },
  {
    id: "rework",
    label: "Rework a story after its test feedback",
    does: "The same workflow, on a story sent back by a tester: a new branch, the feedback in the prompt, a pull request on the same story.",
    params: { "story!": "story" },
    place: "runner",
    ending: "pose",
    writes: { answer: ["A new branch and pull request on the same story"], decision: [] },
    right: "launch_claude",
    from: "The sprint and the story's page: Rework with Claude",
    workflow: "claude",
  },
  {
    id: "update",
    label: "Bring a pull request up to date",
    does: "The same workflow, on a story's pull request in conflict or behind: the production branch merged in, the conflicts resolved keeping both sides' intent.",
    params: { "story!": "story", "pull!": "pull" },
    place: "runner",
    ending: "pose",
    writes: { answer: ["Commits on the pull request's branch"], decision: [] },
    right: "launch_claude",
    from: "The sprint: Update with Claude",
    workflow: "claude",
  },
  {
    id: "review",
    label: "Review a pull request",
    does: "The project's review workflow reads a pull request against its story, with the project's review settings, and posts one review: never an approval, never a request for changes.",
    params: { "pull!": "pull" },
    place: "runner",
    ending: "report",
    writes: { answer: ["A review on the pull request, with its verdict (ok, remarks, blocking)"], decision: [] },
    right: "launch_claude",
    from: "The sprint: Review with Claude; or on every pull request when the review is on",
    workflow: "revue",
  },
  {
    id: "story_loop",
    label: "Build a story through the loop",
    does: "One session per story through its phases (plan, tests first, code, review by a fresh agent, fix, end-to-end check, delivery), each reported to La Fabrique, stopping at a typed break.",
    params: { "story!": "story" },
    place: "runner",
    ending: "pose",
    writes: { answer: ["A pull request with each criterion's evidence", "The loop's events in La Fabrique's log"], decision: [] },
    right: "launch_claude",
    from: "The sprint",
    workflow: "claude",
    planned: "0003",
  },
  {
    id: "refactor",
    label: "Refactor, behaviour unchanged",
    does: "Proposed when an indicator crosses its threshold; run through the loop with one more rule: existing tests unchanged and green, no public release note.",
    params: { "card!": "card" },
    place: "runner",
    ending: "pose",
    writes: { answer: ["A pull request behind the scenes"], decision: [] },
    right: "launch_claude",
    from: "A refactoring card",
    workflow: "claude",
    planned: "0003",
  },
  {
    id: "decision",
    label: "Take a decision",
    does: "A decision an agent proposed (an ADR, Proposed): one of its deciders accepts or rejects it, with a note, at the commit read.",
    params: { "decision!": "decision", note: "text" },
    place: "person",
    ending: "person",
    writes: { answer: [], decision: ["The ADR's status and the index, committed on its pull request", "The decision in La Fabrique's log"] },
    right: "request",
    from: "The Decisions tab",
    planned: "0005",
  },
];

export function capability(id: string): Capability | null {
  return CAPABILITIES.find((entry) => entry.id === id) ?? null;
}

// Whether the project can run it now, and why not.
export function availability(capability: Capability, project: Project, env: Pick<Env, "ANTHROPIC_API_KEY">): { ok: boolean; reason: string } {
  if (capability.planned) return { ok: false, reason: `Planned (ADR ${capability.planned})` };
  if (capability.place === "fabrique") {
    return env.ANTHROPIC_API_KEY ? { ok: true, reason: "Ready" } : { ok: false, reason: "La Fabrique has no Anthropic key" };
  }
  if (capability.workflow) {
    const file = project.check?.config?.workflows?.[capability.workflow];
    return typeof file === "string" && file ? { ok: true, reason: `Workflow ${file}` } : { ok: false, reason: `No \`workflows.${capability.workflow}\` in .fabrique.json` };
  }
  return { ok: true, reason: "Ready" };
}

export interface Usage {
  calls: number;
  costMicros: number;
  // Calls whose price is unknown are counted, not priced.
  unpriced: number;
  last: string | null;
}

// What La Fabrique's own capabilities cost on a project, from llm_calls:
// every call that reached Claude (errors without tokens are not counted).
export async function usageOn(db: D1Database, repo: string): Promise<Map<string, Usage>> {
  const { results } = await db
    .prepare(
      `SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS cost, SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unpriced, MAX(at) AS last
       FROM llm_calls WHERE repo = ? AND (outcome <> 'error' OR input_tokens > 0) GROUP BY purpose`,
    )
    .bind(repo)
    .all<{ purpose: string; calls: number; cost: number; unpriced: number; last: string | null }>();
  const usage = new Map<string, Usage>();
  for (const entry of CAPABILITIES) {
    const rows = results.filter((row) => entry.purposes?.includes(row.purpose));
    if (!rows.length) continue;
    usage.set(entry.id, {
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      costMicros: rows.reduce((sum, row) => sum + row.cost, 0),
      unpriced: rows.reduce((sum, row) => sum + row.unpriced, 0),
      last: rows.map((row) => row.last).filter((at): at is string => Boolean(at)).sort().pop() ?? null,
    });
  }
  return usage;
}
