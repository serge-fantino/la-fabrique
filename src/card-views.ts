import {
  axisValues,
  CARD_KINDS,
  CARD_STATUSES,
  DIMENSION_LABELS,
  DIMENSIONS,
  excerpt,
  FREE_DIMENSIONS,
  isFreeDimension,
  KIND_LABELS,
  MAX_BODY,
  MAX_TITLE,
  MAX_VALUE,
  STATUS_LABELS,
  valueLabel,
  valueOf,
  type Axis,
  type BoardQuery,
  type Card,
  type CardInput,
  type CardLink,
  type CardRevision,
  type CardTags,
  type FreeDimension,
} from "./cards";
import { renderMarkdown } from "./markdown";
import { notice, projectContext, projectHeader } from "./project-views";
import type { Project } from "./projects";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, formatDate, layout, type Viewer } from "./views";

const BOARD_SCRIPT = "/board.js";
const DRAFT_SCRIPT = "/request-draft.js";

function title(project: Project, page: string): string {
  return `${page} · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`;
}

export function cardRef(id: number): string {
  return `C${id}`;
}

export function cardUrl(repo: string, id: number): string {
  return `${projectUrl(repo)}/cards/${id}`;
}

export function cardDraftKey(repo: string): string {
  return `lf-card:${repo.toLowerCase()}`;
}

function tag(dimension: FreeDimension, value: string): string {
  return `<span class="tag"><span class="tag-dim">${DIMENSION_LABELS[dimension]}</span> ${escapeHtml(value)}</span>`;
}

export function cardPills(tags: Partial<CardTags>): string {
  const pills = [
    tags.kind ? `<span class="pill kind">${KIND_LABELS[tags.kind]}</span>` : "",
    tags.status ? `<span class="pill card-${tags.status}">${STATUS_LABELS[tags.status]}</span>` : "",
    ...FREE_DIMENSIONS.map((dimension) => (tags[dimension] ? tag(dimension, tags[dimension] ?? "") : "")),
  ];
  return pills.filter(Boolean).join(" ");
}

// One card on the board: a white card, its text and its tags.
export function cardTile(card: Card, canMove: boolean): string {
  const url = cardUrl(card.repo, card.id);
  const text = excerpt(card.body);
  const free = FREE_DIMENSIONS.filter((dimension) => card[dimension]).map((dimension) => tag(dimension, card[dimension] ?? ""));
  return `<article class="fiche${card.archivedAt ? " archived" : ""}" id="card-${card.id}" data-card="${card.id}">
      <div class="fiche-top">
        <a class="fiche-id mono" href="${escapeHtml(url)}">${cardRef(card.id)}</a>
        <span class="pill kind">${KIND_LABELS[card.kind]}</span>
        <span class="pill card-${card.status}">${STATUS_LABELS[card.status]}</span>
        ${card.archivedAt ? `<span class="pill alert">Archived</span>` : ""}
        ${canMove ? `<button type="button" class="fiche-grip" data-grip aria-label="Move ${cardRef(card.id)}, ${escapeHtml(card.title)}" title="Drag to move; or Space, then the arrow keys">⠿</button>` : ""}
      </div>
      <h3 class="fiche-title"><a href="${escapeHtml(url)}">${escapeHtml(card.title)}</a></h3>
      ${text ? `<p class="fiche-text">${escapeHtml(text)}</p>` : ""}
      ${free.length ? `<p class="fiche-tags">${free.join(" ")}</p>` : ""}
    </article>`;
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function axisSelect(name: string, label: string, current: Axis): string {
  return `<label>${label}
      <select name="${name}" data-autosubmit>
        ${option("none", name === "by" ? "Nothing (free order)" : "Nothing", current === "none")}
        ${DIMENSIONS.map((dimension) => option(dimension, DIMENSION_LABELS[dimension], current === dimension)).join("")}
      </select>
    </label>`;
}

function query(params: Record<string, string>): string {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== ""));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function boardQueryString(board: BoardQuery): string {
  const { filters } = board;
  const params: Record<string, string> = { by: board.by, then: board.then === "none" ? "" : board.then };
  if (filters.kind) params["kind"] = filters.kind;
  if (filters.status) params["status"] = filters.status;
  for (const dimension of FREE_DIMENSIONS) {
    const value = filters.values[dimension];
    if (value !== undefined) params[dimension] = value === "" ? "-" : value;
  }
  if (filters.q) params["q"] = filters.q;
  if (filters.all) params["all"] = "1";
  return query(params);
}

