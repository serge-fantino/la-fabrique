import { loadStoryDetail, storyDetailPage } from "./story-detail";
import { goSummary, lastGo } from "./go";
import { loadProduction } from "./production";
import { goSection } from "./production-views";
import { storyChecks } from "./validation";
import { boardPage, cardFormPage, cardPage, cardPermalink, cardRef, cardTile, cardUrl, importPage, specFormPage, splitPage, storyPage, type StoryState } from "./card-views";
import { isFixedLane, knownValues, NEXT_RELEASE, nextVersion, plannedSpelling, planningProblem, SPRINT_LANE } from "./card-releases";
import { cardStories } from "./card-stories";
import { isNice, storyCards } from "./card-groups";
import { releasePage, releaseWarningPage, sprintPage } from "./sprint-views";
import { cardProgress, isProgressStage, progressSince } from "./card-progress";
import { canMerge, lastMergeAttempts, mergePull, mergeWorkflow, pullDetails, requestReview, reviewers } from "./sprint-pulls";
import { activeSprint, latestSprint, moveCardInRelease, moveStoryInCard, orderCardsInRelease, orderStoriesInCard, setNice, setSprintVersion } from "./sprints";
import { closeSprint, sprintVersionProblem, sprintVersions, startSprint } from "./sprint-flow";
import { hasIntegration, lastReleaseAttempt, loadPlan, proposeVersion, publishWorkflow, startRelease, type ReleaseKind } from "./sprint-release";
import { loadReleases } from "./roadmap";
import { canLaunchClaude, claudeCap, claudeLaunches, claudeRuns, claudeWorkflow, isRunning, launchClaude, updateWithClaude } from "./claude";
import { heldStories } from "./card-lock";
import { loadPlan as loadRunPlan, newRun, runRefusal, sprintRunFor } from "./sprint-run";
import { runPreviewPage, runSection } from "./sprint-run-views";
import { applyCardPriority, markReady, storyPriority } from "./card-priority";
import { setPriority } from "./backlog";
import { cycleRules, isReadyStage, projectRules } from "./lifecycle";
import {
  addValue,
  archiveCard,
  cardLinks,
  cardRevisions,
  cleanValue,
  createCard,
  dimensionValues,
  DIMENSIONS,
  exportCards,
  importCards,
  filterCards,
  findCard,
  isFreeDimension,
  isKind,
  isStatus,
  listCards,
  moveCard,
  readBoardQuery,
  readCardForm,
  linkStory,
  restoreRevision,
  saveSpec,
  saveSplit,
  advanceStatus,
  setCardPriority,
  reopenStatus,
  setStatus,
  shownStatus,
  updateCard,
  type CardSplit,
  type Card,
  type CardInput,
  type Dimension,
  type FreeDimension,
} from "./cards";
import { activityStatement } from "./activity-log";
import type { Env } from "./env";
import { html, json, redirect } from "./http";
import { allowance, cardCalls, cardSpends } from "./llm";
import { findProject, type Project } from "./projects";
import { commentIssue, createRequest, issueBody, type RequestDraft, type Rubrique } from "./requests";
import { closeQuestions, missingSections, readSpecForm, specRubriques, type Answer } from "./specs";
import { enqueue, isActive, jobEvents, latestJob, workingCards, type JobKind } from "./jobs";
import { liveFor, sprintLiveFor } from "./live";
import { wordingFor } from "./wording";
import { can } from "./rights";
import { projectUrl } from "./urls";
import { projectView } from "./view-context";
import { messagePage, type Viewer } from "./views";

// /projects/{repo}/board, /cards, /cards/new, /cards/export, /cards/import, /cards/{id}, /cards/{id}/edit, /spec, /story
export const CARD_ROUTE = /^\/projects\/([^/]+\/[^/]+?)\/(board|sprint|sprint\/live|sprint\/run|sprint\/stories\/\d{1,9}|cards|cards\/new|cards\/export|cards\/import|cards\/(\d{1,9})(\/edit|\/spec|\/story|\/stories|\/live)?)$/;

// Writing cards goes with writing requests: Product Engineers and above.
export function canWriteCards(viewer: Viewer): boolean {
  return can(viewer.role, "request");
}

function notFound(viewer: Viewer, what = "There is no such project in La Fabrique extraordinaire."): Response {
  return html(messagePage("Not found", what, viewer), { status: 404 });
}

function forbidden(viewer: Viewer): Response {
  return html(messagePage("Not allowed", "Your role does not let you write cards.", viewer), { status: 403 });
}

const BOARD_NOTICES: Record<string, string> = {
  added: "Added.",
};

function importedNotice(params: URLSearchParams): string {
  const created = Number(params.get("created")) || 0;
  const skipped = Number(params.get("skipped")) || 0;
  return `${created} card${created === 1 ? "" : "s"} imported${skipped ? `; ${skipped} skipped, already on the board` : ""}.`;
}

export async function showBoard(request: Request, env: Env, viewer: Viewer, project: Project): Promise<Response> {
  const url = new URL(request.url);
  const board = readBoardQuery(url.searchParams);
  const [cards, { view, cookies }, spends, working] = await Promise.all([
    listCards(env.DB, project.repo),
    projectView(request, env, project, viewer),
    cardSpends(env.DB, project.repo),
    workingCards(env.DB, project.repo),
  ]);
  const [{ known, releases }, progress] = await Promise.all([knownValues(env, project, cards), cardProgress(env, project, cards)]);
  const notice = url.searchParams.get("notice");
  // A release that could not be planned: why, worked out again.
  const refused = url.searchParams.get("failure") === "release" ? cleanValue(url.searchParams.get("value")) : null;
  return html(
    boardPage(viewer, view, {
      cards: filterCards(cards, board.filters),
      total: cards.filter((card) => !card.archivedAt).length,
      known,
      board,
      canWrite: canWriteCards(viewer),
      spends,
      working,
      notice: notice === "imported" ? importedNotice(url.searchParams) : notice ? BOARD_NOTICES[notice] : undefined,
      failure: refused ? (planningProblem(project, refused, [...releases.values()]) ?? undefined) : undefined,
      releases,
      nextRelease: nextVersion(project.check?.config?.version?.forme, [...releases.values()]),
      progress,
    }),
    { cookies },
  );
}

function backTo(project: Project, form: FormData): string {
  const back = new URLSearchParams(String(form.get("back") ?? "")).toString();
  return `${projectUrl(project.repo)}/board${back ? `?${back}` : ""}`;
}

