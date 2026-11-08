import { addDependency, projectLinks, DEPENDS } from "./card-dependencies";
import { cardRef, cardUrl } from "./card-views";
import {
  FINDING_KINDS,
  findCard,
  listCards,
  saveEpicReview,
  saveFeaturesProposal,
  type Card,
  type EpicNote,
  type EpicReview,
  type FindingKind,
  type ReviewFinding,
} from "./cards";
import type { Env } from "./env";
import { askJson, type CallOutcome, type Progress } from "./llm";
import type { Project } from "./projects";
import { cycleRules } from "./lifecycle";
import { csrfField, escapeHtml, type Viewer } from "./views";
import { currentSpec, epicContext, epicFeatures, epicRubriques, projectDocument, type SpecReading } from "./specs";

// Claude reviews an epic against its features (la-fabrique#283): what the
// document asks that no feature covers, features that overlap, a feature that
// goes against a decision, dependencies forgotten. Each finding is a
// proposal; nothing changes until the person applies one.

export const KIND_TITLES: Record<FindingKind, string> = {
  uncovered: "Uncovered needs",
  overlap: "Overlaps",
  conflict: "Conflicts with a decision",
  dependency: "Missing dependencies",
};

const APPLY_LABELS: Record<FindingKind, string> = {
  uncovered: "Open the feature preview",
  overlap: "Note it on the epic",
  conflict: "Note it on the epic",
  dependency: "Add the dependency",
};

interface ReviewAnswer {
  findings: { kind: string; title: string; detail: string; features: string[]; draft_title: string; draft_synopsis: string; draft_need: string; draft_priority: string }[];
  note: string;
}

function reviewSchema(priorities: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings", "note"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "detail", "features", "draft_title", "draft_synopsis", "draft_need", "draft_priority"],
          properties: {
            kind: { type: "string", enum: [...FINDING_KINDS] },
            title: { type: "string" },
            detail: { type: "string" },
            features: { type: "array", items: { type: "string" } },
            draft_title: { type: "string" },
            draft_synopsis: { type: "string" },
            draft_need: { type: "string" },
            draft_priority: priorities.length ? { type: "string", enum: ["", ...priorities] } : { type: "string" },
          },
        },
      },
      note: { type: "string" },
    },
  };
}

function systemPrompt(project: Project, document: { path: string; text: string; cut: boolean } | null): string {
  const language = project.check?.config?.langue === "en" ? "English" : "French";
  return `You review an epic, a theme of work, against its features for the software project "${project.check?.config?.nom || project.repo}" (${project.repo}). Be precise, short and concrete, write in ${language}, never invent facts, and report only real findings: none is a fine answer. You change nothing: every finding is a proposal the person decides on.
${document ? `\nThe project's own description (${document.path}${document.cut ? ", cut to its beginning" : ""}):\n<document>\n${document.text}\n</document>` : ""}`;
}

export type ReviewOutcome =
  | { ok: true; review: EpicReview; callId: number; costMicros: number | null }
  | { ok: false; message: string; retryable: boolean };

// "C12" / "12" to 12, only for a card of the epic's features.
function featureId(raw: unknown, allowed: Set<number>): number | null {
  const match = /^\s*C?\s*#?(\d{1,9})\s*$/i.exec(String(raw ?? ""));
  const n = match ? Number(match[1]) : NaN;
  return allowed.has(n) ? n : null;
}

