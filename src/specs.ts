import { cardRef } from "./card-views";
import { cardStories, type CardStory } from "./card-stories";
import { cardLinks, DIMENSION_LABELS, FREE_DIMENSIONS, KIND_LABELS, listCards, STATUS_LABELS, type Card, type CardSpec, type CardSplit, type StoryReview } from "./cards";
import { readMarkdown } from "./docs";
import type { Env } from "./env";
import { STAGES } from "./lifecycle";
import { askJson, type CallOutcome, type Progress } from "./llm";
import type { Project } from "./projects";
import type { Rubrique } from "./requests";
import { loadStories } from "./stories";

// A card's functional spec, written with Claude (la-fabrique#74): in the
// project's request sections, from the card, the project's own principles
// and what it already has; then a story on GitHub, made from it.

// When a project declares no request form, the spec still has a shape.
const DEFAULT_RUBRIQUES: Rubrique[] = [
  { cle: "context", titre: "Context", obligatoire: true, aide: "What happens today, for whom, and why it is not good enough." },
  { cle: "need", titre: "Need", obligatoire: true, aide: "What the person must be able to do, said simply. Not the technical solution." },
  { cle: "criteria", titre: "Acceptance criteria", obligatoire: true, aide: "One line per criterion, checkable by a tester (\"When I…, I see…\")." },
  { cle: "questions", titre: "Open questions", aide: "What remains to decide before coding." },
];

export function specRubriques(project: Project): Rubrique[] {
  const declared = project.check?.config?.demandes?.rubriques ?? [];
  return declared.length ? declared : DEFAULT_RUBRIQUES;
}

export function missingSections(spec: CardSpec | undefined, rubriques: Rubrique[]): string[] {
  return rubriques.filter((rubrique) => rubrique.obligatoire && !spec?.answers[rubrique.cle]?.trim()).map((rubrique) => rubrique.titre);
}

// The project's principles, as the project writes them: CLAUDE.md when it
// publishes one, else its first published page. Read from the cache by
// commit, like its documentation pages.
const MAX_DOCUMENT = 300_000;

async function projectDocument(env: Env, project: Project): Promise<{ path: string; text: string; cut: boolean } | null> {
  const check = project.check;
  const pages = check?.docPages ?? [];
  if (!check || !pages.length) return null;
  const path = pages.find((page) => page === "CLAUDE.md") ?? pages.find((page) => /readme\.md$/i.test(page)) ?? pages[0];
  if (!path) return null;
  try {
    const text = await readMarkdown(env, project, null, check.commitSha, path);
    return { path, text: text.slice(0, MAX_DOCUMENT), cut: text.length > MAX_DOCUMENT };
  } catch {
    return null;
  }
}

interface SpecAnswer {
  sections: Record<string, string>;
  questions: string[];
  enough: boolean;
  note: string;
}

function schemaFor(rubriques: Rubrique[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sections", "questions", "enough", "note"],
    properties: {
      sections: {
        type: "object",
        additionalProperties: false,
        required: rubriques.map((rubrique) => rubrique.cle),
        properties: Object.fromEntries(rubriques.map((rubrique) => [rubrique.cle, { type: "string" }])),
      },
      questions: { type: "array", items: { type: "string" } },
      enough: { type: "boolean" },
      note: { type: "string" },
    },
  };
}

// Stable for a project: cached across the calls on its cards, whatever
// the task (writing the spec, splitting it); what to answer is in the
// request.
function systemPrompt(project: Project, rubriques: Rubrique[], document: { path: string; text: string; cut: boolean } | null): string {
  const config = project.check?.config;
  const language = config?.langue === "en" ? "English" : "French";
  const sections = rubriques
    .map((rubrique) => `- "${rubrique.cle}": ${rubrique.titre}${rubrique.obligatoire ? " (required)" : ""}${rubrique.aide ? `. ${rubrique.aide}` : ""}`)
    .join("\n");
  return `You help a product person specify a feature, from its card, for the software project "${config?.nom || project.repo}" (${project.repo}). The people who build and test it read your text: be precise, short and concrete. Write in ${language}.

Your first job is to frame the need, like a product manager interviewing the person who wrote the card:
- When the card leaves something essential open (who it is for, what triggers it, what counts as done, what happens at the edges, what it must not do), ask. Ask at most five questions, the most decisive first, each answerable in a sentence or two, and never one the card, the project's description or an earlier answer already settles.
- Write the sections you can from what you know; leave a section empty rather than invent what nobody said.
- Stop asking when you could write the stories without guessing: set "enough" to true, ask nothing, and say in the note what makes the need clear. Until then "enough" is false.
- From the third round on, ask only what blocks the specification. When the person closes the questions, ask nothing more.

Rules for the specification:
- Describe what people must be able to do and see, not the technical solution.
- Acceptance criteria: one per line, each one checkable by a tester ("When I…, I see…"), as a Markdown task list ("- [ ] …").
- Keep to the card's scope. Whatever goes beyond it, or is not decided, goes in the open questions.
- Never invent facts about the project: what you are not sure of becomes a question.
- Respect the project's principles below; when the card conflicts with one, say so.
- Each section is Markdown, without a heading of its own. An empty string when there is nothing to say.

The sections of a specification (and of each story), in order:
${sections}
${document ? `\nThe project's own description (${document.path}${document.cut ? ", cut to its beginning" : ""}):\n<document>\n${document.text}\n</document>` : ""}`;
}