// The board's actions: a card moved (from /board.js), a new value.
export async function boardAction(form: FormData, env: Env, viewer: Viewer, project: Project): Promise<Response> {
  if (!canWriteCards(viewer)) return json({ error: "Your role does not let you move cards." }, { status: 403 });
  const action = String(form.get("action") ?? "");
  if (action === "add_value") {
    const dimension = form.get("dimension");
    const typed = cleanValue(form.get("value"));
    const back = backTo(project, form);
    const then = (query: string) => redirect(`${back}${back.includes("?") ? "&" : "?"}${query}`);
    if (isFreeDimension(dimension) && typed) {
      const cards = await listCards(env.DB, project.repo);
      const { known, releases } = await knownValues(env, project, cards);
      // A release planned is spelled as the project's releases are.
      const value = dimension === "release" ? plannedSpelling(project.check?.config?.version?.forme, [...releases.values()], typed) : typed;
      if (known[dimension].some((existing) => existing.toLowerCase() === value.toLowerCase())) return then("notice=added");
      // A release planned ahead follows the project's numbering.
      const problem = dimension === "release" ? planningProblem(project, value, [...releases.values()]) : null;
      if (problem) return then(`failure=release&value=${encodeURIComponent(value)}`);
      await addValue(env.DB, project.repo, dimension, value, viewer.login);
    }
    return then("notice=added");
  }
  if (action !== "move") return json({ error: "Unknown action." }, { status: 400 });

  const id = Number(form.get("card"));
  const card = Number.isInteger(id) && id > 0 ? await findCard(env.DB, project.repo, id) : null;
  if (!card) return json({ error: "This card is no longer here: reload the board." }, { status: 404 });
  // Validated with stories, the status follows them: not changed by moving
  // the card into or out of those stages (only to To validate or Dropped).
  const statusSet = form.get("set_status");
  if (typeof statusSet === "string" && statusSet !== shownStatus(card)) {
    const following = isProgressStage(shownStatus(card));
    if (isProgressStage(statusSet) || (following && statusSet === "validated")) {
      return json({ error: "This status follows the card's stories on GitHub: it cannot be set by moving the card." }, { status: 409 });
    }
  }
  const set: Partial<Record<Dimension, string | null>> = {};
  for (const dimension of DIMENSIONS) {
    const value = form.get(`set_${dimension}`);
    if (typeof value !== "string") continue;
    if (dimension === "kind" && !isKind(value)) continue;
    if (dimension === "status" && !isStatus(value)) continue;
    set[dimension] = value || null;
  }
  const neighbour = (name: string) => {
    const value = Number(form.get(name));
    return Number.isInteger(value) && value > 0 && value !== card.id ? value : null;
  };
  const cards = await listCards(env.DB, project.repo);
  const known = await dimensionValues(env.DB, project.repo, cards);
  const moved = await moveCard(env.DB, card, viewer.login, { set, before: neighbour("before"), after: neighbour("after") }, known);
  const [spends, working, progress] = await Promise.all([cardSpends(env.DB, project.repo), workingCards(env.DB, project.repo), cardProgress(env, project, [moved])]);
  return json({ ok: true, html: cardTile(moved, true, spends.get(moved.id), working.has(moved.id), progress.get(moved.id)) });
}

function emptyInput(params: URLSearchParams): CardInput {
  const kind = params.get("kind");
  const status = params.get("status");
  const free = (dimension: FreeDimension) => cleanValue(params.get(dimension));
  return {
    title: "",
    body: "",
    tags: {
      kind: isKind(kind) ? kind : "feature",
      status: isStatus(status) ? status : "draft",
      epic: free("epic"),
      domain: free("domain"),
      segment: free("segment"),
      release: free("release"),
    },
  };
}

export async function showCardForm(request: Request, env: Env, viewer: Viewer, project: Project, id: number | null): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const card = id ? await findCard(env.DB, project.repo, id) : null;
  if (id && !card) return notFound(viewer, "There is no such card in this project.");
  const [cards, { view, cookies }] = await Promise.all([listCards(env.DB, project.repo), projectView(request, env, project, viewer)]);
  const { known } = await knownValues(env, project, cards);
  const input = card ? { title: card.title, body: card.body, tags: card } : emptyInput(new URL(request.url).searchParams);
  return html(cardFormPage(viewer, view, { card, input, known }), { cookies });
}

export async function submitCard(request: Request, form: FormData, env: Env, viewer: Viewer, project: Project): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const cards = await listCards(env.DB, project.repo);
  const known = await dimensionValues(env.DB, project.repo, cards);
  const input = readCardForm(form, known);
  if (!input.title) {
    const { view, cookies } = await projectView(request, env, project, viewer);
    return html(cardFormPage(viewer, view, { card: null, input, known, error: "A card needs a title." }), { status: 422, cookies });
  }
  const id = await createCard(env.DB, project.repo, viewer.login, input);
  return redirect(`${projectUrl(project.repo)}/cards/${id}?created=1`);
}

const CARD_NOTICES: Record<string, string> = {
  saved: "Saved.",
  unchanged: "Nothing changed.",
  priority: "Priority set: on the card, and on GitHub for its stories (one level lower when nice to have).",
  archived: "Archived: it no longer shows on the board.",
  restored: "Back on the board.",
  version_restored: "That version is back, as the newest one.",
  spec: "Spec written. Read it, then revise it with Claude or by hand.",
  spec_saved: "Spec saved.",
  story: "Story created on GitHub.",
  enough: "Questions closed: Claude will not ask more unless you ask it to.",
  split_discarded: "Proposal discarded.",
  stories: "Stories created on GitHub, each linked to this card.",
  reviewed: "Stories reviewed: the comments are on GitHub, the new stories linked to this card.",
  status: "Status changed.",
};

// The card's page, also after a failed call to Claude (`failure`, with
// what the person had typed).
async function renderCard(
  request: Request,
  env: Env,
  viewer: Viewer,
  project: Project,
  card: Card,
  extra: { failure?: string; instruction?: string; ask?: "draft" | "change"; status?: number } = {},
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const [revisions, links, calls, claude, { view, cookies }, job] = await Promise.all([
    cardRevisions(env.DB, card.id),
    cardLinks(env.DB, card.id),
    cardCalls(env.DB, card.id),
    canWriteCards(viewer) ? allowance(env, viewer.role, viewer.login) : Promise.resolve({ ok: false as const, reason: "" }),
    projectView(request, env, project, viewer),
    latestJob(env.DB, card.id),
  ]);
  const events = job ? await jobEvents(env.DB, job.id) : [];
  // The card's stories as GitHub has them (the stories' snapshot).
  const storyStates: Map<number, StoryState> = await cardStories(
    env,
    project,
    links.filter((link) => link.kind === "story").map((link) => Number(link.ref)),
  );
  // Its progress from those stories, and when it reached each stage.
  const progress = (await cardProgress(env, project, [card])).get(card.id) ?? null;
  const progressHistory = await progressSince(env.DB, project.repo, card.id);
  const wanted = Number(params.get("rev"));
  const shown = wanted && wanted !== card.rev ? (revisions.find((revision) => revision.rev === wanted) ?? null) : null;
  const notice = params.get("notice");
  const asked = params.get("ask");
  const rubriques = specRubriques(project);
  const spend = calls.reduce(
    (total, call) => ({ calls: total.calls + 1, micros: total.micros + (call.cost_micros ?? 0), unknown: total.unknown + (call.cost_micros === null ? 1 : 0) }),
    { calls: 0, micros: 0, unknown: 0 },
  );
  return html(
    cardPage(viewer, view, {
      card,
      revisions,
      links,
      shown,
      canWrite: canWriteCards(viewer),
      created: params.get("created") === "1",
      notice: notice ? CARD_NOTICES[notice] : undefined,
      failure: extra.failure,
      instruction: extra.instruction,
      ask: extra.ask ?? (asked === "draft" || asked === "change" ? asked : null),
      rubriques,
      claude: { usable: claude.ok, reason: claude.ok ? null : claude.reason },
      calls,
      spend,
      missing: missingSections(card.data.spec, rubriques),
      job,
      events,
      split: card.data.split,
      storyStates,
      priorities: cycleRules(project.check?.config).priorities,
      progress,
      progressHistory,
    }),
    { cookies, status: extra.status ?? 200 },
  );
}