function filterBar(base: string, board: BoardQuery, known: Record<FreeDimension, string[]>): string {
  const { filters } = board;
  const free = FREE_DIMENSIONS.map((dimension) => {
    const current = filters.values[dimension];
    return `<label>${DIMENSION_LABELS[dimension]}
        <select name="${dimension}" data-autosubmit>
          ${option("", "Any", current === undefined)}
          ${known[dimension].map((value) => option(value, value, current === value)).join("")}
          ${option("-", "Not set", current === "")}
        </select>
      </label>`;
  }).join("");
  const active =
    [filters.kind, filters.status, filters.q || null].filter(Boolean).length +
    FREE_DIMENSIONS.filter((dimension) => filters.values[dimension] !== undefined).length +
    (filters.all ? 1 : 0);
  return `<form method="get" action="${escapeHtml(base)}/board" class="filters board-filters" data-board-arrange>
      <fieldset class="board-arrange">
        <legend>Arrange</legend>
        ${axisSelect("by", "Columns", board.by)}
        ${axisSelect("then", "Then rows", board.then)}
      </fieldset>
      <details class="board-show"${active ? " open" : ""}>
        <summary>Filters${active ? ` <span class="pill">${active} on</span>` : ""}</summary>
        <div class="board-show-fields">
        <label>Type
          <select name="kind" data-autosubmit>${option("", "Any", !filters.kind)}${CARD_KINDS.map((kind) => option(kind, KIND_LABELS[kind], filters.kind === kind)).join("")}</select>
        </label>
        <label>Status
          <select name="status" data-autosubmit>${option("", "Any", !filters.status)}${CARD_STATUSES.map((status) => option(status, STATUS_LABELS[status], filters.status === status)).join("")}</select>
        </label>
        ${free}
        <label>Text
          <input type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="Words, C12" />
        </label>
        <label class="check"><input type="checkbox" name="all" value="1"${filters.all ? " checked" : ""} data-autosubmit /> Dropped and archived</label>
        ${active ? `<a class="board-clear" href="${escapeHtml(base)}/board?by=${board.by}${board.then === "none" ? "" : `&amp;then=${board.then}`}">Clear the filters</a>` : ""}
        </div>
      </details>
      <button type="submit" class="button quiet board-apply">Show</button>
    </form>`;
}

// "+" in a column or row: a new card already placed there.
function newCardLink(base: string, placed: Record<string, string>, label: string): string {
  const params = Object.fromEntries(Object.entries(placed).filter(([key]) => key !== "none"));
  return `<a class="board-add" href="${escapeHtml(`${base}/cards/new${query(params)}`)}" aria-label="${escapeHtml(label)}">+</a>`;
}

function cellAttributes(placed: Record<string, string>): string {
  return Object.entries(placed)
    .filter(([key]) => key !== "none")
    .map(([key, value]) => ` data-set-${key}="${escapeHtml(value)}"`)
    .join("");
}

function addValueForm(viewer: Viewer, base: string, dimension: FreeDimension, back: string, where: "column" | "row"): string {
  return `<form method="post" action="${escapeHtml(base)}/board" class="board-new-value board-new-${where}">${csrfField(viewer)}
      <input type="hidden" name="action" value="add_value" />
      <input type="hidden" name="dimension" value="${dimension}" />
      <input type="hidden" name="back" value="${escapeHtml(back)}" />
      <label class="visually-hidden" for="new-${where}">New ${DIMENSION_LABELS[dimension].toLowerCase()}</label>
      <input id="new-${where}" name="value" maxlength="${MAX_VALUE}" required placeholder="New ${DIMENSION_LABELS[dimension].toLowerCase()}" />
      <button type="submit" class="button quiet">Add</button>
    </form>`;
}

export interface BoardData {
  cards: Card[];
  total: number;
  known: Record<FreeDimension, string[]>;
  board: BoardQuery;
  canWrite: boolean;
  notice?: string | undefined;
}