export async function reviewEpic(
  env: Env,
  project: Project,
  epic: Card,
  login: string,
  instruction: string,
  watch: { read?: (reading: SpecReading) => void; progress?: (progress: Progress) => void } = {},
): Promise<ReviewOutcome> {
  const document = epic.data.spec ? currentSpec(epic.data.spec, epicRubriques(project)) : epic.body.trim();
  if (!document) return { ok: false, message: "The epic has no document yet: write it first.", retryable: false };
  const priorities = cycleRules(project.check?.config).priorities;
  const [description, read, cards, links] = await Promise.all([projectDocument(env, project), epicContext(env, project, epic), listCards(env.DB, project.repo), projectLinks(env.DB, project.repo)]);
  watch.read?.({ document: description ? `${description.path} (${Math.round(description.text.length / 1000)}k characters)` : null, cards: read.cards, stories: 0 });
  const features = epicFeatures(cards, epic).slice(0, 80);
  if (!features.length) return { ok: false, message: "The epic has no feature to review yet: attach or propose some first.", retryable: false };
  const ids = new Set(features.map((feature) => feature.id));
  const depends = links.filter((link) => link.kind === DEPENDS && ids.has(link.card_id)).map((link) => `- ${cardRef(link.card_id)} depends on ${cardRef(Number(link.ref))}`);
  const ask = `${read.text}
The epic's document:
<document>
${document}
</document>
${depends.length ? `\nDependencies already set:\n${depends.join("\n")}\n` : ""}${instruction ? `\nThe person asks:\n<request>\n${instruction}\n</request>\n` : ""}
Review the epic against its features. Report, as "findings", only these kinds:
- "uncovered": a need the document asks for that no feature covers. Give "draft_title", "draft_synopsis", "draft_need" (and "draft_priority") for a feature that would cover it; "features" empty.
- "overlap": two or more features that do the same thing. "features": their numbers ("C12").
- "conflict": a feature that goes against a decision of the document (its Decisions section) or a principle of the project. "features": that feature; "detail" quotes the decision.
- "dependency": a feature that needs another one first and has no dependency set. "features": exactly two, the one that depends first ("C12"), then the one it depends on.
"title": one line. "detail": two or three sentences with the reason. For a kind that does not use the draft, leave the draft fields empty. Use only the feature numbers listed above. Do not report a dependency already set. "note": one sentence on the overall state of the epic.`;
  const outcome: CallOutcome<ReviewAnswer> = await askJson<ReviewAnswer>(
    env,
    { login, repo: project.repo, cardId: epic.id, purpose: "epic_review" },
    { system: systemPrompt(project, description), user: ask, schema: reviewSchema(priorities), ...(watch.progress ? { progress: watch.progress } : {}) },
  );
  if (!outcome.ok || !outcome.value) return { ok: false, message: outcome.message ?? "Claude did not answer.", retryable: outcome.retryable ?? false };
  const findings: ReviewFinding[] = [];
  for (const said of (Array.isArray(outcome.value.findings) ? outcome.value.findings : []).slice(0, 30)) {
    const kind = FINDING_KINDS.find((k) => k === said.kind);
    const title = String(said.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!kind || !title) continue;
    const concerned = [...new Set((Array.isArray(said.features) ? said.features : []).map((f) => featureId(f, ids)).filter((n): n is number => n !== null))];
    const finding: ReviewFinding = { kind, title, detail: String(said.detail ?? "").trim().slice(0, 2000), cards: concerned, state: "open" };
    if (kind === "uncovered") {
      const draftTitle = String(said.draft_title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!draftTitle) continue;
      finding.cards = [];
      finding.draft = {
        title: draftTitle,
        synopsis: String(said.draft_synopsis ?? "").trim().slice(0, 4000),
        need: String(said.draft_need ?? "").trim().slice(0, 4000),
        priority: priorities.includes(String(said.draft_priority)) ? String(said.draft_priority) : null,
      };
    } else if (kind === "dependency") {
      if (concerned.length !== 2 || concerned[0] === concerned[1]) continue;
      finding.cards = concerned;
    } else if (!concerned.length || (kind === "overlap" && concerned.length < 2)) continue;
    findings.push(finding);
  }
  return {
    ok: true,
    review: { findings, note: String(outcome.value.note ?? "").trim().slice(0, 500), specAt: epic.data.spec?.at ?? "", at: new Date().toISOString() },
    callId: outcome.callId,
    costMicros: outcome.costMicros,
  };
}

export type ApplyOutcome = { ok: true; result: string; preview?: boolean } | { ok: false; reason: string };

// Applies one finding, and only the change it names:
// - uncovered: the draft joins the epic's proposed features, to review in the
//   preview (no card is created here);
// - dependency: the dependency is added;
// - overlap, conflict: a note on the epic.
// Dismissing changes nothing but the finding.
export async function applyFinding(db: D1Database, project: Project, epic: Card, login: string, index: number, dismiss: boolean): Promise<ApplyOutcome> {
  const review = epic.data.review;
  const finding = review?.findings[index];
  if (!review || !finding) return { ok: false, reason: "That finding is gone." };
  if (finding.state !== "open") return { ok: false, reason: "That finding is already dealt with." };
  const settle = (state: "applied" | "dismissed", result: string, notes?: EpicNote[]) => {
    const findings = review.findings.map((f, i) => (i === index ? { ...f, state, result } : f));
    return saveEpicReview(db, epic, login, { ...review, findings }, {
      ...(notes ? { notes } : {}),
      journal: { action: state === "applied" ? "epic_finding_applied" : "epic_finding_dismissed", details: { finding: finding.kind, title: finding.title, cards: finding.cards, result } },
    });
  };
  if (dismiss) {
    await settle("dismissed", "Dismissed.");
    return { ok: true, result: "Dismissed." };
  }
  if (finding.kind === "dependency") {
    const [from, to] = finding.cards;
    const card = from ? await findCard(db, project.repo, from) : null;
    if (!card || !to) return { ok: false, reason: "That feature is gone." };
    const outcome = await addDependency(db, project.repo, card, { card: to }, login);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    const result = `${cardRef(card.id)} now depends on ${cardRef(to)}.`;
    await settle("applied", result);
    return { ok: true, result };
  }
  if (finding.kind === "uncovered") {
    const draft = finding.draft;
    if (!draft) return { ok: false, reason: "That finding has no draft." };
    // Joins the proposal already waiting, or opens one.
    const proposal = epic.data.featuresProposal ?? { features: [], specAt: epic.data.spec?.at ?? "", at: new Date().toISOString() };
    const added = { ...proposal, features: [...proposal.features, { ...draft, depends: [] }] };
    await saveFeaturesProposal(db, epic, login, added);
    const fresh = (await findCard(db, project.repo, epic.id)) ?? epic;
    const result = "Proposed as a feature, to review in the preview before any card is created.";
    const findings = review.findings.map((f, i) => (i === index ? { ...f, state: "applied" as const, result } : f));
    await saveEpicReview(db, fresh, login, { ...review, findings }, { journal: { action: "epic_finding_applied", details: { finding: finding.kind, title: finding.title, cards: [], result } } });
    return { ok: true, result, preview: true };
  }
  const note: EpicNote = { at: new Date().toISOString(), by: login, kind: finding.kind, text: `${finding.title}\n${finding.detail}`.trim(), cards: finding.cards };
  const result = "Noted on the epic.";
  await settle("applied", result, [...(epic.data.notes ?? []), note]);
  return { ok: true, result };
}