async function cardContext(env: Env, project: Project, card: Card): Promise<{ text: string; cards: number; stories: number }> {
  const [cards, stories] = await Promise.all([listCards(env.DB, project.repo), loadStories(env, project)]);
  const others = cards
    .filter((other) => other.id !== card.id && !other.archivedAt)
    .slice(0, 80)
    .map((other) => `- ${cardRef(other.id)} ${other.title} (${STATUS_LABELS[other.status]})`);
  const open = stories.stories
    .filter((story) => story.state === "open")
    .slice(0, 150)
    .map((story) => `- #${story.number} ${story.title}`);
  const tags = [
    `type ${KIND_LABELS[card.kind]}`,
    `status ${STATUS_LABELS[card.status]}`,
    ...FREE_DIMENSIONS.filter((dimension) => card[dimension]).map((dimension) => `${DIMENSION_LABELS[dimension].toLowerCase()} ${card[dimension]}`),
  ];
  const text = `The card ${cardRef(card.id)}: “${card.title}” (${tags.join(", ")})
<card>
${card.body.trim() || "(no text)"}
</card>
${others.length ? `\nThe project's other cards, to spot overlaps:\n${others.join("\n")}\n` : ""}${open.length ? `\nThe project's open stories on GitHub, to spot what already exists:\n${open.join("\n")}\n` : ""}`;
  return { text, cards: others.length, stories: open.length };
}

function currentSpec(spec: CardSpec, rubriques: Rubrique[]): string {
  return rubriques.map((rubrique) => `## ${rubrique.titre} ("${rubrique.cle}")\n${spec.answers[rubrique.cle] || "(empty)"}`).join("\n\n");
}

const SPEC_ANSWER = `Answer with:
- "sections": the specification, one entry per section;
- "questions": your questions to the person, at most five, none already answered or left unanswered on purpose (they are shown under the specification, each with a field for the answer);
- "enough": whether you know enough to write the stories;
- "note": one sentence on what you wrote or changed.`;

export interface Answer {
  question: string;
  answer: string;
}

export type SpecOutcome =
  | { ok: true; spec: CardSpec; callId: number; costMicros: number | null }
  | { ok: false; message: string; retryable: boolean };

// What Claude was given to read, for the job's log.
export interface SpecReading {
  document: string | null;
  cards: number;
  stories: number;
}