export function boardPage(viewer: Viewer, project: Project, data: BoardData): string {
  const base = projectUrl(project.repo);
  const { board, known, canWrite } = data;
  const back = boardQueryString(board).slice(1);
  const columns = axisValues(board.by, known);
  const rows = axisValues(board.then, known);
  const cell = (columnValue: string, rowValue: string) => {
    const placed = { [board.by]: columnValue, [board.then]: rowValue };
    const cards = data.cards.filter((card) => valueOf(card, board.by) === columnValue && valueOf(card, board.then) === rowValue);
    return `<div class="board-cell" data-cell${cellAttributes(placed)}>${cards.map((card) => cardTile(card, canWrite)).join("")}</div>`;
  };
  const count = (predicate: (card: Card) => boolean) => data.cards.filter(predicate).length;
  const head = (value: string) => {
    const label = valueLabel(board.by, value);
    return `<div class="board-head">
        <span class="board-head-label${value ? "" : " muted"}">${escapeHtml(label)}</span>
        <span class="mono muted small" data-count-column="${escapeHtml(value)}">${count((card) => valueOf(card, board.by) === value)}</span>
        ${canWrite ? newCardLink(base, { [board.by]: value }, `New card in ${label}`) : ""}
      </div>`;
  };

  let grid: string;
  if (board.by === "none") {
    grid = `<div class="board-free">${cell("", "")}</div>`;
  } else if (board.then === "none") {
    const extra = canWrite && isFreeDimension(board.by) ? `<div class="board-column board-ghost">${addValueForm(viewer, base, board.by, back, "column")}</div>` : "";
    grid = `<div class="board-columns">${columns
      .map((value) => `<section class="board-column" aria-label="${escapeHtml(valueLabel(board.by, value))}">${head(value)}${cell(value, "")}</section>`)
      .join("")}${extra}</div>`;
  } else {
    const ghostColumn = canWrite && isFreeDimension(board.by);
    const rowHtml = rows
      .map((rowValue) => {
        const label = valueLabel(board.then, rowValue);
        return `<div class="board-row" role="group" aria-label="${escapeHtml(label)}">
            <div class="board-row-head">
              <span class="board-head-label${rowValue ? "" : " muted"}">${escapeHtml(label)}</span>
              <span class="mono muted small" data-count-row="${escapeHtml(rowValue)}">${count((card) => valueOf(card, board.then) === rowValue)}</span>
            </div>
            ${columns.map((value) => cell(value, rowValue)).join("")}
          </div>`;
      })
      .join("");
    const ghostRow =
      canWrite && isFreeDimension(board.then)
        ? `<div class="board-row"><div class="board-row-head board-ghost">${addValueForm(viewer, base, board.then, back, "row")}</div></div>`
        : "";
    grid = `<div class="board-grid">
        <div class="board-row board-row-heads"><div class="board-row-head"></div>${columns.map(head).join("")}${
          ghostColumn ? `<div class="board-ghost">${addValueForm(viewer, base, board.by as FreeDimension, back, "column")}</div>` : ""
        }</div>
        ${rowHtml}
        ${ghostRow}
      </div>`;
  }

  const shown = data.cards.length;
  const summary =
    data.total === 0
      ? `No card yet. A card is a few lines about a feature or an idea, before it becomes a story (if ever).`
      : `<strong>${shown} card${shown === 1 ? "" : "s"}</strong>${shown === data.total ? "" : ` of ${data.total}`}.`;

  return layout(
    title(project, "Board"),
    `${projectHeader(project, "board")}
      <div class="title-row">
        <p class="board-summary">${summary}</p>
        ${canWrite ? `<a class="button" href="${escapeHtml(base)}/cards/new">New card</a>` : ""}
      </div>
      ${notice(data.notice, "ok")}
      ${filterBar(base, board, known)}
      <p class="board-status muted" data-board-status role="status" aria-live="polite"></p>
      <div class="board-scroll">
        <div class="board" data-board data-by="${board.by}" data-then="${board.then}" data-move="${escapeHtml(base)}/board" data-csrf="${escapeHtml(viewer.csrfToken)}">
          ${grid}
        </div>
      </div>
      <p class="muted small board-foot">Drag a card by its handle to another place: it takes that place's values.
        <a href="${escapeHtml(base)}/cards/export">Export every card (JSON)</a></p>`,
    viewer,
    [BOARD_SCRIPT],
    projectContext(project),
  );
}

// ---- A card --------------------------------------------------------------

const TOKEN = /(\d+)/g;

