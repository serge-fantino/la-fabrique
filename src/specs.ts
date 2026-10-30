import { cardRef } from "./card-views";
import { DIMENSION_LABELS, FREE_DIMENSIONS, KIND_LABELS, listCards, STATUS_LABELS, type Card, type CardSpec } from "./cards";
import { readMarkdown } from "./docs";
import type { Env } from "./env";
import { askJson, type CallOutcome } from "./llm";
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
  note: string;
}

function schemaFor(rubriques: Rubrique[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sections", "questions", "note"],
    properties: {
      sections: {
        type: "object",
        additionalProperties: false,
        required: rubriques.map((rubrique) => rubrique.cle),
        properties: Object.fromEntries(rubriques.map((rubrique) => [rubrique.cle, { type: "string" }])),
      },
      questions: { type: "array", items: { type: "string" } },
      note: { type: "string" },
    },
  };
}

// Stable for a project: cached across the calls on its cards.
function systemPrompt(project: Project, rubriques: Rubrique[], document: { path: string; text: string; cut: boolean } | null): string {
  const config = project.check?.config;
  const language = config?.langue === "en" ? "English" : "French";
  const sections = rubriques
    .map((rubrique) => `- "${rubrique.cle}": ${rubrique.titre}${rubrique.obligatoire ? " (required)" : ""}${rubrique.aide ? `. ${rubrique.aide}` : ""}`)
    .join("\n");
  return `You help a product person turn a feature card into a functional specification for the software project "${config?.nom || project.repo}" (${project.repo}). The people who build and test it read your text: be precise, short and concrete. Write in ${language}.

Rules:
- Describe what people must be able to do and see, not the technical solution.
- Acceptance criteria: one per line, each one checkable by a tester ("When I…, I see…"), as a Markdown task list ("- [ ] …").
- Keep to the card's scope. Whatever goes beyond it, or is not decided, goes in the open questions.
- Never invent facts about the project: what you are not sure of becomes a question.
- Respect the project's principles below; when the card conflicts with one, say so.
- Each section is Markdown, without a heading of its own. An empty string when there is nothing to say.

Answer with:
- "sections": the specification, one entry per section below;
- "questions": at most five questions to the person, whose answers would improve the specification (they are shown next to it, not in it);
- "note": one sentence on what you wrote or changed.

The sections, in order:
${sections}
${document ? `\nThe project's own description (${document.path}${document.cut ? ", cut to its beginning" : ""}):\n<document>\n${document.text}\n</document>` : ""}`;
}

async function cardContext(env: Env, project: Project, card: Card): Promise<string> {
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
  return `The card ${cardRef(card.id)}: “${card.title}” (${tags.join(", ")})
<card>
${card.body.trim() || "(no text)"}
</card>
${others.length ? `\nThe project's other cards, to spot overlaps:\n${others.join("\n")}\n` : ""}${open.length ? `\nThe project's open stories on GitHub, to spot what already exists:\n${open.join("\n")}\n` : ""}`;
}

function currentSpec(spec: CardSpec, rubriques: Rubrique[]): string {
  return rubriques.map((rubrique) => `## ${rubrique.titre} ("${rubrique.cle}")\n${spec.answers[rubrique.cle] || "(empty)"}`).join("\n\n");
}

export type SpecOutcome = { ok: true; spec: CardSpec; callId: number; costMicros: number | null } | { ok: false; message: string };

// Draft (no spec yet, or start again) or revise (the current spec and
// what should change).
export async function writeSpec(
  env: Env,
  project: Project,
  card: Card,
  login: string,
  request: { mode: "draft" | "revise"; instruction: string },
): Promise<SpecOutcome> {
  const rubriques = specRubriques(project);
  const [document, context] = await Promise.all([projectDocument(env, project), cardContext(env, project, card)]);
  const current = card.data.spec;
  const ask =
    request.mode === "revise" && current
      ? `${context}\nThe current specification:\n<spec>\n${currentSpec(current, rubriques)}\n</spec>\n${
          current.questions.length ? `\nYour previous questions:\n${current.questions.map((question) => `- ${question}`).join("\n")}\n` : ""
        }\nWhat the person asks now (answers to your questions, corrections):\n<request>\n${request.instruction || "Improve it."}\n</request>\n\nRevise the specification accordingly; keep what is not concerned.`
      : `${context}${request.instruction ? `\nWhat the person adds:\n<request>\n${request.instruction}\n</request>\n` : ""}\nWrite the specification of this card.`;

  const outcome: CallOutcome<SpecAnswer> = await askJson<SpecAnswer>(
    env,
    { login, repo: project.repo, cardId: card.id, purpose: request.mode === "revise" && current ? "spec_revise" : "spec_draft" },
    { system: systemPrompt(project, rubriques, document), user: ask, schema: schemaFor(rubriques) },
  );
  if (!outcome.ok || !outcome.value) return { ok: false, message: outcome.message ?? "Claude did not answer." };
  const answer = outcome.value;
  const answers = Object.fromEntries(rubriques.map((rubrique) => [rubrique.cle, String(answer.sections?.[rubrique.cle] ?? "").trim()]));
  const questions = (Array.isArray(answer.questions) ? answer.questions : []).map((question) => String(question).trim()).filter(Boolean).slice(0, 5);
  return {
    ok: true,
    spec: { answers, questions, source: "claude", note: String(answer.note ?? "").trim().slice(0, 500), at: new Date().toISOString() },
    callId: outcome.callId,
    costMicros: outcome.costMicros,
  };
}

// The spec as edited by hand.
export function readSpecForm(form: FormData, rubriques: Rubrique[], previous: CardSpec | undefined): CardSpec {
  const answers = Object.fromEntries(
    rubriques.map((rubrique) => [rubrique.cle, String(form.get(`s_${rubrique.cle}`) ?? "").replace(/\r\n/g, "\n").trim().slice(0, 20_000)]),
  );
  return { answers, questions: previous?.questions ?? [], source: "person", at: new Date().toISOString() };
}