export async function showCardPage(request: Request, env: Env, viewer: Viewer, project: Project, id: number): Promise<Response> {
  const card = await findCard(env.DB, project.repo, id);
  if (!card) return notFound(viewer, "There is no such card in this project.");
  return renderCard(request, env, viewer, project, card);
}

export async function changeCard(request: Request, form: FormData, env: Env, viewer: Viewer, project: Project, id: number): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const card = await findCard(env.DB, project.repo, id);
  if (!card) return notFound(viewer, "There is no such card in this project.");
  const url = `${projectUrl(project.repo)}/cards/${card.id}`;
  const action = String(form.get("action") ?? "");
  if (action === "archive" || action === "restore") {
    if (Boolean(card.archivedAt) !== (action === "restore")) return redirect(url);
    await archiveCard(env.DB, card, viewer.login, action === "archive");
    return redirect(`${url}?notice=${action === "archive" ? "archived" : "restored"}`);
  }
  if (action === "restore_version") {
    const wanted = Number(form.get("rev"));
    const revision = (await cardRevisions(env.DB, card.id)).find((candidate) => candidate.rev === wanted);
    if (!revision || revision.rev === card.rev) return redirect(url);
    await restoreRevision(env.DB, card, revision, viewer.login);
    await reopenStatus(env.DB, project.repo, card.id, viewer.login, "an older version came back");
    return redirect(`${url}?notice=version_restored`);
  }
  if (action === "spec_draft" || action === "spec_revise" || action === "spec_answer") {
    const instruction = String(form.get("instruction") ?? "").trim().slice(0, 4000);
    // Answers to Claude's questions, each with the question it answers.
    const answers: Answer[] = [];
    for (let index = 0; index < 10; index++) {
      const question = String(form.get(`question_${index}`) ?? "").trim().slice(0, 1000);
      const answer = String(form.get(`answer_${index}`) ?? "").trim().slice(0, 2000);
      if (question && answer) answers.push({ question, answer });
    }
    const ask: "draft" | "change" | null = action === "spec_draft" ? "draft" : action === "spec_revise" ? "change" : null;
    const keep: { instruction: string; ask?: "draft" | "change" } = ask ? { instruction, ask } : { instruction };
    const kind: JobKind = action;
    if (action === "spec_answer" && !answers.length && !instruction) {
      return renderCard(request, env, viewer, project, card, { failure: "Answer at least one of Claude's questions.", status: 422 });
    }
    if (action === "spec_revise" && !instruction) {
      return renderCard(request, env, viewer, project, card, { failure: "Say what should change.", ...keep, status: 422 });
    }
    const allowed = await allowance(env, viewer.role, viewer.login);
    if (!allowed.ok) return renderCard(request, env, viewer, project, card, { failure: allowed.reason, ...keep, status: 429 });
    // Saved at once, run in the background: leaving the page loses nothing.
    const queued = await enqueue(env, { repo: project.repo, cardId: card.id, kind, request: { instruction, answers }, login: viewer.login });
    if (!queued.ok) return renderCard(request, env, viewer, project, card, { failure: queued.message, ...keep, status: 409 });
    await advanceStatus(env.DB, project.repo, card.id, viewer.login, "shaping", "Claude asked");
    return redirect(`${url}#claude-job`);
  }
  if (action === "job_retry") {
    const last = await latestJob(env.DB, card.id);
    if (!last || last.status !== "failed") return redirect(`${url}#spec`);
    const allowed = await allowance(env, viewer.role, viewer.login);
    if (!allowed.ok) return renderCard(request, env, viewer, project, card, { failure: allowed.reason, status: 429 });
    const queued = await enqueue(env, { repo: project.repo, cardId: card.id, kind: last.kind, request: last.request, login: viewer.login });
    if (!queued.ok) return renderCard(request, env, viewer, project, card, { failure: queued.message, status: 409 });
    await advanceStatus(env.DB, project.repo, card.id, viewer.login, "shaping", "Claude asked");
    return redirect(`${url}#claude-job`);
  }
  if (action === "spec_split") {
    if (!card.data.spec) return redirect(`${url}#spec`);
    const instruction = String(form.get("instruction") ?? "").trim().slice(0, 4000);
    const allowed = await allowance(env, viewer.role, viewer.login);
    if (!allowed.ok) return renderCard(request, env, viewer, project, card, { failure: allowed.reason, status: 429 });
    const queued = await enqueue(env, { repo: project.repo, cardId: card.id, kind: "spec_split", request: { instruction, answers: [] }, login: viewer.login });
    if (!queued.ok) return renderCard(request, env, viewer, project, card, { failure: queued.message, status: 409 });
    return redirect(`${url}#claude-job`);
  }
  if (action === "spec_enough") {
    if (!card.data.spec || isActive(await latestJob(env.DB, card.id))) return redirect(`${url}#spec`);
    await saveSpec(env.DB, card, viewer.login, closeQuestions(card.data.spec));
    await advanceStatus(env.DB, project.repo, card.id, viewer.login, "to_validate", "questions closed");
    return redirect(`${url}?notice=enough#spec`);
  }
  if (action === "priority") {
    const priority = String(form.get("priority") ?? "") || null;
    if ((priority && !cycleRules(project.check?.config).priorities.includes(priority)) || card.archivedAt) return redirect(url);
    if (!(await setCardPriority(env.DB, card, priority, viewer.login))) return redirect(`${url}?notice=unchanged`);
    const failed = priority ? await applyCardPriority(env, project, { ...card, priority }, viewer.login) : [];
    if (failed.length) return renderCard(request, env, viewer, project, { ...card, priority }, { failure: `Priority set on the card; GitHub refused it for ${failed.join("; ")}`, status: 502 });
    return redirect(`${url}?notice=priority`);
  }
  if (action === "status") {
    const to = form.get("status");
    if (!isStatus(to) || card.archivedAt) return redirect(url);
    const changed = await setStatus(env.DB, card, viewer.login, to);
    return redirect(`${url}?notice=${changed ? "status" : "unchanged"}`);
  }
  if (action === "spec_save") {
    if (Number(form.get("rev")) !== card.rev) {
      return renderCard(request, env, viewer, project, card, { failure: "The card changed while you were editing its spec: your text was not saved. Open the spec again.", status: 409 });
    }
    const spec = readSpecForm(form, specRubriques(project), card.data.spec);
    await saveSpec(env.DB, card, viewer.login, spec);
    if (JSON.stringify(spec.answers) !== JSON.stringify(card.data.spec?.answers ?? {})) {
      await reopenStatus(env.DB, project.repo, card.id, viewer.login, "the spec changed");
    }
    return redirect(`${url}?notice=spec_saved#spec`);
  }
  const cards = await listCards(env.DB, project.repo);
  const known = await dimensionValues(env.DB, project.repo, cards);
  const input = readCardForm(form, known);
  if (!input.title) {
    const { view, cookies } = await projectView(request, env, project, viewer);
    return html(cardFormPage(viewer, view, { card, input, known, error: "A card needs a title." }), { status: 422, cookies });
  }
  const outcome = await updateCard(env.DB, card, viewer.login, input, Number(form.get("rev")));
  if (outcome === "conflict") {
    const current = (await findCard(env.DB, project.repo, id)) ?? card;
    const { view, cookies } = await projectView(request, env, project, viewer);
    return html(cardFormPage(viewer, view, { card, input, known, conflict: current }), { status: 409, cookies });
  }
  // The feature changed, its status left as it was: to validate again.
  if (outcome === "saved" && (input.title !== card.title || input.body !== card.body) && input.tags.status === card.status) {
    await reopenStatus(env.DB, project.repo, card.id, viewer.login, "the card changed");
  }
  return redirect(`${url}?notice=${outcome}`);
}

