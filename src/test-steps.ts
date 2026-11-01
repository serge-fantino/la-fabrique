// The steps a tester recorded in the app while checking a criterion
// (la-fabrique#167): pages visited, buttons and links pressed, fields
// filled, by their accessible name. Never a value typed, never a screenshot:
// the kit does not send one, and whatever else arrives is dropped here.

export const STEP_KINDS = ["page", "click", "fill", "select", "check"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export interface TestStep {
  kind: StepKind;
  // Accessible name of the button, link or field; empty for a page.
  name: string;
  // The page address (path only, no query or fragment).
  page: string;
}

export const MAX_STEPS = 100;

function short(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function pathOf(value: unknown): string {
  const raw = short(value, 300);
  const path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#]/)[0] ?? "";
  return path.slice(0, 200);
}

// Only the known keys are kept: a `value` sent anyway is never stored.
// `null` when `steps` is not a list; an empty list when none is usable.
export function cleanSteps(input: unknown): TestStep[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const steps: TestStep[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const kind = STEP_KINDS.find((candidate) => candidate === item["kind"]);
    if (!kind) continue;
    const name = short(item["name"], 120);
    if (kind !== "page" && !name) continue;
    steps.push({ kind, name: kind === "page" ? "" : name, page: pathOf(item["page"]) });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}