// The text in Markdown, its annotations as tags and links.
export function renderCardText(body: string, repo: string): string {
  const pieces: string[] = [];
  const keep = (html: string) => {
    pieces.push(html);
    return `${pieces.length - 1}`;
  };
  const source = body
    .replace(/[]/g, "")
    .replace(/\{\s*(epic|domain|segment|release)\s*:\s*([^{}\n]*?)\s*\}/gi, (_all, dimension: string, value: string) =>
      keep(value.trim() ? tag(dimension.toLowerCase() as FreeDimension, value.trim()) : ""),
    )
    .replace(/\[\[([^[\]\n]{1,60})\]\]/g, (_all, term: string) => keep(`<span class="term" title="Glossary term">${escapeHtml(term.trim())}</span>`))
    .replace(/(^|[\s(])#(\d{1,7})\b/g, (_all, before: string, number: string) =>
      before + keep(`<a href="https://github.com/${escapeHtml(repo)}/issues/${number}">#${number}</a>`),
    )
    .replace(/(^|[\s(])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})\b/gi, (_all, before: string, login: string) =>
      before + keep(`<span class="mono">@${escapeHtml(login)}</span>`),
    );
  const { html } = renderMarkdown(source, {
    path: "",
    isPage: () => false,
    pageUrl: (path) => path,
    githubUrl: (path) => `https://github.com/${repo}/blob/HEAD/${path}`,
  });
  return html.replace(TOKEN, (_all, index: string) => pieces[Number(index)] ?? "");
}

export interface CardPageData {
  card: Card;
  revisions: CardRevision[];
  links: CardLink[];
  shown: CardRevision | null;
  canWrite: boolean;
  created: boolean;
  notice?: string | undefined;
}