export async function showSpecForm(request: Request, env: Env, viewer: Viewer, project: Project, id: number): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const card = await findCard(env.DB, project.repo, id);
  if (!card) return notFound(viewer, "There is no such card in this project.");
  const { view, cookies } = await projectView(request, env, project, viewer);
  return html(specFormPage(viewer, view, { card, rubriques: specRubriques(project), spec: card.data.spec }), { cookies });
}

function storyDraft(request: Request, project: Project, card: Card, login: string, title: string): { draft: RequestDraft; origin: string; body: string } {
  const rubriques = specRubriques(project);
  const draft = { title, answers: card.data.spec?.answers ?? {} };
  const origin = wordingFor(project).fromCard(cardRef(card.id), new URL(cardPermalink(card.id, card.rev), request.url).toString(), card.rev);
  return { draft, origin, body: issueBody(draft, rubriques, login, wordingFor(project), origin) };
}

export async function storyRoute(request: Request, env: Env, viewer: Viewer, project: Project, id: number, form: FormData | null): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const card = await findCard(env.DB, project.repo, id);
  if (!card) return notFound(viewer, "There is no such card in this project.");
  const url = cardUrl(project.repo, card.id);
  const rubriques = specRubriques(project);
  if (!card.data.spec || missingSections(card.data.spec, rubriques).length) return redirect(`${url}#spec`);
  const title = form ? String(form.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || card.title : card.title;
  const { draft, origin, body } = storyDraft(request, project, card, viewer.login, title);
  const label = project.check?.config?.demandes?.etiquettes?.["demande"] ?? null;
  const page = async (error?: string, status = 200) => {
    const { view, cookies } = await projectView(request, env, project, viewer);
    return html(storyPage(viewer, view, { card, title, body, label, error }), { cookies, status });
  };
  if (!form) return page();
  const outcome = await createRequest(request, env, project, viewer.login, draft, rubriques, origin);
  if (!outcome.ok) {
    return page(
      outcome.reason === "signed_out"
        ? "GitHub no longer accepts your sign-in. Sign out and sign in again."
        : `GitHub refused to create the issue (HTTP ${outcome.status ?? "?"}). Your GitHub account may not have access to this repository.`,
      502,
    );
  }
  await linkStory(env.DB, card, viewer.login, outcome.number, outcome.url);
  // The story takes its card's priority.
  if (card.priority && cycleRules(project.check?.config).priorities.includes(card.priority)) await setPriority(env, project, viewer.login, outcome.number, card.priority);
  await advanceStatus(env.DB, project.repo, card.id, viewer.login, "validated", "story made");
  return redirect(`${url}?notice=story`);
}

// Cards brought in from a JSON file (the export's format), or pasted.
export async function importRoute(request: Request, env: Env, viewer: Viewer, project: Project, form: FormData | null): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const page = async (data: { error?: string; text?: string; status?: number } = {}) => {
    const { view, cookies } = await projectView(request, env, project, viewer);
    return html(importPage(viewer, view, data), { cookies, status: data.status ?? 200 });
  };
  if (!form) return page();
  const file: unknown = form.get("file");
  const uploaded = file instanceof File && file.size ? file : null;
  if (uploaded && uploaded.size > 2_000_000) return page({ error: "This file is over 2 MB.", status: 413 });
  const text = uploaded ? await uploaded.text() : String(form.get("text") ?? "").trim();
  if (!text) return page({ error: "Choose a file, or paste the JSON.", status: 422 });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return page({ error: "This is not JSON.", text: uploaded ? "" : text, status: 422 });
  }
  const outcome = await importCards(env.DB, project.repo, viewer.login, data);
  if (!outcome.created.length && !outcome.skipped.length) {
    return page({ error: "No card found: the JSON has no list of cards with a title.", text: uploaded ? "" : text, status: 422 });
  }
  return redirect(`${projectUrl(project.repo)}/board?notice=imported&created=${outcome.created.length}&skipped=${outcome.skipped.length}`);
}

const SPRINT_NOTICES: Record<string, string> = {
  started: "Sprint started: it took the cards of Next release.",
  closed: "Sprint closed: the cards done took the version that shipped them, the others stay in the sprint for the next one.",
  priority: "Priority set on GitHub.",
  ready: "Marked ready for Claude on GitHub.",
  review: "Review asked on GitHub.",
  "go-given": "Go given: the project's workflow is promoting integration to production. Once it is out, the validated stories are closed, the sprint closes and each finished card takes the version.",
};