// Draft (no spec yet, or start again) or revise (the current spec and
// what should change).
export async function writeSpec(
  env: Env,
  project: Project,
  card: Card,
  login: string,
  request: { mode: "draft" | "revise"; instruction: string; answers?: Answer[] },
  watch: { read?: (reading: SpecReading) => void; progress?: (progress: Progress) => void } = {},
): Promise<SpecOutcome> {
  const rubriques = specRubriques(project);
  const [document, read] = await Promise.all([projectDocument(env, project), cardContext(env, project, card)]);
  watch.read?.({ document: document ? `${document.path} (${Math.round(document.text.length / 1000)}k characters)` : null, cards: read.cards, stories: read.stories });
  const context = read.text;
  const current = card.data.spec;
  const round = (current?.rounds ?? 0) + 1;
  const answers = (request.answers ?? []).filter((turn) => turn.answer.trim());
  const earlier = current?.dialogue ?? [];
  const history = earlier.length
    ? `\nQuestions you asked before, and their answers:\n${earlier
        .map((turn) => `- Q: ${turn.question}\n  A: ${turn.skipped ? "(left unanswered on purpose)" : turn.answer}`)
        .join("\n")}\n`
    : "";
  const now = [
    answers.length ? `The person answers your questions:\n${answers.map((turn) => `- Q: ${turn.question}\n  A: ${turn.answer}`).join("\n")}` : "",
    request.instruction ? `The person asks:\n<request>\n${request.instruction}\n</request>` : "",
    current?.closed ? "The person closed the questions: ask nothing more, and set enough to true." : round >= 3 ? `This is round ${round}: ask only what blocks the specification.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const ask =
    request.mode === "revise" && current
      ? `${context}\nThe current specification:\n<spec>\n${currentSpec(current, rubriques)}\n</spec>\n${history}\n${now || "Improve it."}\n\nRevise the specification accordingly; keep what is not concerned.\n\n${SPEC_ANSWER}`
      : `${context}${history}${now ? `\n${now}\n` : ""}\nWrite the specification of this card.\n\n${SPEC_ANSWER}`;

  const outcome: CallOutcome<SpecAnswer> = await askJson<SpecAnswer>(
    env,
    { login, repo: project.repo, cardId: card.id, purpose: request.mode === "revise" && current ? "spec_revise" : "spec_draft" },
    { system: systemPrompt(project, rubriques, document), user: ask, schema: schemaFor(rubriques), ...(watch.progress ? { progress: watch.progress } : {}) },
  );
  if (!outcome.ok || !outcome.value) return { ok: false, message: outcome.message ?? "Claude did not answer.", retryable: outcome.retryable ?? false };
  const answer = outcome.value;
  // The sections come from Claude; `answers` are the person's.
  const sections = Object.fromEntries(rubriques.map((rubrique) => [rubrique.cle, String(answer.sections?.[rubrique.cle] ?? "").trim()]));
  const enough = answer.enough === true || Boolean(current?.closed);
  const questions = enough ? [] : (Array.isArray(answer.questions) ? answer.questions : []).map((question) => String(question).trim()).filter(Boolean).slice(0, 5);
  const at = new Date().toISOString();
  const dialogue = [...earlier, ...answers.map((turn) => ({ question: turn.question, answer: turn.answer.trim(), at }))].slice(-40);
  return {
    ok: true,
    spec: {
      answers: sections,
      questions,
      source: "claude",
      note: String(answer.note ?? "").trim().slice(0, 500),
      ...(dialogue.length ? { dialogue } : {}),
      rounds: round,
      ...(enough ? { enough: true } : {}),
      ...(current?.closed ? { closed: true } : {}),
      at,
    },
    callId: outcome.callId,
    costMicros: outcome.costMicros,
  };
}

// The spec as edited by hand.
export function readSpecForm(form: FormData, rubriques: Rubrique[], previous: CardSpec | undefined): CardSpec {
  const answers = Object.fromEntries(
    rubriques.map((rubrique) => [rubrique.cle, String(form.get(`s_${rubrique.cle}`) ?? "").replace(/\r\n/g, "\n").trim().slice(0, 20_000)]),
  );
  return {
    answers,
    questions: previous?.questions ?? [],
    source: "person",
    ...(previous?.dialogue ? { dialogue: previous.dialogue } : {}),
    ...(previous?.rounds ? { rounds: previous.rounds } : {}),
    ...(previous?.enough ? { enough: true } : {}),
    ...(previous?.closed ? { closed: true } : {}),
    at: new Date().toISOString(),
  };
}

// The person decides Claude knows enough: the open questions are kept as
// left unanswered, and Claude asks nothing more unless asked.
export function closeQuestions(spec: CardSpec): CardSpec {
  const at = new Date().toISOString();
  const left = spec.questions.map((question) => ({ question, answer: "", at, skipped: true }));
  return { ...spec, questions: [], dialogue: [...(spec.dialogue ?? []), ...left].slice(-40), closed: true, at };
}

// ---- Split into stories ------------------------------------------------------

// A story already made, as Claude reads it.
function storyForClaude(story: CardStory): string {
  const stage = story.closed && story.stage !== "done" ? "closed" : (STAGES.find((candidate) => candidate.id === story.stage)?.label ?? "unknown stage");
  const criteria = story.criteria.length ? `\n${story.criteria.map((criterion) => `  - [${criterion.done ? "x" : " "}] ${criterion.text}`).join("\n")}` : "";
  return `#${story.number} “${story.title}” (${stage})${criteria}`;
}

interface SplitAnswer {
  stories: { title: string; sections: Record<string, string> }[];
  existing?: { number: number; verdict: string; comment: string }[];
  note: string;
}

function splitSchema(rubriques: Rubrique[], review: boolean): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["stories", "note", ...(review ? ["existing"] : [])],
    properties: {
      ...(review
        ? {
            existing: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["number", "verdict", "comment"],
                properties: { number: { type: "integer" }, verdict: { type: "string", enum: ["fits", "change"] }, comment: { type: "string" } },
              },
            },
          }
        : {}),
      stories: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "sections"],
          properties: {
            title: { type: "string" },
            sections: {
              type: "object",
              additionalProperties: false,
              required: rubriques.map((rubrique) => rubrique.cle),
              properties: Object.fromEntries(rubriques.map((rubrique) => [rubrique.cle, { type: "string" }])),
            },
          },
        },
      },
      note: { type: "string" },
    },
  };
}