export function cardPage(viewer: Viewer, project: Project, data: CardPageData): string {
  const { card } = data;
  const base = projectUrl(project.repo);
  const url = cardUrl(project.repo, card.id);
  const shown = data.shown;
  const heading = shown ? shown.title : card.title;
  const body = shown ? shown.body : card.body;
  const tags = shown ? shown.tags : card;
  const banner = shown
    ? `<p class="ref-banner" role="status">Version ${shown.rev} of ${card.rev}, by <span class="mono">@${escapeHtml(shown.author)}</span>
        on <span class="mono">${formatDate(shown.at)}</span>. <a href="${escapeHtml(url)}">Back to the current version</a></p>`
    : "";
  const actions =
    data.canWrite && !shown
      ? `<div class="card-actions">
          <a class="button" href="${escapeHtml(url)}/edit">Edit</a>
          <form method="post" action="${escapeHtml(url)}" class="inline">${csrfField(viewer)}
            <input type="hidden" name="action" value="${card.archivedAt ? "restore" : "archive"}" />
            <button type="submit" class="button quiet">${card.archivedAt ? "Restore" : "Archive"}</button>
          </form>
        </div>`
      : "";
  const issues = data.links.filter((link) => link.kind === "issue");
  const people = data.links.filter((link) => link.kind === "person");
  const terms = data.links.filter((link) => link.kind === "term");
  const linkRows: [string, string][] = [];
  if (issues.length)
    linkRows.push([
      "Issues",
      issues.map((link) => `<a href="https://github.com/${escapeHtml(project.repo)}/issues/${escapeHtml(link.ref)}">#${escapeHtml(link.ref)}</a>`).join(", "),
    ]);
  if (people.length) linkRows.push(["People", people.map((link) => `<span class="mono">@${escapeHtml(link.ref)}</span>`).join(", ")]);
  if (terms.length) linkRows.push(["Terms", terms.map((link) => `<span class="term">${escapeHtml(link.ref)}</span>`).join(" ")]);
  const history = data.revisions
    .map(
      (revision) => `<li><a href="${escapeHtml(url)}?rev=${revision.rev}"${shown?.rev === revision.rev ? ' aria-current="true"' : ""}>Version ${revision.rev}</a>
          <span class="mono muted">@${escapeHtml(revision.author)} · ${formatDate(revision.at)}</span></li>`,
    )
    .join("");

  return layout(
    title(project, `${cardRef(card.id)} ${card.title}`),
    `${projectHeader(project, "board")}
      ${data.created ? `<p class="notice ok" role="status" data-draft-clear="${escapeHtml(cardDraftKey(project.repo))}">Card ${cardRef(card.id)} written.</p>` : ""}
      ${notice(data.notice, "ok")}
      <p class="crumbs"><a href="${escapeHtml(base)}/board#card-${card.id}">Board</a> <span aria-hidden="true">›</span> <span class="mono">${cardRef(card.id)}</span></p>
      ${banner}
      <h1>${escapeHtml(heading)}</h1>
      <p class="fiche-tags">${cardPills(tags)}${card.archivedAt ? ` <span class="pill alert">Archived</span>` : ""}</p>
      <article class="markdown card-text">
${body.trim() ? renderCardText(body, project.repo) : `<p class="muted">No text yet.</p>`}
      </article>
      ${actions}
      ${linkRows.length ? `<h2>Mentioned</h2><dl class="facts">${linkRows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>` : ""}
      <h2>History</h2>
      <p class="muted small">Written by <span class="mono">@${escapeHtml(card.author)}</span> on <span class="mono">${formatDate(card.createdAt)}</span>. Every version is kept.</p>
      <ul class="card-history">${history}</ul>`,
    viewer,
    data.created ? [DRAFT_SCRIPT] : [],
    projectContext(project),
  );
}

// ---- Writing a card ------------------------------------------------------

export interface CardFormData {
  card: Card | null;
  input: CardInput;
  known: Record<FreeDimension, string[]>;
  error?: string | undefined;
  conflict?: Card | undefined;
}

export function cardFormPage(viewer: Viewer, project: Project, data: CardFormData): string {
  const base = projectUrl(project.repo);
  const { card, input, known } = data;
  const action = card ? cardUrl(project.repo, card.id) : `${base}/cards`;
  const free = FREE_DIMENSIONS.map(
    (dimension) => `<div class="field">
        <label for="f_${dimension}">${DIMENSION_LABELS[dimension]}</label>
        <input id="f_${dimension}" name="${dimension}" maxlength="${MAX_VALUE}" list="v_${dimension}" value="${escapeHtml(input.tags[dimension] ?? "")}" autocomplete="off" />
        <datalist id="v_${dimension}">${known[dimension].map((value) => `<option value="${escapeHtml(value)}"></option>`).join("")}</datalist>
      </div>`,
  ).join("");
  const conflict = data.conflict
    ? `<div class="notice error" role="alert"><p>Someone changed this card while you were editing it
        (version ${data.conflict.rev}, by the history). Your text is below, not saved: compare with
        <a href="${escapeHtml(cardUrl(project.repo, data.conflict.id))}">the current version</a>, then save again.</p></div>`
    : "";
  return layout(
    title(project, card ? `Edit ${cardRef(card.id)}` : "New card"),
    `${projectHeader(project, "board", card ? `Edit ${cardRef(card.id)}` : "New card")}
      <p class="crumbs"><a href="${escapeHtml(base)}/board">Board</a>${card ? ` <span aria-hidden="true">›</span> <a class="mono" href="${escapeHtml(cardUrl(project.repo, card.id))}">${cardRef(card.id)}</a>` : ""}</p>
      ${conflict}
      ${notice(data.error, "error")}
      <form method="post" action="${escapeHtml(action)}" class="request-form card-form"${card ? "" : ` data-draft-key="${escapeHtml(cardDraftKey(project.repo))}"`}>
        ${csrfField(viewer)}
        <input type="hidden" name="action" value="save" />
        ${card ? `<input type="hidden" name="rev" value="${data.conflict?.rev ?? card.rev}" />` : ""}
        <div class="field">
          <label for="f_title">Title <span class="muted">(required)</span></label>
          <input id="f_title" name="title" required maxlength="${MAX_TITLE}" value="${escapeHtml(input.title)}" />
        </div>
        <div class="field">
          <label for="f_body">Text</label>
          <p class="help" id="f_body_help">A few lines: what it is, for whom, why. Markdown.
            <code>{segment: pro}</code> sets a tag (epic, domain, segment, release; it wins over the fields below),
            <code>#12</code> points to an issue, <code>@login</code> to a person, <code>[[Basket]]</code> to a term.</p>
          <textarea id="f_body" name="body" rows="12" maxlength="${MAX_BODY}" aria-describedby="f_body_help">${escapeHtml(input.body)}</textarea>
        </div>
        <div class="card-form-tags">
          <div class="field">
            <label for="f_kind">Type</label>
            <select id="f_kind" name="kind">${CARD_KINDS.map((kind) => option(kind, KIND_LABELS[kind], input.tags.kind === kind)).join("")}</select>
          </div>
          <div class="field">
            <label for="f_status">Status</label>
            <select id="f_status" name="status">${CARD_STATUSES.map((status) => option(status, STATUS_LABELS[status], input.tags.status === status)).join("")}</select>
          </div>
          ${free}
        </div>
        ${card ? "" : `<p class="muted" data-draft-status aria-live="polite"></p>`}
        <div class="card-actions">
          <button type="submit" class="button">${card ? "Save" : "Write the card"}</button>
          <a href="${escapeHtml(card ? cardUrl(project.repo, card.id) : `${base}/board`)}">Cancel</a>
        </div>
      </form>`,
    viewer,
    card ? [] : [DRAFT_SCRIPT],
    projectContext(project),
  );
}
