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
  type CardSpec,
  type CardTags,
  type FreeDimension,
} from "./cards";
import { formatUsd, type CallRow, type Spend } from "./llm";
import { renderMarkdown } from "./markdown";
import type { Rubrique } from "./requests";
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
export function cardTile(card: Card, canMove: boolean, spend?: Spend): string {
  const url = cardUrl(card.repo, card.id);
  const text = excerpt(card.body);
  const free = FREE_DIMENSIONS.filter((dimension) => card[dimension]).map((dimension) => tag(dimension, card[dimension] ?? ""));
  return `<article class="fiche${card.archivedAt ? " archived" : ""}" id="card-${card.id}" data-card="${card.id}">
      <div class="fiche-top">
        <a class="fiche-id mono" href="${escapeHtml(url)}">${cardRef(card.id)}</a>
        <span class="pill kind">${KIND_LABELS[card.kind]}</span>
        <span class="pill card-${card.status}">${STATUS_LABELS[card.status]}</span>
        ${card.archivedAt ? `<span class="pill alert">Archived</span>` : ""}
        ${spend?.calls ? `<span class="fiche-cost mono" title="Claude on this card: ${escapeHtml(spendLine(spend))}">${formatUsd(spend.micros)}</span>` : ""}
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
  spends: Map<number, Spend>;
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
    return `<div class="board-cell" data-cell${cellAttributes(placed)}>${cards.map((card) => cardTile(card, canWrite, data.spends.get(card.id))).join("")}</div>`;
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

const PURPOSES: Record<string, string> = {
  spec_draft: "Spec written",
  spec_revise: "Spec revised",
  key_check: "Key checked",
};

const OUTCOMES: Record<string, string> = { ok: "", refused: "declined", error: "failed" };

export function callsTable(calls: CallRow[], showCard = false): string {
  if (!calls.length) return "";
  return `<table class="calls">
      <thead><tr><th>When</th><th>Who</th>${showCard ? "<th>Card</th>" : ""}<th>What</th><th>Model</th><th class="number">Tokens in / out</th><th class="number">Cost</th></tr></thead>
      <tbody>${calls
        .map((call) => {
          const cached = call.cache_read_tokens + call.cache_write_tokens;
          return `<tr>
            <td class="mono muted nowrap">${formatDate(call.at)}</td>
            <td class="mono">@${escapeHtml(call.login)}</td>
            ${showCard ? `<td>${call.card_id && call.repo ? `<a class="mono" href="${escapeHtml(cardUrl(call.repo, call.card_id))}">${cardRef(call.card_id)}</a>` : ""}</td>` : ""}
            <td>${escapeHtml(PURPOSES[call.purpose] ?? call.purpose)}${OUTCOMES[call.outcome] ? ` <span class="pill alert">${OUTCOMES[call.outcome]}</span>` : ""}</td>
            <td class="mono small">${escapeHtml(call.model ?? "")}</td>
            <td class="mono number">${call.input_tokens + cached} / ${call.output_tokens}${cached ? `<br /><span class="muted small">${call.cache_read_tokens} from cache</span>` : ""}</td>
            <td class="mono number">${formatUsd(call.cost_micros)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

export function spendLine(spend: Spend): string {
  return `${spend.calls} call${spend.calls === 1 ? "" : "s"} · ${formatUsd(spend.micros)}${spend.unknown ? ` (+ ${spend.unknown} at an unknown price)` : ""}`;
}

function specHtml(spec: CardSpec | undefined, rubriques: Rubrique[], repo: string): string {
  if (!spec) return `<p class="muted">No spec yet. Claude can write a first one from the card, the project's principles and what the project already has.</p>`;
  const sections = rubriques
    .map(
      (rubrique) => `<h3>${escapeHtml(rubrique.titre)}</h3>
        ${spec.answers[rubrique.cle]?.trim() ? `<div class="markdown">${renderCardText(spec.answers[rubrique.cle] ?? "", repo)}</div>` : `<p class="muted">—</p>`}`,
    )
    .join("");
  const questions = spec.questions.length
    ? `<div class="spec-questions"><h3>Claude asks</h3><ul>${spec.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul>
        <p class="muted small">Answer them below, in “Revise with Claude”.</p></div>`
    : "";
  const by = spec.source === "claude" ? "Written with Claude" : "Edited by hand";
  return `<p class="muted small">${by} on <span class="mono">${formatDate(spec.at)}</span>.${spec.note ? ` ${escapeHtml(spec.note)}` : ""}</p>
    <div class="spec">${sections}</div>
    ${questions}`;
}

export interface CardPageData {
  card: Card;
  revisions: CardRevision[];
  links: CardLink[];
  shown: CardRevision | null;
  canWrite: boolean;
  created: boolean;
  notice?: string | undefined;
  failure?: string | undefined;
  rubriques: Rubrique[];
  claude: { usable: boolean; reason: string | null };
  calls: CallRow[];
  spend: Spend;
  missing: string[];
  instruction?: string | undefined;
}

export function cardPage(viewer: Viewer, project: Project, data: CardPageData): string {
  const { card } = data;
  const base = projectUrl(project.repo);
  const url = cardUrl(project.repo, card.id);
  const shown = data.shown;
  const heading = shown ? shown.title : card.title;
  const body = shown ? shown.body : card.body;
  const tags = shown ? shown.tags : card;
  const spec = shown ? shown.data.spec : card.data.spec;
  const restore =
    shown && data.canWrite
      ? ` <form method="post" action="${escapeHtml(url)}" class="inline">${csrfField(viewer)}
          <input type="hidden" name="action" value="restore_version" />
          <input type="hidden" name="rev" value="${shown.rev}" />
          <button type="submit" class="button quiet">Restore this version</button>
        </form>`
      : "";
  const banner = shown
    ? `<div class="ref-banner" role="status"><p>Version ${shown.rev} of ${card.rev}, by <span class="mono">@${escapeHtml(shown.author)}</span>
        on <span class="mono">${formatDate(shown.at)}</span>. <a href="${escapeHtml(url)}">Back to the current version</a></p>${restore}</div>`
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
  const stories = data.links.filter((link) => link.kind === "story");
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

  // Claude: write the spec, then revise it; the story once it is complete.
  let work = "";
  if (data.canWrite && !shown) {
    const claude = data.claude.usable
      ? spec
        ? `<form method="post" action="${escapeHtml(url)}" class="claude-form">${csrfField(viewer)}
            <input type="hidden" name="action" value="spec_revise" />
            <label for="instruction">Revise with Claude</label>
            <p class="help" id="instruction_help">Answer its questions, correct what is wrong, ask for what is missing. Claude keeps the rest.</p>
            <textarea id="instruction" name="instruction" rows="4" required maxlength="4000" aria-describedby="instruction_help">${escapeHtml(data.instruction ?? "")}</textarea>
            <div class="card-actions"><button type="submit" class="button">Revise with Claude</button><span class="muted small">Up to a minute.</span></div>
          </form>`
        : `<form method="post" action="${escapeHtml(url)}" class="claude-form">${csrfField(viewer)}
            <input type="hidden" name="action" value="spec_draft" />
            <label for="instruction">Anything to tell Claude first? <span class="muted">(optional)</span></label>
            <textarea id="instruction" name="instruction" rows="3" maxlength="4000">${escapeHtml(data.instruction ?? "")}</textarea>
            <div class="card-actions"><button type="submit" class="button">Write the spec with Claude</button><span class="muted small">Up to a minute.</span></div>
          </form>`
      : `<p class="muted">${escapeHtml(data.claude.reason ?? "Claude is not available.")}</p>`;
    const story = spec
      ? data.missing.length
        ? `<p class="muted">To make the story, fill in: ${data.missing.map(escapeHtml).join(", ")}.</p>`
        : `<p><a class="button" href="${escapeHtml(url)}/story">Make the story on GitHub</a></p>`
      : "";
    work = `${claude}
      <div class="card-actions"><a href="${escapeHtml(url)}/spec">${spec ? "Edit the spec by hand" : "Write the spec by hand"}</a></div>
      ${story}`;
  }

  return layout(
    title(project, `${cardRef(card.id)} ${card.title}`),
    `${projectHeader(project, "board")}
      ${data.created ? `<p class="notice ok" role="status" data-draft-clear="${escapeHtml(cardDraftKey(project.repo))}">Card ${cardRef(card.id)} written.</p>` : ""}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      <p class="crumbs"><a href="${escapeHtml(base)}/board#card-${card.id}">Board</a> <span aria-hidden="true">›</span> <span class="mono">${cardRef(card.id)}</span></p>
      ${banner}
      <h1>${escapeHtml(heading)}</h1>
      <p class="fiche-tags">${cardPills(tags)}${card.archivedAt ? ` <span class="pill alert">Archived</span>` : ""}</p>
      <article class="markdown card-text">
${body.trim() ? renderCardText(body, project.repo) : `<p class="muted">No text yet.</p>`}
      </article>
      ${actions}
      <section class="card-spec" id="spec">
        <h2>Spec</h2>
        ${specHtml(spec, data.rubriques, project.repo)}
        ${work}
      </section>
      ${
        stories.length
          ? `<h2>Stories</h2><ul class="card-stories">${stories
              .map((link) => `<li><a href="https://github.com/${escapeHtml(project.repo)}/issues/${escapeHtml(link.ref)}">#${escapeHtml(link.ref)}</a></li>`)
              .join("")}</ul>`
          : ""
      }
      ${linkRows.length ? `<h2>Mentioned</h2><dl class="facts">${linkRows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>` : ""}
      <h2>Claude on this card</h2>
      <p>${data.spend.calls ? spendLine(data.spend) : `<span class="muted">No call yet.</span>`}</p>
      ${callsTable(data.calls)}
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

// ---- The spec by hand, and the story ----------------------------------------

export function specFormPage(viewer: Viewer, project: Project, data: { card: Card; rubriques: Rubrique[]; spec: CardSpec | undefined }): string {
  const { card } = data;
  const url = cardUrl(project.repo, card.id);
  const fields = data.rubriques
    .map((rubrique) => {
      const id = `s_${rubrique.cle}`;
      return `<div class="field">
          <label for="${id}">${escapeHtml(rubrique.titre)}${rubrique.obligatoire ? ` <span class="muted">(required for the story)</span>` : ""}</label>
          ${rubrique.aide ? `<p class="help" id="${id}_help">${escapeHtml(rubrique.aide)}</p>` : ""}
          <textarea id="${id}" name="${id}" rows="6"${rubrique.aide ? ` aria-describedby="${id}_help"` : ""}>${escapeHtml(data.spec?.answers[rubrique.cle] ?? "")}</textarea>
        </div>`;
    })
    .join("");
  return layout(
    title(project, `Spec of ${cardRef(card.id)}`),
    `${projectHeader(project, "board", `Spec of ${cardRef(card.id)}`)}
      <p class="crumbs"><a href="${escapeHtml(projectUrl(project.repo))}/board">Board</a> <span aria-hidden="true">›</span> <a class="mono" href="${escapeHtml(url)}">${cardRef(card.id)}</a> ${escapeHtml(card.title)}</p>
      <form method="post" action="${escapeHtml(url)}" class="request-form">${csrfField(viewer)}
        <input type="hidden" name="action" value="spec_save" />
        <input type="hidden" name="rev" value="${card.rev}" />
        ${fields}
        <div class="card-actions">
          <button type="submit" class="button">Save the spec</button>
          <a href="${escapeHtml(url)}#spec">Cancel</a>
        </div>
      </form>`,
    viewer,
    [],
    projectContext(project),
  );
}

export function storyPage(
  viewer: Viewer,
  project: Project,
  data: { card: Card; title: string; body: string; label: string | null; error?: string | undefined },
): string {
  const { card } = data;
  const url = cardUrl(project.repo, card.id);
  return layout(
    title(project, `Story from ${cardRef(card.id)}`),
    `${projectHeader(project, "board", `Story from ${cardRef(card.id)}`)}
      <p class="crumbs"><a href="${escapeHtml(projectUrl(project.repo))}/board">Board</a> <span aria-hidden="true">›</span> <a class="mono" href="${escapeHtml(url)}">${cardRef(card.id)}</a> ${escapeHtml(card.title)}</p>
      ${notice(data.error, "error")}
      <p>The story becomes an issue in <code>${escapeHtml(project.repo)}</code>, under your GitHub name${data.label ? `, labelled <code>${escapeHtml(data.label)}</code>` : ""}. From then on it lives on GitHub; the card keeps the link.</p>
      <form method="post" action="${escapeHtml(url)}/story" class="request-form">${csrfField(viewer)}
        <div class="field">
          <label for="story_title">Title</label>
          <input id="story_title" name="title" required maxlength="200" value="${escapeHtml(data.title)}" />
        </div>
        <h2>What GitHub will receive</h2>
        <article class="markdown story-preview">${renderCardText(data.body, project.repo)}</article>
        <div class="card-actions">
          <button type="submit" class="button">Create the story on GitHub</button>
          <a href="${escapeHtml(url)}#spec">Back to the card</a>
        </div>
      </form>`,
    viewer,
    [],
    projectContext(project),
  );
}