export type SplitOutcome =
  | { ok: true; split: CardSplit; callId: number; costMicros: number | null }
  | { ok: false; message: string; retryable: boolean };

// Claude proposes stories that each can be built, tested on int and
// shipped alone; nothing goes to GitHub before the person reviews them.
export async function splitSpec(
  env: Env,
  project: Project,
  card: Card,
  login: string,
  instruction: string,
  watch: { read?: (reading: SpecReading) => void; progress?: (progress: Progress) => void } = {},
): Promise<SplitOutcome> {
  const spec = card.data.spec;
  if (!spec) return { ok: false, message: "There is no spec to split yet.", retryable: false };
  const rubriques = specRubriques(project);
  const numbers = (await cardLinks(env.DB, card.id)).filter((link) => link.kind === "story").map((link) => Number(link.ref));
  const [document, read, made] = await Promise.all([projectDocument(env, project), cardContext(env, project, card), cardStories(env, project, numbers)]);
  const existing = [...made.values()];
  watch.read?.({ document: document ? `${document.path} (${Math.round(document.text.length / 1000)}k characters)` : null, cards: read.cards, stories: read.stories });
  const ask = existing.length
    ? `${read.text}
The specification:
<spec>
${currentSpec(spec, rubriques)}
</spec>

The stories already made from this card, on GitHub; the specification may have changed since:
<stories>
${existing.map(storyForClaude).join("\n\n")}
</stories>
${instruction ? `\nThe person asks:\n<request>\n${instruction}\n</request>\n` : ""}
Review these stories against the specification.
- "existing": one entry per story above. "fits" when it still matches the specification, with an empty comment. "change" otherwise, with a comment for the team, written in the language of the specification: what to add, change or remove in this story, short and concrete. A story in production or closed does not change any more: say instead what a new story has to do, and propose that story.
- "stories": only the new stories for what the existing ones do not cover; none is a fine answer. Each can be built, tested on int and put in production on its own. "title": short, what the person can do once the story is there. "sections": the story's own specification, in the same sections, with its own acceptance criteria.
- "note": one sentence on what changed and what to do first.`
    : `${read.text}
The specification to split:
<spec>
${currentSpec(spec, rubriques)}
</spec>
${instruction ? `\nThe person asks:\n<request>\n${instruction}\n</request>\n` : ""}
Split this specification into stories. Each story can be built, tested on int and put in production on its own, and gives people something they can see; together they cover the whole specification, without overlap. As few stories as make sense, from one to six: one story is a fine answer for a small feature.
- "title": short, what the person can do once the story is there.
- "sections": the story's own specification, in the same sections. Its acceptance criteria are its own: each criterion of the specification belongs to exactly one story. The context can be shared; say what this story adds. The release note says what this story makes visible.
- "note": one sentence on how you split, and in which order to build the stories.`;
  const outcome: CallOutcome<SplitAnswer> = await askJson<SplitAnswer>(
    env,
    { login, repo: project.repo, cardId: card.id, purpose: "spec_split" },
    { system: systemPrompt(project, rubriques, document), user: ask, schema: splitSchema(rubriques, existing.length > 0), ...(watch.progress ? { progress: watch.progress } : {}) },
  );
  if (!outcome.ok || !outcome.value) return { ok: false, message: outcome.message ?? "Claude did not answer.", retryable: outcome.retryable ?? false };
  const stories = (Array.isArray(outcome.value.stories) ? outcome.value.stories : [])
    .slice(0, 8)
    .map((story) => ({
      title: String(story.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      answers: Object.fromEntries(rubriques.map((rubrique) => [rubrique.cle, String(story.sections?.[rubrique.cle] ?? "").trim()])),
    }))
    .filter((story) => story.title);
  const said = Array.isArray(outcome.value.existing) ? outcome.value.existing : [];
  const review: StoryReview[] = existing.map((story) => {
    const entry = said.find((candidate) => Number(candidate.number) === story.number);
    const comment = String(entry?.comment ?? "").trim().slice(0, 4000);
    return { number: story.number, title: story.title, verdict: entry?.verdict === "change" && comment ? "change" : "fits", comment };
  });
  if (existing.length) {
    return {
      ok: true,
      split: { stories, review, note: String(outcome.value.note ?? "").trim().slice(0, 500), specAt: spec.at, at: new Date().toISOString() },
      callId: outcome.callId,
      costMicros: outcome.costMicros,
    };
  }
  if (!stories.length) return { ok: false, message: "Claude proposed no story. Try again, or make one story from the whole spec.", retryable: false };
  return {
    ok: true,
    split: { stories, note: String(outcome.value.note ?? "").trim().slice(0, 500), specAt: spec.at, at: new Date().toISOString() },
    callId: outcome.callId,
    costMicros: outcome.costMicros,
  };
}
