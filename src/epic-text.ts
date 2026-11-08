import { featureEpicTitles, setFeatureEpic } from "./card-epics";
import { type Card, listCards, mentionedCards } from "./cards";

// An epic's text decides its features (la-fabrique#291): naming a feature
// ("C57") attaches it unless it already belongs to another epic; removing
// the name detaches it. A feature is in one epic only.

export interface Belonging {
  id: number;
  title: string;
}

// For each feature attached to an epic card, that epic.
export async function featureEpics(db: D1Database, repo: string): Promise<Map<number, Belonging>> {
  const rows = await db
    .prepare("SELECT l.ref AS ref, c.id AS id, c.title AS title FROM card_links l JOIN cards c ON c.id = l.card_id WHERE l.kind = 'feature' AND c.repo = ? AND c.kind = 'epic'")
    .bind(repo)
    .all<{ ref: string; id: number; title: string }>();
  return new Map(rows.results.map((row) => [Number(row.ref), { id: row.id, title: row.title }]));
}

export interface EpicTextWarning {
  feature: number;
  epic: number;
}

// Brings the epic's features in line with its text (`after`), given the text
// it had (`before`). Only what changed in the text acts: a name newly there
// attaches, a name gone detaches (if the feature belongs to this epic).
export async function syncEpicText(db: D1Database, epic: Card, before: string, after: string, login: string): Promise<EpicTextWarning[]> {
  if (epic.kind !== "epic") return [];
  const was = new Set(mentionedCards(before));
  const now = new Set(mentionedCards(after));
  const added = [...now].filter((id) => !was.has(id));
  const removed = [...was].filter((id) => !now.has(id));
  if (!added.length && !removed.length) return [];
  const cards = await listCards(db, epic.repo);
  const owners = await featureEpics(db, epic.repo);
  const titles = await featureEpicTitles(db, epic.repo);
  const warnings: EpicTextWarning[] = [];
  for (const id of added) {
    const feature = cards.find((card) => card.id === id);
    if (!feature || feature.kind !== "feature" || feature.archivedAt) continue;
    const owner = owners.get(id);
    if (owner && owner.id !== epic.id) warnings.push({ feature: id, epic: owner.id });
    else if (!owner) await setFeatureEpic(db, feature, epic.title, login, "text");
  }
  for (const id of removed) {
    const feature = cards.find((card) => card.id === id);
    if (!feature || feature.kind !== "feature" || titles.get(id) !== epic.title) continue;
    await setFeatureEpic(db, feature, null, login, "text");
  }
  return warnings;
}

// "57:9,58:9" in a redirect, back to warnings.
export function encodeWarnings(warnings: EpicTextWarning[]): string {
  return warnings.map((w) => `${w.feature}:${w.epic}`).join(",");
}

export function decodeWarnings(raw: string | null): EpicTextWarning[] {
  return (raw ?? "")
    .split(",")
    .slice(0, 20)
    .flatMap((part) => {
      const [feature, epic] = part.split(":").map(Number);
      return feature && epic ? [{ feature, epic }] : [];
    });
}
