import type { StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";

// One story at a time per card (la-fabrique#159): a card's stories touch
// the same feature and build on each other, so while one is in progress
// (Claude working on it, or its pull request open and not merged), the
// card's other stories wait. The same rule, by hand and when the sprint
// runs by itself (la-fabrique#160).

export interface InProgress {
  story: number;
  // What keeps it in progress: Claude working, or an open pull request.
  claude: boolean;
  pull: number | null;
}

// A story in progress: a Claude run going on it, or a pull request open on
// it (a link only guessed from a text does not hold the others).
export function inProgress(number: number, story: CardStory | undefined, running: Set<number>): InProgress | null {
  if (story?.closed) return null;
  const pull = story?.pulls.find((candidate) => candidate.state === "open" && !candidate.guessed)?.number ?? null;
  const claude = running.has(number);
  return claude || pull !== null ? { story: number, claude, pull } : null;
}

// Each story held, and the story in progress it waits for. A story shared
// by several cards waits as soon as one of them has another in progress.
export function heldStories(links: StoryCards, stories: Map<number, CardStory>, running: Set<number>, cards?: number[]): Map<number, InProgress> {
  const held = new Map<number, InProgress>();
  for (const [card, numbers] of links.order) {
    if (cards && !cards.includes(card)) continue;
    const busy = numbers.map((number) => inProgress(number, stories.get(number), running)).find((found) => found !== null) ?? null;
    if (!busy) continue;
    for (const number of numbers) {
      if (number === busy.story || held.has(number) || stories.get(number)?.closed) continue;
      held.set(number, busy);
    }
  }
  return held;
}

export function waitReason(number: number, busy: InProgress): string {
  const why = busy.claude ? "Claude is working on it" : `its pull request #${busy.pull} is not merged yet`;
  return `#${number} waits for #${busy.story} of the same card: ${why}. One story at a time per card.`;
}
