import { activityStatement } from "./activity-log";
import type { Card } from "./cards";

// Validating a feature (la-fabrique#232): the last step before the sprint
// takes it. A person (Product Engineer and above) says the feature is right
// once its stories are ready; who and when are kept on the card and in the
// log. What was validated is remembered as a fingerprint of its text, its spec
// and its stories: when one changes, the validation no longer holds, and the
// card says which.

export interface FeatureValidation {
  by: string;
  at: string;
  text: string;
  spec: string;
  stories: string;
}

export type ValidationState =
  | { state: "none" }
  | { state: "valid"; by: string; at: string }
  | { state: "outdated"; by: string; at: string; why: string[] };

function hash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}.${value.length}`;
}

type Source = Pick<Card, "title" | "body" | "data">;

export function fingerprint(card: Source, stories: number[]): Omit<FeatureValidation, "by" | "at"> {
  return {
    text: hash(`${card.title}\n${card.body}`),
    spec: hash(JSON.stringify(card.data.spec?.answers ?? {})),
    stories: [...stories].sort((a, b) => a - b).join(","),
  };
}

export function validationOf(card: Source, stories: number[]): ValidationState {
  const kept = card.data.validation;
  if (!kept) return { state: "none" };
  const now = fingerprint(card, stories);
  const why: string[] = [];
  if (kept.text !== now.text) why.push("its text changed");
  if (kept.spec !== now.spec) why.push("its spec changed");
  if (kept.stories !== now.stories) {
    const before = new Set(kept.stories ? kept.stories.split(",") : []);
    const after = now.stories ? now.stories.split(",") : [];
    const added = after.some((n) => !before.has(n));
    const removed = [...before].some((n) => !after.includes(n));
    why.push(added && removed ? "stories were added and removed" : added ? "a story was added" : "a story was removed");
  }
  return why.length ? { state: "outdated", by: kept.by, at: kept.at, why } : { state: "valid", by: kept.by, at: kept.at };
}

export async function validateFeature(db: D1Database, card: Card, stories: number[], login: string): Promise<void> {
  const validation: FeatureValidation = { by: login, at: new Date().toISOString(), ...fingerprint(card, stories) };
  const data = { ...card.data, validation };
  await db.batch([
    db.prepare("UPDATE cards SET data = ? WHERE id = ?").bind(JSON.stringify(data), card.id),
    activityStatement(db, { actor: login, action: "card_validated", repo: card.repo, details: { card: card.id, title: card.title, stories } }),
  ]);
}
