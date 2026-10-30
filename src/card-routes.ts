import { boardPage, cardFormPage, cardPage, cardRef, cardTile, cardUrl, specFormPage, storyPage } from "./card-views";
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
  updateCard,
  type Card,
  type CardInput,
  type Dimension,
  type FreeDimension,
} from "./cards";
import type { Env } from "./env";
import { html, json, redirect } from "./http";
import { allowance, cardCalls, cardSpends } from "./llm";
import { findProject, type Project } from "./projects";
import { createRequest, issueBody, type RequestDraft } from "./requests";
import { missingSections, readSpecForm, specRubriques, writeSpec, type Answer } from "./specs";
import { wordingFor } from "./wording";
import { can } from "./rights";
import { projectUrl } from "./urls";
import { projectView } from "./view-context";
import { messagePage, type Viewer } from "./views";

// /projects/{repo}/board, /cards, /cards/new, /cards/export, /cards/{id}, /cards/{id}/edit, /spec, /story
export const CARD_ROUTE = /^\/projects\/([^/]+\/[^/]+?)\/(board|cards|cards\/new|cards\/export|cards\/(\d{1,9})(\/edit|\/spec|\/story)?)$/;

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

export async function showBoard(request: Request, env: Env, viewer: Viewer, project: Project): Promise<Response> {
  const url = new URL(request.url);
  const board = readBoardQuery(url.searchParams);
  const [cards, { view, cookies }, spends] = await Promise.all([
    listCards(env.DB, project.repo),
    projectView(request, env, project, viewer),
    cardSpends(env.DB, project.repo),
  ]);
  const known = await dimensionValues(env.DB, project.repo, cards);
  const notice = url.searchParams.get("notice");
  return html(
    boardPage(viewer, view, {
      cards: filterCards(cards, board.filters),
      total: cards.filter((card) => !card.archivedAt).length,
      known,
      board,
      canWrite: canWriteCards(viewer),
      spends,
      notice: notice ? BOARD_NOTICES[notice] : undefined,
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
    const value = cleanValue(form.get("value"));
    if (isFreeDimension(dimension) && value) {
      const cards = await listCards(env.DB, project.repo);
      const known = await dimensionValues(env.DB, project.repo, cards);
      if (!known[dimension].some((existing) => existing.toLowerCase() === value.toLowerCase())) {
        await addValue(env.DB, project.repo, dimension, value, viewer.login);
      }
    }
    const back = backTo(project, form);
    return redirect(`${back}${back.includes("?") ? "&" : "?"}notice=added`);
  }
  if (action !== "move") return json({ error: "Unknown action." }, { status: 400 });

  const id = Number(form.get("card"));
  const card = Number.isInteger(id) && id > 0 ? await findCard(env.DB, project.repo, id) : null;
  if (!card) return json({ error: "This card is no longer here: reload the board." }, { status: 404 });
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
  const spends = await cardSpends(env.DB, project.repo);
  return json({ ok: true, html: cardTile(moved, true, spends.get(moved.id)) });
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
  const known = await dimensionValues(env.DB, project.repo, cards);
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
  archived: "Archived: it no longer shows on the board.",
  restored: "Back on the board.",
  version_restored: "That version is back, as the newest one.",
  spec: "Spec written. Read it, then revise it with Claude or by hand.",
  spec_saved: "Spec saved.",
  story: "Story created on GitHub.",
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
  const [revisions, links, calls, claude, { view, cookies }] = await Promise.all([
    cardRevisions(env.DB, card.id),
    cardLinks(env.DB, card.id),
    cardCalls(env.DB, card.id),
    canWriteCards(viewer) ? allowance(env, viewer.role, viewer.login) : Promise.resolve({ ok: false as const, reason: "" }),
    projectView(request, env, project, viewer),
  ]);
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
    if (action === "spec_answer" && !answers.length && !instruction) {
      return renderCard(request, env, viewer, project, card, { failure: "Answer at least one of Claude's questions.", status: 422 });
    }
    if (action === "spec_revise" && !instruction) {
      return renderCard(request, env, viewer, project, card, { failure: "Say what should change.", ...keep, status: 422 });
    }
    const allowed = await allowance(env, viewer.role, viewer.login);
    if (!allowed.ok) return renderCard(request, env, viewer, project, card, { failure: allowed.reason, ...keep, status: 429 });
    const outcome = await writeSpec(env, project, card, viewer.login, { mode: action === "spec_draft" ? "draft" : "revise", instruction, answers });
    if (!outcome.ok) return renderCard(request, env, viewer, project, card, { failure: outcome.message, ...keep, status: 502 });
    // The card may have changed while Claude wrote: the spec goes on the newest version.
    const current = (await findCard(env.DB, project.repo, card.id)) ?? card;
    await saveSpec(env.DB, current, viewer.login, outcome.spec, outcome.callId);
    return redirect(`${url}?notice=spec#spec`);
  }
  if (action === "spec_save") {
    if (Number(form.get("rev")) !== card.rev) {
      return renderCard(request, env, viewer, project, card, { failure: "The card changed while you were editing its spec: your text was not saved. Open the spec again.", status: 409 });
    }
    await saveSpec(env.DB, card, viewer.login, readSpecForm(form, specRubriques(project), card.data.spec));
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
  const origin = wordingFor(project).fromCard(cardRef(card.id), new URL(cardUrl(project.repo, card.id), request.url).toString());
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
  return redirect(`${url}?notice=story`);
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
  if (path === "cards/new") return method === "GET" ? showCardForm(request, env, viewer, project, null) : notAllowed();
  if (path === "cards/export") return method === "GET" ? downloadCards(env, project) : notAllowed();
  if (path === "cards") return method === "POST" ? withForm((data) => submitCard(request, data, env, viewer, project)) : notAllowed();
  if (id && match[4] === "/edit") return method === "GET" ? showCardForm(request, env, viewer, project, id) : notAllowed();
  if (id && match[4] === "/spec") return method === "GET" ? showSpecForm(request, env, viewer, project, id) : notAllowed();
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