// The sprint (la-fabrique#109): it takes the cards of Next release, has no
// version while it runs, and closes once its needed stories are out.
export async function sprintRoute(request: Request, env: Env, viewer: Viewer, project: Project, form: FormData | null): Promise<Response> {
  const base = `${projectUrl(project.repo)}/sprint`;
  if (form) {
    if (!canWriteCards(viewer)) return forbidden(viewer);
    const action = String(form.get("action") ?? "");
    const running = await activeSprint(env.DB, project.repo);
    // Claude Code on a story of the sprint (la-fabrique#113), through the
    // project's own workflow; refused, the page says why.
    if (action === "launch") {
      if (!canLaunchClaude(viewer.role)) return forbidden(viewer);
      const number = Number(form.get("story"));
      const links = await storyCards(env.DB, project.repo);
      const inSprint = running ? (await listCards(env.DB, project.repo)).filter((card) => card.release === running.release && !card.archivedAt) : [];
      if (!Number.isInteger(number) || !inSprint.some((card) => (links.order.get(card.id) ?? []).includes(number))) return redirect(base);
      const outcome = await launchClaude(env, project, viewer.login, number);
      if (outcome.ok) return redirect(`${base}?notice=launched&story=${number}`);
      return showSprint(request, env, viewer, project, outcome.message, outcome.status);
    }
    // An open pull request of a sprint story, brought up to date by Claude.
    if (action === "update") {
      if (!canLaunchClaude(viewer.role)) return forbidden(viewer);
      const number = Number(form.get("story"));
      const pull = Number(form.get("pull"));
      const links = await storyCards(env.DB, project.repo);
      const inSprint = running ? (await listCards(env.DB, project.repo)).filter((card) => card.release === running.release && !card.archivedAt) : [];
      if (!Number.isInteger(number) || !inSprint.some((card) => (links.order.get(card.id) ?? []).includes(number))) return redirect(base);
      const stories = await cardStories(env, project, [number]);
      if (!stories.get(number)?.pulls.some((candidate) => candidate.number === pull && candidate.state === "open")) return redirect(base);
      const outcome = await updateWithClaude(env, project, viewer.login, number, pull);
      if (outcome.ok) return redirect(`${base}?notice=updating&story=${number}&pull=${pull}`);
      return showSprint(request, env, viewer, project, outcome.message, outcome.status);
    }
    // Merged by the project's workflow, release notes numbered there.
    if (action === "merge") {
      const pull = Number(form.get("pull"));
      if (!Number.isInteger(pull) || pull <= 0) return redirect(base);
      const detail = (await pullDetails(env, project, [pull])).get(pull);
      if (!detail || detail.state !== "open") return redirect(base);
      if (!canMerge(viewer.role, project, detail.base)) return forbidden(viewer);
      const outcome = await mergePull(env, project, viewer.login, pull);
      if (outcome.ok) return redirect(`${base}?notice=merging&pull=${pull}`);
      return showSprint(request, env, viewer, project, outcome.message, outcome.status);
    }
    // The sprint running by itself (la-fabrique#160): a Product Engineer or
    // the super admin, as it merges.
    if (action.startsWith("run_")) {
      if (!can(viewer.role, "promote")) return forbidden(viewer);
      const run = sprintRunFor(env, project.repo);
      if (!run || !running) return redirect(base);
      if (action === "run_start") {
        const refusal = runRefusal(project);
        if (refusal) return showSprint(request, env, viewer, project, refusal, 422);
        const { plan } = await loadRunPlan(env, project);
        const state = newRun(project.repo, viewer.login, plan, new Date().toISOString());
        if (!state.cards.length) return showSprint(request, env, viewer, project, "Nothing to run: every story of the sprint is merged.", 422);
        await run.start(state);
        return redirect(`${base}?notice=run_started`);
      }
      const what = action === "run_pause" ? "pause" : action === "run_resume" ? "resume" : action === "run_stop" ? "stop" : action === "run_resume_card" ? "resume_card" : null;
      if (!what) return redirect(base);
      await run.control(viewer.login, what, Number(form.get("card")) || undefined);
      return redirect(`${base}#sprint-work`);
    }
    if (action === "start") {
      const choice = String(form.get("version") ?? "");
      const version = choice === "other" ? String(form.get("version_other") ?? "").trim() : choice;
      const outcome = await startSprint(env, project, viewer.login, { version: version || null, name: String(form.get("name") ?? "") || null });
      if (outcome.ok) return redirect(`${base}?notice=started`);
      if (outcome.reason !== "version") return redirect(`${base}?failure=${outcome.reason}`);
      return showSprint(request, env, viewer, project, outcome.message, 422);
    }
    // The sprint's version and name, changed while it runs (la-fabrique#174).
    if (action === "sprint_version") {
      if (!running) return redirect(base);
      const version = String(form.get("version") ?? "").trim();
      const { releases } = await sprintVersions(env, project);
      const problem = sprintVersionProblem(project, version, releases);
      if (problem) return showSprint(request, env, viewer, project, problem, 422);
      await setSprintVersion(env.DB, running, version, String(form.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null, viewer.login);
      return redirect(`${base}?notice=versioned`);
    }
    if (action === "close" || action === "release") {
      if (!running || running.release !== SPRINT_LANE) return redirect(base);
      // With an integration branch, the release is made by the promotion.
      if (hasIntegration(project)) {
        if (action === "close") await closeSprint(env, project, running, viewer.login);
        return redirect(`${base}?notice=closed`);
      }
      // The release is the project's act, and the go: Product Engineer or super admin.
      if (!can(viewer.role, "promote")) return forbidden(viewer);
      if (!publishWorkflow(project)) {
        return showSprint(request, env, viewer, project, "This project declares no release workflow (workflows.publier): declare it in .fabrique.json — Setup says how.", 422);
      }
      const [links, notes, boardReleaseList] = await Promise.all([storyCards(env.DB, project.repo), loadReleases(env, project), knownValues(env, project, await listCards(env.DB, project.repo))]);
      const plan = await loadPlan(env, project, links, notes.releases, [...boardReleaseList.releases.values()]);
      const kind: ReleaseKind = form.get("kind") === "major" ? "major" : "minor";
      const title = String(form.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      const preview = async (error?: string, status = 200) => {
        const { view, cookies } = await projectView(request, env, project, viewer);
        return html(releasePage(viewer, view, plan, { kind, title: action === "close" || !title ? plan.title : title, version: running.version, ...(error ? { error } : {}) }), { cookies, status });
      };
      if (action === "close" && form.get("confirm") !== "1" && (plan.notDone.length || plan.entries.some((entry) => entry.partial))) {
        const { view, cookies } = await projectView(request, env, project, viewer);
        return html(releaseWarningPage(viewer, view, plan), { cookies });
      }
      if (action === "close") return preview();
      // The sprint's own version when it has one (la-fabrique#174).
      const version = running.version ?? proposeVersion(plan.newest, kind);
      if (!version) return preview("The newest release has no number to continue from.", 422);
      if (running.version) {
        const problem = sprintVersionProblem(project, running.version, (await sprintVersions(env, project)).releases);
        if (problem) return preview(`${problem} Change the sprint's version, then close it.`, 422);
      }
      if (!title) return preview("The release needs a title.", 422);
      const outcome = await startRelease(env, project, viewer.login, plan, version, title);
      if (!outcome.ok) return preview(outcome.message, outcome.status);
      return redirect(`${base}?notice=releasing&version=${encodeURIComponent(version)}`);
    }
    // The order in the sprint, and nice to have (la-fabrique#111).
    const card = Number(form.get("card"));
    const story = Number(form.get("story"));
    // A whole order from a drag and drop (la-fabrique#181): answered in JSON
    // to the page's script, else back to the sprint.
    if (action === "card_order" || action === "story_order") {
      const wanted = String(form.get("order") ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 200);
      let changed = false;
      if (action === "card_order" && running) changed = await orderCardsInRelease(env.DB, project.repo, running.release, wanted, viewer.login);
      if (action === "story_order" && Number.isInteger(card) && (await findCard(env.DB, project.repo, card))) changed = await orderStoriesInCard(env.DB, project.repo, card, wanted, viewer.login);
      if ((request.headers.get("accept") ?? "").includes("application/json")) return json({ ok: true, changed });
      return redirect(base);
    }
    if (action === "card_up" || action === "card_down") {
      const found = Number.isInteger(card) ? await findCard(env.DB, project.repo, card) : null;
      if (found?.release) await moveCardInRelease(env.DB, project.repo, found.release, card, action === "card_up" ? "up" : "down", viewer.login);
      return redirect(`${base}#card-${card}`);
    }
    if (action === "story_up" || action === "story_down" || action === "nice") {
      const found = Number.isInteger(card) ? await findCard(env.DB, project.repo, card) : null;
      if (found && Number.isInteger(story) && story > 0) {
        if (action === "nice") {
          const nice = form.get("nice") === "1";
          // Nice to have: one priority level below its card's.
          if ((await setNice(env.DB, project.repo, card, story, nice, viewer.login)) && found.priority) {
            const to = storyPriority(await projectRules(env.DB, project), found.priority, nice);
            const outcome = to ? await setPriority(env, project, viewer.login, story, to) : null;
            if (outcome && !outcome.ok) return showSprint(request, env, viewer, project, outcome.message, outcome.status);
          }
        } else await moveStoryInCard(env.DB, project.repo, card, story, action === "story_up" ? "up" : "down", viewer.login);
      }
      return redirect(`${base}#story-${card}-${story}`);
    }
    // Priorities: a card's (given to its stories), or one story's; and a
    // story declared ready for Claude.
    const priority = String(form.get("priority") ?? "") || null;
    if (action === "card_priority") {
      const found = Number.isInteger(card) ? await findCard(env.DB, project.repo, card) : null;
      if (!found || (priority && !cycleRules(project.check?.config).priorities.includes(priority))) return redirect(base);
      await setCardPriority(env.DB, found, priority, viewer.login);
      const failed = priority ? await applyCardPriority(env, project, { ...found, priority }, viewer.login) : [];
      if (failed.length) return showSprint(request, env, viewer, project, `Priority set on the card; GitHub refused it for ${failed.join("; ")}`, 502);
      return redirect(`${base}?notice=priority#card-${card}`);
    }
    if (action === "story_priority") {
      if (!Number.isInteger(story) || story <= 0) return redirect(base);
      // Nice to have is one of a story's priorities (la-fabrique#180): one
      // level below its card's on GitHub; another priority makes it needed.
      const found = Number.isInteger(card) ? await findCard(env.DB, project.repo, card) : null;
      if (priority === "nice") {
        if (!found) return redirect(base);
        await setNice(env.DB, project.repo, card, story, true, viewer.login);
        const to = found.priority ? storyPriority(await projectRules(env.DB, project), found.priority, true) : null;
        const outcome = to ? await setPriority(env, project, viewer.login, story, to) : null;
        if (outcome && !outcome.ok) return showSprint(request, env, viewer, project, outcome.message, outcome.status);
        return redirect(`${base}?notice=priority#story-${card}-${story}`);
      }
      if (found && isNice(await storyCards(env.DB, project.repo), card, story)) await setNice(env.DB, project.repo, card, story, false, viewer.login);
      const outcome = await setPriority(env, project, viewer.login, story, priority);
      if (!outcome.ok) return showSprint(request, env, viewer, project, outcome.message, outcome.status);
      return redirect(`${base}?notice=priority#story-${card}-${story}`);
    }
    if (action === "review") {
      const pull = Number(form.get("pull"));
      const reviewer = String(form.get("reviewer") ?? "");
      if (!Number.isInteger(pull) || pull <= 0 || !(await reviewers(env)).includes(reviewer)) return redirect(base);
      const outcome = await requestReview(request, env, project, viewer.login, pull, reviewer);
      if (!outcome.ok) return showSprint(request, env, viewer, project, outcome.message, outcome.status);
      return redirect(`${base}?notice=review`);
    }
    if (action === "story_ready") {
      if (!Number.isInteger(story) || story <= 0) return redirect(base);
      const outcome = await markReady(env, project, story, viewer.login);
      if (!outcome.ok) return showSprint(request, env, viewer, project, outcome.message, 502);
      return redirect(`${base}?notice=ready`);
    }
    return redirect(base);
  }
  return showSprint(request, env, viewer, project);
}

async function showSprint(request: Request, env: Env, viewer: Viewer, project: Project, refused?: string, status = 200): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const cards = await listCards(env.DB, project.repo);
  const { releases } = await knownValues(env, project, cards);
  const [sprint, latest, links, { view, cookies }, launches, runs] = await Promise.all([
    activeSprint(env.DB, project.repo),
    latestSprint(env.DB, project.repo),
    storyCards(env.DB, project.repo),
    projectView(request, env, project, viewer),
    claudeLaunches(env.DB, project.repo),
    claudeRuns(env, project),
  ]);
  const live = cards.filter((card) => !card.archivedAt).sort((a, b) => a.position - b.position || a.id - b.id);
  const inLane = (release: string) => live.filter((card) => card.release === release);
  const integration = [...releases.values()].find((release) => release.state === "in_progress" && !isFixedLane(release.version) && !release.sprint) ?? null;
  const sprintCards = sprint ? inLane(sprint.release) : [];
  const nextCards = inLane(NEXT_RELEASE);
  const keptCards = sprint ? [] : inLane(SPRINT_LANE);
  const integrationCards = integration ? inLane(integration.version) : [];
  const numbers = [...new Set([...sprintCards, ...keptCards, ...nextCards, ...integrationCards].flatMap((card) => links.order.get(card.id) ?? []))];
  const failure = params.get("failure");
  const stories = await cardStories(env, project, numbers);
  // The open pull requests of the sprint's stories, as GitHub has them.
  const inSprint = sprintCards.flatMap((card) => links.order.get(card.id) ?? []);
  const openPulls = inSprint.flatMap((number) => (stories.get(number)?.pulls ?? []).filter((pull) => pull.state === "open").map((pull) => pull.number));
  const [pulls, people, progress, merges] = await Promise.all([
    pullDetails(env, project, openPulls),
    reviewers(env),
    cardProgress(env, project, [...sprintCards, ...keptCards, ...nextCards, ...integrationCards], links),
    lastMergeAttempts(env.DB, project.repo),
  ]);
  // One story at a time per card: the stories waiting for another of their
  // card, in progress (la-fabrique#159).
  const held = heldStories(links, stories, new Set(runs.filter(isRunning).map((run) => run.issue).filter((issue): issue is number => issue !== null)), sprintCards.map((card) => card.id));
  // The next for Claude: in the sprint's order, the first ready story not
  // launched yet, nor waiting for another of its card.
  const next =
    sprintCards.flatMap((card) => links.order.get(card.id) ?? []).find((number) => isReadyStage(stories.get(number)) && !launches.has(number) && !held.has(number)) ?? null;
  const launched = Number(params.get("story"));
  const runState = sprint ? ((await sprintRunFor(env, project.repo)?.state().catch(() => null)) ?? null) : null;
  return html(
    sprintPage(viewer, view, {
      run: sprint ? runSection(viewer, project, runState, can(viewer.role, "promote"), runRefusal(project)) : "",
      sprint,
      legacy: Boolean(sprint && sprint.release !== SPRINT_LANE),
      last: !sprint && latest?.endedAt ? latest : null,
      sprintCards,
      nextCards,
      keptCards,
      integration,
      integrationCards,
      stories,
      links,
      canOrder: canWriteCards(viewer),
      canClose: hasIntegration(project) ? canWriteCards(viewer) : can(viewer.role, "promote"),
      releaseWorkflow: publishWorkflow(project),
      go: hasIntegration(project) ? await sprintGo(env, project, viewer) : null,
      release: await lastReleaseAttempt(env.DB, project.repo),
      noIntegration: !hasIntegration(project),
      pulls,
      reviewers: people,
      progress,
      merges,
      merge: { workflow: mergeWorkflow(project), can: (base: string | null) => canMerge(viewer.role, project, base) },
      priorities: cycleRules(project.check?.config).priorities,
      readyLabel: cycleRules(project.check?.config).checks.includes("etiquette_prete") ? cycleRules(project.check?.config).readyLabel : null,
      claude: {
        canLaunch: canLaunchClaude(viewer.role),
        workflow: claudeWorkflow(project),
        cap: claudeCap(project),
        launches,
        next,
        held,
        runs,
        runsUrl: claudeWorkflow(project) ? `https://github.com/${project.repo}/actions/workflows/${encodeURIComponent(claudeWorkflow(project) ?? "")}` : null,
      },
      ...(sprint ? {} : { versions: await sprintVersions(env, project) }),
      notice:
        params.get("notice") === "versioned"
          ? "The sprint's version is saved: it is the release the sprint makes when it closes."
          : params.get("notice") === "run_started"
          ? "The sprint is running by itself: each card's stories one after another, up to testing. Pause or stop it at any time."
          : params.get("notice") === "launched" && Number.isInteger(launched)
          ? `Claude Code launched on #${launched}: the project's workflow is starting on GitHub.`
          : params.get("notice") === "releasing"
          ? `The release ${params.get("version") ?? ""} has started: the project's workflow opens a pull request on the production branch and merges it. The sprint closes when it is out.`
          : params.get("notice") === "merging" && Number.isInteger(Number(params.get("pull")))
            ? `Pull request #${Number(params.get("pull"))} is being merged by the project's workflow: it numbers and dates the release notes, checks again, then merges.`
            : params.get("notice") === "updating" && Number.isInteger(Number(params.get("pull")))
            ? `Claude is bringing pull request #${Number(params.get("pull"))} up to date: it merges the base branch, resolves the conflicts and pushes to the same branch.`
            : SPRINT_NOTICES[params.get("notice") ?? ""],
      failure:
        refused ??
        (failure === "running" ? "A sprint is in progress: close or stop it first." : failure === "empty" ? "Next release has no card: place the cards of the next sprint in it first." : undefined),
    }),
    { cookies, status },
  );
}

export async function downloadCards(env: Env, project: Project): Promise<Response> {
  const name = project.repo.replace("/", "-");
  return json(await exportCards(env.DB, project.repo), {
    headers: {
      "content-disposition": `attachment; filename="${name}-cards.json"`,
      "cache-control": "no-store",
    },
  });
}

// The stories Claude proposes, edited in the form: kept or not, title,
// sections.
function readSplitForm(form: FormData, split: CardSplit, rubriques: Rubrique[]): { split: CardSplit; kept: number[]; commented: number[] } {
  const kept: number[] = [];
  const stories = split.stories.map((story, index) => {
    if (form.get(`keep_${index}`) === "1") kept.push(index);
    const title = String(form.get(`title_${index}`) ?? story.title).replace(/\s+/g, " ").trim().slice(0, 200);
    const answers = Object.fromEntries(
      rubriques.map((rubrique) => [rubrique.cle, String(form.get(`s_${index}_${rubrique.cle}`) ?? story.answers[rubrique.cle] ?? "").replace(/\r\n/g, "\n").trim().slice(0, 20_000)]),
    );
    return { title, answers, nice: form.get(`nice_${index}`) === "1" };
  });
  // A review: the comments for the stories to change, as edited.
  const commented: number[] = [];
  const review = split.review?.map((story) => {
    if (story.verdict !== "change") return story;
    if (form.get(`comment_${story.number}`) === "1") commented.push(story.number);
    return { ...story, comment: String(form.get(`comment_text_${story.number}`) ?? story.comment).replace(/\r\n/g, "\n").trim().slice(0, 4000) };
  });
  return { split: { ...split, stories, ...(review ? { review } : {}) }, kept, commented };
}

// Review what Claude proposes, edit it, then create the stories on GitHub
// (and, after a review, comment on the stories to change); nothing goes
// there before.
export async function splitRoute(request: Request, env: Env, viewer: Viewer, project: Project, id: number, form: FormData | null): Promise<Response> {
  if (!canWriteCards(viewer)) return forbidden(viewer);
  const card = await findCard(env.DB, project.repo, id);
  if (!card) return notFound(viewer, "There is no such card in this project.");
  const url = cardUrl(project.repo, card.id);
  const split = card.data.split;
  if (!split) return redirect(`${url}#spec`);
  const rubriques = specRubriques(project);
  const words = wordingFor(project);
  const label = project.check?.config?.demandes?.etiquettes?.["demande"] ?? null;
  // After a review, new stories are numbered after those already made.
  const made = split.review?.length ?? 0;
  const permalink = (rev: number) => new URL(cardPermalink(card.id, rev), request.url).toString();
  const originOf = (position: number, kept: number, rev: number) =>
    words.fromCard(cardRef(card.id), permalink(rev), rev, made + kept > 1 ? { index: made + position, total: made + kept } : undefined);
  const commentOf = (comment: string, rev: number) => `${comment}\n\n${words.storyReview(cardRef(card.id), permalink(rev), rev, viewer.login)}`;
  const page = async (shown: CardSplit, data: { kept?: number[]; commented?: number[]; errors?: Record<number, string>; error?: string; status?: number } = {}) => {
    const { view, cookies } = await projectView(request, env, project, viewer);
    const kept = data.kept ?? shown.stories.map((_story, index) => index);
    const commented = data.commented ?? (shown.review ?? []).filter((story) => story.verdict === "change").map((story) => story.number);
    return html(
      splitPage(viewer, view, {
        card,
        split: shown,
        rubriques,
        label,
        kept: new Set(kept),
        bodies: shown.stories.map((story, index) =>
          issueBody({ title: story.title, answers: story.answers }, rubriques, viewer.login, words, originOf(kept.indexOf(index) + 1, kept.length, card.rev)),
        ),
        commented: new Set(commented),
        comments: new Map((shown.review ?? []).map((story) => [story.number, commentOf(story.comment, card.rev)])),
        outdated: card.data.spec?.at !== shown.specAt,
        errors: data.errors ?? {},
        error: data.error,
      }),
      { cookies, status: data.status ?? 200 },
    );
  };
  if (!form) {
    const params = new URL(request.url).searchParams;
    const created = Number(params.get("created")) || 0;
    if (params.get("notice") === "partial") {
      return page(split, { error: `${created} done on GitHub, then: ${(params.get("reason") ?? "GitHub refused").slice(0, 200)} The rest is still here.` });
    }
    return page(split);
  }

  const action = String(form.get("action") ?? "");
  if (action === "discard") {
    await saveSplit(env.DB, card, viewer.login, null);
    return redirect(`${url}?notice=split_discarded#spec`);
  }
  const edited = readSplitForm(form, split, rubriques);
  const rules = await projectRules(env.DB, project);
  if (action === "save") {
    await saveSplit(env.DB, card, viewer.login, edited.split);
    return redirect(`${url}/stories?notice=saved`);
  }
  if (action !== "create") return redirect(`${url}/stories`);

  // Every kept story needs a title and the project's required sections;
  // every comment sent, a text.
  const errors: Record<number, string> = {};
  for (const index of edited.kept) {
    const story = edited.split.stories[index];
    if (!story) continue;
    const missing = [...(story.title ? [] : ["Title"]), ...missingSections({ answers: story.answers, questions: [], source: "person", at: "" }, rubriques)];
    if (missing.length) errors[index] = `Fill in: ${missing.join(", ")}.`;
  }
  const review = edited.split.review;
  const show = { kept: edited.kept, commented: edited.commented };
  if (!review && !edited.kept.length) return page(edited.split, { ...show, error: "Keep at least one story, or discard the proposal.", status: 422 });
  if (Object.keys(errors).length) return page(edited.split, { ...show, errors, status: 422 });
  const silent = (review ?? []).filter((story) => edited.commented.includes(story.number) && !story.comment).map((story) => `#${story.number}`);
  if (silent.length) return page(edited.split, { ...show, error: `Write the comment for ${silent.join(", ")}, or uncheck it.`, status: 422 });

  // The edits are kept first: a failure halfway loses nothing.
  await saveSplit(env.DB, card, viewer.login, edited.split);
  const saved = (await findCard(env.DB, project.repo, card.id)) ?? card;
  const commented: number[] = [];
  const created: number[] = [];
  const stop = async (outcome: { reason: "signed_out" | "refused"; status?: number }, what: string) => {
    // What was not done stays proposed.
    const left: CardSplit = {
      ...edited.split,
      stories: edited.split.stories.filter((_story, at) => !created.includes(at)),
      ...(review ? { review: review.filter((story) => !commented.includes(story.number)) } : {}),
    };
    const current = (await findCard(env.DB, project.repo, card.id)) ?? saved;
    await saveSplit(env.DB, current, viewer.login, left);
    const reason = outcome.reason === "signed_out" ? "GitHub no longer accepts your sign-in. Sign out and sign in again." : `GitHub refused ${what} (HTTP ${outcome.status ?? "?"}).`;
    return redirect(`${url}/stories?notice=partial&created=${commented.length + created.length}&reason=${encodeURIComponent(reason)}`);
  };
  for (const story of review ?? []) {
    if (!edited.commented.includes(story.number)) continue;
    const outcome = await commentIssue(request, env, project, story.number, commentOf(story.comment, saved.rev));
    if (!outcome.ok) return stop(outcome, `the comment on #${story.number}`);
    commented.push(story.number);
  }
  for (const [position, index] of edited.kept.entries()) {
    const story = edited.split.stories[index];
    if (!story) continue;
    const outcome = await createRequest(request, env, project, viewer.login, { title: story.title, answers: story.answers }, rubriques, originOf(position + 1, edited.kept.length, saved.rev));
    if (!outcome.ok) return stop(outcome, "to create the issue");
    await linkStory(env.DB, saved, viewer.login, outcome.number, outcome.url);
    // Nice to have as proposed (and kept), and the priority its card gives.
    if (story.nice) await setNice(env.DB, project.repo, card.id, outcome.number, true, viewer.login);
    const to = storyPriority(rules, card.priority, Boolean(story.nice));
    if (to) await setPriority(env, project, viewer.login, outcome.number, to);
    created.push(index);
  }
  const current = (await findCard(env.DB, project.repo, card.id)) ?? saved;
  await saveSplit(env.DB, current, viewer.login, null);
  if (review) {
    await activityStatement(env.DB, {
      actor: viewer.login,
      action: "card_stories_reviewed",
      repo: project.repo,
      details: { card: card.id, title: card.title, rev: saved.rev, commented, created: created.length },
    }).run();
  }
  await advanceStatus(env.DB, project.repo, card.id, viewer.login, "validated", review ? "stories reviewed" : "stories made");
  return redirect(`${url}?notice=${review ? "reviewed" : "stories"}&created=${created.length}#stories`);
}

// One entry point for the routes above; the caller has checked the
// session, the method's form and its CSRF token.
export async function cardRoute(
  request: Request,
  env: Env,
  viewer: Viewer,
  match: RegExpExecArray,
  form: () => Promise<FormData | null>,
): Promise<Response> {
  const project = await findProject(env.DB, match[1] ?? "");
  if (!project) return notFound(viewer);
  const path = match[2] ?? "";
  const id = match[3] ? Number(match[3]) : null;
  const method = request.method;
  const notAllowed = () => new Response("Method not allowed", { status: 405 });
  const withForm = async (handler: (form: FormData) => Promise<Response>) => {
    const data = await form();
    return data ? handler(data) : html(messagePage("Not allowed", "This form expired: reload the page.", viewer), { status: 403 });
  };

  if (path === "board") {
    if (method === "GET") return showBoard(request, env, viewer, project);
    if (method === "POST") return withForm((data) => boardAction(data, env, viewer, project));
    return notAllowed();
  }
  // The sprint's live connection: Claude's runs, pushed (CardLive).
  if (path === "sprint/live") {
    if (method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("A WebSocket is expected.", { status: 426 });
    const live = sprintLiveFor(env, project.repo);
    return live ? live.fetch(request) : new Response("Not found", { status: 404 });
  }
  // The sprint running by itself: what it will do, before it starts.
  if (path === "sprint/run") {
    if (method !== "GET") return notAllowed();
    if (!can(viewer.role, "promote")) return forbidden(viewer);
    const [{ view, cookies }, { plan }] = await Promise.all([projectView(request, env, project, viewer), loadRunPlan(env, project)]);
    return html(runPreviewPage(viewer, view, plan, runRefusal(project)), { cookies });
  }
  // A story's detail, from the sprint: its steps, pull requests, runs, history.
  const storyPath = /^sprint\/stories\/(\d{1,9})$/.exec(path);
  if (storyPath) {
    if (method !== "GET") return notAllowed();
    const [{ view, cookies }, detail] = await Promise.all([projectView(request, env, project, viewer), loadStoryDetail(env, project, Number(storyPath[1]))]);
    return html(storyDetailPage(viewer, view, detail), { cookies });
  }
  if (path === "sprint") {
    if (method === "GET") return sprintRoute(request, env, viewer, project, null);
    if (method === "POST") return withForm((data) => sprintRoute(request, env, viewer, project, data));
    return notAllowed();
  }
  if (path === "cards/new") return method === "GET" ? showCardForm(request, env, viewer, project, null) : notAllowed();
  if (path === "cards/export") return method === "GET" ? downloadCards(env, project) : notAllowed();
  if (path === "cards/import") {
    if (method === "GET") return importRoute(request, env, viewer, project, null);
    if (method === "POST") return withForm((data) => importRoute(request, env, viewer, project, data));
    return notAllowed();
  }
  if (path === "cards") return method === "POST" ? withForm((data) => submitCard(request, data, env, viewer, project)) : notAllowed();
  if (id && match[4] === "/edit") return method === "GET" ? showCardForm(request, env, viewer, project, id) : notAllowed();
  // The card's live connection: what Claude's job does, pushed (CardLive).
  if (id && match[4] === "/live") {
    if (method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("A WebSocket is expected.", { status: 426 });
    const card = await findCard(env.DB, project.repo, id);
    const live = liveFor(env, id);
    if (!card || !live) return new Response("Not found", { status: 404 });
    return live.fetch(request);
  }
  if (id && match[4] === "/spec") return method === "GET" ? showSpecForm(request, env, viewer, project, id) : notAllowed();
  if (id && match[4] === "/stories") {
    if (method === "GET") return splitRoute(request, env, viewer, project, id, null);
    if (method === "POST") return withForm((data) => splitRoute(request, env, viewer, project, id, data));
    return notAllowed();
  }
  if (id && match[4] === "/story") {
    if (method === "GET") return storyRoute(request, env, viewer, project, id, null);
    if (method === "POST") return withForm((data) => storyRoute(request, env, viewer, project, id, data));
    return notAllowed();
  }
  if (id) {
    if (method === "GET") return showCardPage(request, env, viewer, project, id);
    if (method === "POST") return withForm((data) => changeCard(request, data, env, viewer, project, id));
  }
  return notAllowed();
}

// The go, from the sprint of a project with an integration branch: what
// production would receive, as the Production tab shows it.
async function sprintGo(env: Env, project: Project, viewer: Viewer): Promise<string | null> {
  const [production, checks, last] = await Promise.all([loadProduction(env, project), storyChecks(env.DB, project.repo), lastGo(env.DB, project.repo)]);
  if (!production.status) return null;
  return goSection(viewer, project, production.status, {
    canGo: can(viewer.role, "promote"),
    declared: typeof project.check?.config?.workflows?.["promouvoir"] === "string",
    last,
    checks,
    summary: goSummary(production.status, production.stories, checks),
  }, true);
}