// The review on the epic's page: findings by kind, an action on each.
export function reviewHtml(viewer: Viewer, project: Project, epic: Card, canWrite: boolean, titles: Map<number, string>): string {
  const review = epic.data.review;
  if (!review) return "";
  const url = cardUrl(project.repo, epic.id);
  const named = (n: number): string => `<a href="${escapeHtml(cardUrl(project.repo, n))}"><span class="mono">${cardRef(n)}</span> ${escapeHtml(titles.get(n) ?? "")}</a>`;
  const item = (finding: ReviewFinding, index: number): string => {
    const open = finding.state === "open";
    const actions =
      open && canWrite
        ? `<form method="post" action="${escapeHtml(url)}" class="inline" data-busy>${csrfField(viewer)}
            <input type="hidden" name="finding" value="${index}" />
            <button type="submit" class="button small" name="action" value="review_apply">${APPLY_LABELS[finding.kind]}</button>
            <button type="submit" class="button quiet small" name="action" value="review_dismiss">Dismiss</button></form>`
        : "";
    const status = finding.state === "open" ? "" : ` <span class="pill">${finding.state === "applied" ? "Applied" : "Dismissed"}</span> <span class="muted small">${escapeHtml(finding.result ?? "")}</span>`;
    const draft = finding.draft ? `<p class="muted small">Draft feature: ${escapeHtml(finding.draft.title)}</p>` : "";
    return `<li><strong>${escapeHtml(finding.title)}</strong>${status}
      <p>${escapeHtml(finding.detail)}</p>${draft}
      ${finding.cards.length ? `<p class="small">${finding.kind === "dependency" ? `${named(finding.cards[0] ?? 0)} → ${named(finding.cards[1] ?? 0)}` : finding.cards.map(named).join(", ")}</p>` : ""}
      ${actions}</li>`;
  };
  const groups = FINDING_KINDS.map((kind) => {
    const list = review.findings.map((finding, index) => ({ finding, index })).filter((entry) => entry.finding.kind === kind);
    return `<h3>${KIND_TITLES[kind]} <span class="muted small">${list.length}</span></h3>${list.length ? `<ul class="card-stories">${list.map((e) => item(e.finding, e.index)).join("")}</ul>` : `<p class="muted">None.</p>`}`;
  }).join("");
  const outdated = (epic.data.spec?.at ?? "") !== review.specAt ? `<p class="notice error">The epic's document changed since this review.</p>` : "";
  return `<section id="review"><h2>Review by Claude</h2>${outdated}
    <p>${review.note ? `${escapeHtml(review.note)} ` : ""}Nothing is changed until you apply a finding.</p>${groups}
    ${canWrite ? `<form method="post" action="${escapeHtml(url)}" class="inline" data-busy>${csrfField(viewer)}<button type="submit" class="button quiet" name="action" value="review_discard">Discard the review</button></form>` : ""}
  </section>`;
}

export function notesHtml(epic: Card, titles: Map<number, string>, repo: string): string {
  const notes = epic.data.notes ?? [];
  if (!notes.length) return "";
  return `<section id="notes"><h2>Notes</h2><ul class="card-stories">${notes
    .map((note) => `<li><span class="muted small">${escapeHtml(note.at.slice(0, 10))} · @${escapeHtml(note.by)} · ${KIND_TITLES[note.kind]}</span><p>${escapeHtml(note.text).replace(/\n/g, "<br />")}</p>${note.cards
      .map((n) => `<a href="${escapeHtml(cardUrl(repo, n))}"><span class="mono">${cardRef(n)}</span> ${escapeHtml(titles.get(n) ?? "")}</a>`)
      .join(" ")}</li>`)
    .join("")}</ul></section>`;
}
