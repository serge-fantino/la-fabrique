import { storyCards } from "./card-groups";
import { cardStories, type CardStory } from "./card-stories";
import type { Card } from "./cards";
import { cardRef, cardUrl, statusPill } from "./card-views";
import type { Env } from "./env";
import type { Project } from "./projects";
import { shippedNote, type Progress } from "./progress-stages";
import { stagePill } from "./stories-views";
import { escapeHtml } from "./views";

// A feature named alone on a line of another card's text ("C57") is shown
// in place, read live (la-fabrique#290): nothing is copied into the text.

const ALONE = /^[ \t]*C(\d{1,6})[ \t]*$/gm;

// The cards a text names alone on a line.
export function embeddedCards(text: string): number[] {
  return [...new Set([...text.matchAll(ALONE)].map((match) => Number(match[1])))].slice(0, 20);
}

const SYNOPSIS_MAX = 400;

// The first paragraph of the card's text, else the Need of its spec.
export function synopsisOf(card: Pick<Card, "body" | "data">): string {
  const paragraphs = card.body
    .replace(/\{[^{}\n]*\}/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !/^#{1,6}\s/.test(block));
  const text = paragraphs[0] ?? card.data.spec?.answers?.need?.trim() ?? "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SYNOPSIS_MAX ? `${flat.slice(0, SYNOPSIS_MAX - 1).trimEnd()}…` : flat;
}

export function embedHtml(
  repo: string,
  card: Card,
  progress: Progress | null | undefined,
  stories: CardStory[],
): string {
  const head = `<a class="card-mention mono" href="${escapeHtml(cardUrl(repo, card.id))}">${cardRef(card.id)}</a> <strong>${escapeHtml(card.title)}</strong> ${statusPill(card, progress)}`;
  const synopsis = synopsisOf(card);
  const body = synopsis ? `<p class="card-embed-synopsis">${escapeHtml(synopsis)}</p>` : "";
  let rest = "";
  if (card.kind !== "epic") {
    if (stories.length)
      rest += `<ul class="card-embed-stories">${stories
        .map((story) => `<li><span class="mono">#${story.number}</span> ${escapeHtml(story.title)} ${story.stage ? stagePill(story.stage) : ""}</li>`)
        .join("")}</ul>`;
    rest += shippedNote(progress?.shipped, "card-shipped card-embed-shipped");
  }
  return `<aside class="card-embed" data-card="${card.id}"><p class="card-embed-head">${head}</p>${body}${rest}</aside>`;
}

// A card named alone on a line but archived or dropped stays a link, marked.
export function markedLink(repo: string, card: Card): string {
  const mark = card.archivedAt ? "archived" : "dropped";
  return `<a class="card-mention mono" href="${escapeHtml(cardUrl(repo, card.id))}" title="${escapeHtml(card.title)}">${cardRef(card.id)}</a> <span class="pill small">${mark}</span>`;
}

// For each card named alone on a line of `text`, the HTML to show in its place.
export async function embedsFor(
  env: Env,
  project: Project,
  text: string,
  cards: Card[],
  progress: ReadonlyMap<number, Progress>,
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const ids = embeddedCards(text);
  const named = cards.filter((card) => ids.includes(card.id));
  if (!named.length) return found;
  const links = await storyCards(env.DB, project.repo);
  const shown = named.filter((card) => !card.archivedAt && card.status !== "dropped");
  const numbers = [...new Set(shown.filter((card) => card.kind !== "epic").flatMap((card) => links.order.get(card.id) ?? []))];
  const stories = await cardStories(env, project, numbers);
  for (const card of named) {
    if (card.archivedAt || card.status === "dropped") {
      found.set(card.id, markedLink(project.repo, card));
      continue;
    }
    const mine = (links.order.get(card.id) ?? []).flatMap((number) => stories.get(number) ?? []);
    found.set(card.id, embedHtml(project.repo, card, progress.get(card.id), mine));
  }
  return found;
}
