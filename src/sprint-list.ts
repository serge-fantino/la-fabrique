import type { CardStory } from "./card-stories";
import type { InProgress } from "./card-lock";
import { isFinished, isInDevelopment, isReadyStage, isToTest } from "./lifecycle";

// The sprint as a list (la-fabrique#371): for each feature, the one thing
// to do next, chosen from its stories in this order: a story to test, a pull
// request to merge, a ready story to launch, a story to prepare; the nice
// to have stories only when the feature has nothing else. Pure: the page
// draws the button.

export type NextAction =
  | { kind: "test"; story: number }
  | { kind: "merge"; story: number; pull: number }
  | { kind: "launch"; story: number }
  | { kind: "prepare"; story: number }
  | { kind: "none"; reason: string };

export interface NextInput {
  // The feature's stories, in the sprint's order, with whether each is nice to have.
  stories: { number: number; nice: boolean }[];
  byNumber: Map<number, CardStory>;
  // The stories waiting for another of their feature (src/card-lock.ts).
  held: Map<number, InProgress>;
  // Stories Claude is working on now.
  running: Set<number>;
  // What this person may do here.
  canMerge: (pull: number) => boolean;
  canLaunch: boolean;
  // "Shipped in 1.173", when the feature is out.
  shipped?: string | null;
}

const openPull = (story: CardStory | undefined) => story?.pulls.find((pull) => pull.state === "open" && !pull.guessed) ?? null;

function pick(numbers: number[], input: NextInput): NextAction | null {
  const story = (number: number) => input.byNumber.get(number);
  const test = numbers.find((number) => isToTest(story(number)) && !story(number)?.validated);
  if (test !== undefined) return { kind: "test", story: test };
  for (const number of numbers) {
    const pull = openPull(story(number));
    if (pull && input.canMerge(pull.number)) return { kind: "merge", story: number, pull: pull.number };
  }
  if (input.canLaunch) {
    const launch = numbers.find((number) => isReadyStage(story(number)) && !input.held.has(number) && !input.running.has(number));
    if (launch !== undefined) return { kind: "launch", story: launch };
  }
  const prepare = numbers.find((number) => story(number)?.stage === "backlog" && !story(number)?.closed);
  if (prepare !== undefined) return { kind: "prepare", story: prepare };
  return null;
}

// Why a feature has no action to offer.
function whyNone(input: NextInput): string {
  const open = input.stories.filter(({ number }) => !isFinished(input.byNumber.get(number)));
  if (!input.stories.length) return "No story yet";
  if (!open.length) return input.shipped ? input.shipped : "All stories in production";
  for (const { number } of open) {
    const busy = input.held.get(number);
    if (busy) return `#${number} waits for #${busy.story}`;
  }
  const validated = open.filter(({ number }) => input.byNumber.get(number)?.validated);
  if (validated.length === open.length) return `#${validated[0]!.number} validated, waits for the go`;
  const working = open.find(({ number }) => input.running.has(number) || isInDevelopment(input.byNumber.get(number)));
  if (working) return `#${working.number} in development`;
  const ready = open.find(({ number }) => isReadyStage(input.byNumber.get(number)));
  if (ready) return `#${ready.number} is ready: a tech lead launches Claude`;
  const toMerge = open.find(({ number }) => openPull(input.byNumber.get(number)));
  if (toMerge) return `#${toMerge.number} has a pull request to merge`;
  return "Nothing to do now";
}

export function nextAction(input: NextInput): NextAction {
  const needed = input.stories.filter((story) => !story.nice).map((story) => story.number);
  const nice = input.stories.filter((story) => story.nice).map((story) => story.number);
  const found = pick(needed, input);
  if (found) return found;
  // Nice to have stories only when the needed ones offer nothing.
  const niceFound = pick(nice, input);
  if (niceFound) return niceFound;
  return { kind: "none", reason: whyNone(input) };
}
