import { activityStatement } from "./activity-log";

// Cards: the upstream of dev (la-fabrique#74), stored in La Fabrique and
// attached to a project. The text (Markdown with annotations) is the
// substance; the columns only filter and place a card on the board.

export const CARD_KINDS = ["feature", "idea", "question"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const KIND_LABELS: Record<CardKind, string> = { feature: "Feature", idea: "Idea", question: "Question" };

export const CARD_STATUSES = ["draft", "shaping", "to_validate", "validated", "dropped"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const STATUS_LABELS: Record<CardStatus, string> = {
  draft: "Draft",
  shaping: "Shaping",
  to_validate: "To validate",
  validated: "Validated",
  dropped: "Dropped",
};

// Free dimensions: their values are the project's own, created from the
// board or by writing them on a card.
export const FREE_DIMENSIONS = ["epic", "domain", "segment", "release"] as const;
export type FreeDimension = (typeof FREE_DIMENSIONS)[number];

export const DIMENSIONS = ["status", "kind", ...FREE_DIMENSIONS] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_LABELS: Record<Dimension, string> = {
  status: "Status",
  kind: "Type",
  epic: "Epic",
  domain: "Domain",
  segment: "Segment",
  release: "Release",
};

export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
export const MAX_VALUE = 60;

export type CardTags = { kind: CardKind; status: CardStatus } & Record<FreeDimension, string | null>;

// The functional spec of a card, in the project's request sections
// (`demandes.rubriques`), written with Claude or by hand; kept in the
// card's free fields, versioned with it.
export interface CardSpec {
  answers: Record<string, string>;
  questions: string[];
  source: "claude" | "person";
  // What Claude said it did, in one sentence.
  note?: string;
  // Claude's questions already answered (or left, `skipped`), oldest first:
  // it does not ask them again.
  dialogue?: { question: string; answer: string; at: string; skipped?: boolean }[];
  // How many times Claude wrote this spec; after three, only blocking questions.
  rounds?: number;
  // Claude said it knows enough (its note says why), or the person closed
  // the questions: no more questions unless asked.
  enough?: boolean;
  closed?: boolean;
  at: string;
}

// Claude's proposal to split the spec into stories, to review before
// anything goes to GitHub; edited by the person, then created.
export interface CardSplit {
  stories: { title: string; answers: Record<string, string> }[];
  // When the card already has stories: Claude's review of each against
  // the spec; a change is a comment for the story's issue.
  review?: StoryReview[];
  note?: string;
  // When the spec that was split was written: a later spec makes the
  // proposal out of date.
  specAt: string;
  at: string;
}

export interface StoryReview {
  number: number;
  title: string;
  verdict: "fits" | "change";
  comment: string;
}

export interface CardData {
  spec?: CardSpec;
  split?: CardSplit;
}

export interface Card extends CardTags {
  id: number;
  repo: string;
  title: string;
  body: string;
  position: number;
  rev: number;
  author: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  data: CardData;
}

export interface CardRevision {
  rev: number;
  title: string;
  body: string;
  tags: Partial<CardTags>;
  data: CardData;
  author: string;
  at: string;
}

export interface CardLink {
  // Read from the text (issue, person, term), or made from the card (story).
  kind: "issue" | "person" | "term" | "story";
  ref: string;
}

export function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
}

export function isFreeDimension(value: unknown): value is FreeDimension {
  return typeof value === "string" && (FREE_DIMENSIONS as readonly string[]).includes(value);
}

export function isKind(value: unknown): value is CardKind {
  return typeof value === "string" && (CARD_KINDS as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is CardStatus {
  return typeof value === "string" && (CARD_STATUSES as readonly string[]).includes(value);
}

// A value as typed, tidied: one line, no braces (they close an annotation).
export function cleanValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[{}\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
  return clean || null;
}

// ---- Annotations -------------------------------------------------------

// `{segment: pro}` in a card's text sets its segment; `#12` points to an
// issue of the project, `@login` to a person, `[[Basket]]` to a glossary
// term (F4.8).
const ANNOTATION = /\{\s*(epic|domain|segment|release)\s*:\s*([^{}\n]*?)\s*\}/gi;
const ISSUE = /(^|[\s(])#(\d{1,7})\b/g;
const PERSON = /(^|[\s(])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})\b/gi;
const TERM = /\[\[([^[\]\n]{1,60})\]\]/g;

export function annotations(body: string): Partial<Record<FreeDimension, string | null>> {
  const found: Partial<Record<FreeDimension, string | null>> = {};
  for (const match of body.matchAll(ANNOTATION)) {
    const dimension = (match[1] ?? "").toLowerCase() as FreeDimension;
    found[dimension] = cleanValue(match[2] ?? "");
  }
  return found;
}

// Moving a card on the board keeps its text true: the annotation of that
// dimension, if there is one, takes the new value (or goes).
export function rewriteAnnotation(body: string, dimension: FreeDimension, value: string | null): string {
  const pattern = new RegExp(`\\{\\s*${dimension}\\s*:\\s*[^{}\\n]*?\\s*\\}`, "gi");
  if (!pattern.test(body)) return body;
  return body.replace(pattern, value ? `{${dimension}: ${value}}` : "").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
}

export function linksOf(body: string): CardLink[] {
  const links = new Map<string, CardLink>();
  const add = (link: CardLink) => links.set(`${link.kind}:${link.ref}`, link);
  for (const match of body.matchAll(ISSUE)) add({ kind: "issue", ref: match[2] ?? "" });
  for (const match of body.matchAll(PERSON)) add({ kind: "person", ref: (match[2] ?? "").toLowerCase() });
  for (const match of body.matchAll(TERM)) add({ kind: "term", ref: (match[1] ?? "").trim() });
  return [...links.values()].filter((link) => link.ref);
}

// A few plain lines for the board: no Markdown, no annotations.
export function excerpt(body: string, length = 180): string {
  const plain = body
    .replace(ANNOTATION, " ")
    .replace(TERM, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > length ? `${plain.slice(0, length - 1).trimEnd()}…` : plain;
}

// ---- Reading -----------------------------------------------------------

interface CardRow {
  id: number;
  repo: string;
  kind: string;
  status: string;
  title: string;
  body: string;
  epic: string | null;
  domain: string | null;
  segment: string | null;
  release: string | null;
  position: number;
  rev: number;
  author: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  data: string | null;
}

const CARD_COLUMNS =
  "id, repo, kind, status, title, body, epic, domain, segment, release, position, rev, author, created_at, updated_at, archived_at, data";

export function parseData(raw: string | null): CardData {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    return data && typeof data === "object" ? (data as CardData) : {};
  } catch {
    return {};
  }
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    repo: row.repo,
    kind: isKind(row.kind) ? row.kind : "feature",
    status: isStatus(row.status) ? row.status : "draft",
    title: row.title,
    body: row.body,
    epic: row.epic,
    domain: row.domain,
    segment: row.segment,
    release: row.release,
    position: row.position,
    rev: row.rev,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    data: parseData(row.data),
  };
}

export async function listCards(db: D1Database, repo: string): Promise<Card[]> {
  const { results } = await db
    .prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE repo = ? ORDER BY position, id`)
    .bind(repo)
    .all<CardRow>();
  return results.map(toCard);
}

export async function findCard(db: D1Database, repo: string, id: number): Promise<Card | null> {
  const row = await db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ? AND repo = ?`).bind(id, repo).first<CardRow>();
  return row ? toCard(row) : null;
}

export async function cardRevisions(db: D1Database, id: number): Promise<CardRevision[]> {
  const { results } = await db
    .prepare("SELECT rev, title, body, tags, author, created_at, data FROM card_revisions WHERE card_id = ? ORDER BY rev DESC")
    .bind(id)
    .all<{ rev: number; title: string; body: string; tags: string; author: string; created_at: string; data: string | null }>();
  return results.map((row) => {
    let tags: Partial<CardTags> = {};
    try {
      tags = JSON.parse(row.tags) as Partial<CardTags>;
    } catch {
      // An unreadable version keeps its text.
    }
    return { rev: row.rev, title: row.title, body: row.body, tags, data: parseData(row.data), author: row.author, at: row.created_at };
  });
}

export async function cardLinks(db: D1Database, id: number): Promise<CardLink[]> {
  const { results } = await db
    .prepare("SELECT kind, ref FROM card_links WHERE card_id = ? ORDER BY kind, ref")
    .bind(id)
    .all<CardLink>();
  return results;
}

// The values of each free dimension: those created from the board in
// their order, then those only written on cards.
export async function dimensionValues(db: D1Database, repo: string, cards: Card[]): Promise<Record<FreeDimension, string[]>> {
  const { results } = await db
    .prepare("SELECT dimension, value FROM card_values WHERE repo = ? ORDER BY position, created_at")
    .bind(repo)
    .all<{ dimension: string; value: string }>();
  const values = Object.fromEntries(FREE_DIMENSIONS.map((dimension) => [dimension, [] as string[]])) as Record<FreeDimension, string[]>;
  for (const row of results) if (isFreeDimension(row.dimension)) values[row.dimension].push(row.value);
  for (const dimension of FREE_DIMENSIONS) {
    const used = [...new Set(cards.map((card) => card[dimension]).filter((value): value is string => Boolean(value)))];
    const extra = used.filter((value) => !values[dimension].includes(value)).sort((a, b) => a.localeCompare(b));
    values[dimension].push(...extra);
  }
  return values;
}

// The spelling already in use wins: "Pro" typed again is "pro".
export function canonical(known: string[], value: string | null): string | null {
  if (!value) return null;
  return known.find((candidate) => candidate.toLowerCase() === value.toLowerCase()) ?? value;
}

// ---- Writing -----------------------------------------------------------

export interface CardInput {
  title: string;
  body: string;
  tags: CardTags;
}

export function tagsOf(card: CardTags): CardTags {
  return {
    kind: card.kind,
    status: card.status,
    epic: card.epic,
    domain: card.domain,
    segment: card.segment,
    release: card.release,
  };
}

// The form's fields, then the annotations of the text, which win.
export function readCardForm(form: FormData, known: Record<FreeDimension, string[]>): CardInput {
  const title = String(form.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const body = String(form.get("body") ?? "").replace(/\r\n/g, "\n").slice(0, MAX_BODY);
  const kind = form.get("kind");
  const status = form.get("status");
  const written = annotations(body);
  const free = Object.fromEntries(
    FREE_DIMENSIONS.map((dimension) => [
      dimension,
      canonical(known[dimension], dimension in written ? (written[dimension] ?? null) : cleanValue(form.get(dimension))),
    ]),
  ) as Record<FreeDimension, string | null>;
  return { title, body, tags: { kind: isKind(kind) ? kind : "feature", status: isStatus(status) ? status : "draft", ...free } };
}

function revisionStatement(db: D1Database, id: number, rev: number, input: CardInput, author: string, data: CardData = {}): D1PreparedStatement {
  return db
    .prepare("INSERT INTO card_revisions (card_id, rev, title, body, tags, author, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, rev, input.title, input.body, JSON.stringify(input.tags), author, Object.keys(data).length ? JSON.stringify(data) : null);
}

function linkStatements(db: D1Database, id: number, body: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM card_links WHERE card_id = ? AND kind IN ('issue', 'person', 'term')").bind(id),
    ...linksOf(body).map((link) =>
      db.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, ?, ?)").bind(id, link.kind, link.ref),
    ),
  ];
}

export async function createCard(db: D1Database, repo: string, author: string, input: CardInput): Promise<number> {
  const last = await db.prepare("SELECT MAX(position) AS position FROM cards WHERE repo = ?").bind(repo).first<{ position: number | null }>();
  const { tags } = input;
  const row = await db
    .prepare(
      `INSERT INTO cards (repo, kind, status, title, body, epic, domain, segment, release, position, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(repo, tags.kind, tags.status, input.title, input.body, tags.epic, tags.domain, tags.segment, tags.release, (last?.position ?? 0) + 1, author)
    .first<{ id: number }>();
  const id = row?.id ?? 0;
  await db.batch([
    revisionStatement(db, id, 1, input, author),
    ...linkStatements(db, id, input.body),
    activityStatement(db, { actor: author, action: "card_created", repo, details: { card: id, title: input.title } }),
  ]);
  return id;
}

function sameTags(a: CardTags, b: CardTags): boolean {
  return DIMENSIONS.every((dimension) => a[dimension] === b[dimension]);
}

// Saved only over the version the person was editing: otherwise nothing
// is written and they see what changed.
export async function updateCard(
  db: D1Database,
  card: Card,
  author: string,
  input: CardInput,
  baseRev: number,
): Promise<"saved" | "unchanged" | "conflict"> {
  if (baseRev !== card.rev) return "conflict";
  if (input.title === card.title && input.body === card.body && sameTags(input.tags, card)) return "unchanged";
  const rev = card.rev + 1;
  const { tags } = input;
  const result = await db
    .prepare(
      `UPDATE cards SET kind = ?, status = ?, title = ?, body = ?, epic = ?, domain = ?, segment = ?, release = ?,
         rev = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND rev = ?`,
    )
    .bind(tags.kind, tags.status, input.title, input.body, tags.epic, tags.domain, tags.segment, tags.release, rev, card.id, card.rev)
    .run();
  if (!result.meta.changes) return "conflict";
  await db.batch([
    revisionStatement(db, card.id, rev, input, author, card.data),
    ...linkStatements(db, card.id, input.body),
    activityStatement(db, { actor: author, action: "card_edited", repo: card.repo, details: { card: card.id, title: input.title } }),
  ]);
  return "saved";
}

// A new spec: a new version of the card, its text and tags unchanged.
export async function saveSpec(db: D1Database, card: Card, author: string, spec: CardSpec, callId: number | null = null): Promise<number> {
  const rev = card.rev + 1;
  const data: CardData = { ...card.data, spec };
  await db.batch([
    db
      .prepare("UPDATE cards SET data = ?, rev = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .bind(JSON.stringify(data), rev, card.id),
    revisionStatement(db, card.id, rev, { title: card.title, body: card.body, tags: tagsOf(card) }, author, data),
    activityStatement(db, {
      actor: author,
      action: "card_spec_written",
      repo: card.repo,
      details: { card: card.id, title: card.title, by: spec.source, ...(callId ? { call: callId } : {}) },
    }),
  ]);
  return rev;
}

// A split proposed (or edited), or dropped (null): a new version of the card.
export async function saveSplit(db: D1Database, card: Card, author: string, split: CardSplit | null, callId: number | null = null): Promise<void> {
  const rev = card.rev + 1;
  const data: CardData = { ...card.data };
  if (split) data.split = split;
  else delete data.split;
  await db.batch([
    db
      .prepare("UPDATE cards SET data = ?, rev = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .bind(JSON.stringify(data), rev, card.id),
    revisionStatement(db, card.id, rev, { title: card.title, body: card.body, tags: tagsOf(card) }, author, data),
    ...(callId && split
      ? [
          activityStatement(db, {
            actor: author,
            action: "card_split_proposed",
            repo: card.repo,
            details: { card: card.id, title: card.title, stories: split.stories.length, call: callId },
          }),
        ]
      : []),
  ]);
}

export async function findCardById(db: D1Database, id: number): Promise<Card | null> {
  const row = await db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`).bind(id).first<CardRow>();
  return row ? toCard(row) : null;
}

// An older version comes back as the newest one: nothing is lost.
export async function restoreRevision(db: D1Database, card: Card, revision: CardRevision, author: string): Promise<void> {
  const tags = { ...tagsOf(card), ...revision.tags };
  const rev = card.rev + 1;
  await db.batch([
    db
      .prepare(
        `UPDATE cards SET kind = ?, status = ?, title = ?, body = ?, epic = ?, domain = ?, segment = ?, release = ?, data = ?, rev = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .bind(
        tags.kind,
        tags.status,
        revision.title,
        revision.body,
        tags.epic ?? null,
        tags.domain ?? null,
        tags.segment ?? null,
        tags.release ?? null,
        Object.keys(revision.data).length ? JSON.stringify(revision.data) : null,
        rev,
        card.id,
      ),
    revisionStatement(db, card.id, rev, { title: revision.title, body: revision.body, tags }, author, revision.data),
    ...linkStatements(db, card.id, revision.body),
    activityStatement(db, {
      actor: author,
      action: "card_version_restored",
      repo: card.repo,
      details: { card: card.id, title: revision.title, version: revision.rev },
    }),
  ]);
}

// A story made from the card on GitHub: the card keeps the link.
export async function linkStory(db: D1Database, card: Card, author: string, issue: number, url: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO card_links (card_id, kind, ref) VALUES (?, 'story', ?)").bind(card.id, String(issue)),
    activityStatement(db, {
      actor: author,
      action: "card_story_created",
      repo: card.repo,
      issueNumber: issue,
      details: { card: card.id, title: card.title, url },
    }),
  ]);
}

export async function archiveCard(db: D1Database, card: Card, author: string, archive: boolean): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE cards SET archived_at = ${archive ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "NULL"} WHERE id = ?`)
      .bind(card.id),
    activityStatement(db, {
      actor: author,
      action: archive ? "card_archived" : "card_restored",
      repo: card.repo,
      details: { card: card.id, title: card.title },
    }),
  ]);
}

export interface Move {
  set: Partial<Record<Dimension, string | null>>;
  before: number | null;
  after: number | null;
}

const GAP = 1e-6;

// Moved on the board: its dimensions take the values of the place it was
// dropped in, its order sits between its new neighbours.
export async function moveCard(
  db: D1Database,
  card: Card,
  author: string,
  move: Move,
  known: Record<FreeDimension, string[]>,
  reason?: string,
): Promise<Card> {
  const tags = tagsOf(card);
  let body = card.body;
  const changes: { dimension: Dimension; from: string | null; to: string | null }[] = [];
  for (const dimension of DIMENSIONS) {
    if (!(dimension in move.set)) continue;
    const raw = move.set[dimension] ?? null;
    if (dimension === "kind") {
      if (!isKind(raw) || raw === tags.kind) continue;
      changes.push({ dimension, from: tags.kind, to: raw });
      tags.kind = raw;
    } else if (dimension === "status") {
      if (!isStatus(raw) || raw === tags.status) continue;
      changes.push({ dimension, from: tags.status, to: raw });
      tags.status = raw;
    } else {
      const value = canonical(known[dimension], cleanValue(raw));
      if (value === tags[dimension]) continue;
      changes.push({ dimension, from: tags[dimension], to: value });
      tags[dimension] = value;
      body = rewriteAnnotation(body, dimension, value);
    }
  }

  const position = await positionBetween(db, card, move.before, move.after);
  const statements: D1PreparedStatement[] = [];
  let rev = card.rev;
  if (changes.length) {
    rev += 1;
    statements.push(
      db
        .prepare(
          `UPDATE cards SET kind = ?, status = ?, body = ?, epic = ?, domain = ?, segment = ?, release = ?, position = ?, rev = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
        .bind(tags.kind, tags.status, body, tags.epic, tags.domain, tags.segment, tags.release, position, rev, card.id),
      revisionStatement(db, card.id, rev, { title: card.title, body, tags }, author, card.data),
      activityStatement(db, {
        actor: author,
        action: "card_moved",
        repo: card.repo,
        details: { card: card.id, title: card.title, changes, ...(reason ? { reason } : {}) },
      }),
    );
    if (body !== card.body) statements.push(...linkStatements(db, card.id, body));
  } else if (position !== card.position) {
    statements.push(db.prepare("UPDATE cards SET position = ? WHERE id = ?").bind(position, card.id));
  }
  if (statements.length) await db.batch(statements);
  return { ...card, ...tags, body, position, rev };
}

// A card's status follows its work: Shaping when Claude is asked, To
// validate when the need is clear, Validated when its story is made. It only
// moves forward, and never off Dropped nor on an archived card.
const STATUS_FLOW: CardStatus[] = ["draft", "shaping", "to_validate", "validated"];
const NO_VALUES: Record<FreeDimension, string[]> = { epic: [], domain: [], segment: [], release: [] };

export async function advanceStatus(db: D1Database, repo: string, id: number, author: string, to: CardStatus, reason: string): Promise<boolean> {
  const card = await findCard(db, repo, id);
  if (!card || card.archivedAt || card.status === "dropped") return false;
  if (STATUS_FLOW.indexOf(card.status) >= STATUS_FLOW.indexOf(to)) return false;
  await moveCard(db, card, author, { set: { status: to }, before: null, after: null }, NO_VALUES, reason);
  return true;
}

// A validated card whose feature changes (its text or its spec) is to
// validate again; its stories may need a review.
export async function reopenStatus(db: D1Database, repo: string, id: number, author: string, reason: string): Promise<boolean> {
  const card = await findCard(db, repo, id);
  if (!card || card.archivedAt || card.status !== "validated") return false;
  await moveCard(db, card, author, { set: { status: "to_validate" }, before: null, after: null }, NO_VALUES, reason);
  return true;
}

// The status chosen on the card's page.
export async function setStatus(db: D1Database, card: Card, author: string, to: CardStatus): Promise<boolean> {
  if (to === card.status) return false;
  await moveCard(db, card, author, { set: { status: to }, before: null, after: null }, NO_VALUES);
  return true;
}

async function positionOf(db: D1Database, repo: string, id: number | null): Promise<number | null> {
  if (!id) return null;
  const row = await db.prepare("SELECT position FROM cards WHERE id = ? AND repo = ?").bind(id, repo).first<{ position: number }>();
  return row?.position ?? null;
}

async function positionBetween(db: D1Database, card: Card, beforeId: number | null, afterId: number | null): Promise<number> {
  const [before, after] = await Promise.all([positionOf(db, card.repo, beforeId), positionOf(db, card.repo, afterId)]);
  if (before === null && after === null) return card.position;
  if (before === null) return (after ?? 0) + 1;
  if (after === null) return before - 1;
  if (before - after > GAP) return (before + after) / 2;
  // No room left between them: number the project's cards again, in order.
  await renumber(db, card.repo);
  const [b, a] = await Promise.all([positionOf(db, card.repo, beforeId), positionOf(db, card.repo, afterId)]);
  return b !== null && a !== null ? (a + b) / 2 : card.position;
}

async function renumber(db: D1Database, repo: string): Promise<void> {
  const { results } = await db.prepare("SELECT id FROM cards WHERE repo = ? ORDER BY position, id").bind(repo).all<{ id: number }>();
  await db.batch(results.map((row, index) => db.prepare("UPDATE cards SET position = ? WHERE id = ?").bind(index + 1, row.id)));
}

export async function addValue(db: D1Database, repo: string, dimension: FreeDimension, value: string, author: string): Promise<boolean> {
  const last = await db
    .prepare("SELECT MAX(position) AS position FROM card_values WHERE repo = ? AND dimension = ?")
    .bind(repo, dimension)
    .first<{ position: number | null }>();
  const result = await db
    .prepare("INSERT OR IGNORE INTO card_values (repo, dimension, value, position, created_by) VALUES (?, ?, ?, ?, ?)")
    .bind(repo, dimension, value, (last?.position ?? 0) + 1, author)
    .run();
  if (!result.meta.changes) return false;
  await activityStatement(db, { actor: author, action: "card_value_added", repo, details: { dimension, value } }).run();
  return true;
}

// Everything about a project's cards, versions included, to keep elsewhere.
export async function exportCards(db: D1Database, repo: string): Promise<unknown> {
  const cards = await listCards(db, repo);
  const [values, revisions, links] = await Promise.all([
    dimensionValues(db, repo, cards),
    db
      .prepare(
        `SELECT r.card_id, r.rev, r.title, r.body, r.tags, r.author, r.created_at FROM card_revisions r
         JOIN cards c ON c.id = r.card_id WHERE c.repo = ? ORDER BY r.card_id, r.rev`,
      )
      .bind(repo)
      .all<{ card_id: number; rev: number; title: string; body: string; tags: string; author: string; created_at: string }>(),
    db
      .prepare("SELECT l.card_id, l.kind, l.ref FROM card_links l JOIN cards c ON c.id = l.card_id WHERE c.repo = ?")
      .bind(repo)
      .all<{ card_id: number; kind: string; ref: string }>(),
  ]);
  return {
    project: repo,
    exportedAt: new Date().toISOString(),
    values,
    cards: cards.map((card) => ({
      ...card,
      links: links.results.filter((link) => link.card_id === card.id).map(({ kind, ref }) => ({ kind, ref })),
      revisions: revisions.results
        .filter((revision) => revision.card_id === card.id)
        .map((revision) => ({
          rev: revision.rev,
          title: revision.title,
          body: revision.body,
          tags: JSON.parse(revision.tags) as unknown,
          author: revision.author,
          at: revision.created_at,
        })),
    })),
  };
}

// ---- The board ---------------------------------------------------------

export type Axis = Dimension | "none";

export interface BoardFilters {
  kind: CardKind | null;
  status: CardStatus | null;
  // A free dimension's value; "" for "not set".
  values: Partial<Record<FreeDimension, string>>;
  q: string;
  all: boolean;
}

export interface BoardQuery {
  by: Axis;
  then: Axis;
  // Only the columns and rows that hold a card shown.
  hideEmpty: boolean;
  filters: BoardFilters;
}

export function isAxis(value: unknown): value is Axis {
  return value === "none" || isDimension(value);
}

export function readBoardQuery(params: URLSearchParams): BoardQuery {
  const by = params.get("by");
  const then = params.get("then");
  const kind = params.get("kind");
  const status = params.get("status");
  const values: Partial<Record<FreeDimension, string>> = {};
  for (const dimension of FREE_DIMENSIONS) {
    const value = params.get(dimension);
    if (value === "-") values[dimension] = "";
    else if (value) values[dimension] = value;
  }
  const axis = isAxis(by) ? by : "status";
  const second = isAxis(then) && then !== axis ? then : "none";
  return {
    by: axis,
    then: axis === "none" ? "none" : second,
    hideEmpty: params.get("empty") === "hide",
    filters: {
      kind: isKind(kind) ? kind : null,
      status: isStatus(status) ? status : null,
      values,
      q: (params.get("q") ?? "").trim().slice(0, 100),
      all: params.get("all") === "1",
    },
  };
}

export function filterCards(cards: Card[], filters: BoardFilters): Card[] {
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((card) => {
    if (!filters.all && (card.archivedAt || (card.status === "dropped" && filters.status !== "dropped"))) return false;
    if (filters.kind && card.kind !== filters.kind) return false;
    if (filters.status && card.status !== filters.status) return false;
    for (const dimension of FREE_DIMENSIONS) {
      const wanted = filters.values[dimension];
      if (wanted === undefined) continue;
      if ((card[dimension] ?? "") !== wanted) return false;
    }
    if (words.length) {
      const text = `${card.title} ${card.body} C${card.id}`.toLowerCase();
      if (!words.every((word) => text.includes(word))) return false;
    }
    return true;
  });
}

// The values of an axis, in their order; "" is "not set".
export function axisValues(axis: Axis, known: Record<FreeDimension, string[]>): string[] {
  if (axis === "none") return [""];
  if (axis === "kind") return [...CARD_KINDS];
  if (axis === "status") return [...CARD_STATUSES];
  return [...known[axis], ""];
}

export function valueOf(card: Card, axis: Axis): string {
  if (axis === "none") return "";
  return card[axis] ?? "";
}

export function valueLabel(axis: Axis, value: string): string {
  if (axis === "kind" && isKind(value)) return KIND_LABELS[value];
  if (axis === "status" && isStatus(value)) return STATUS_LABELS[value];
  return value || "Not set";
}
