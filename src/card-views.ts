import type { PendingEpic } from "./epic-conversion";
import { warningsHtml } from "./dependency-warnings";
import type { Dependencies, dependencyHistory } from "./card-dependencies";
import { type ValidationState } from "./feature-validation";
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
  MAX_IMPORT,
  MAX_VALUE,
  SHOWN_STATUSES,
  shownStatus,
  shownStatusLabel,
  STATUS_LABELS,
  CARD_MENTION,
  valueLabel,
  valueOf,
  type Axis,
  type BoardQuery,
  type Card,
  type CardInput,
  type CardLink,
  type CardRevision,
  type CardSpec,
  type CardSplit, type CardTests,
  type StoryReview,
  type CardTags,
  type FreeDimension,
} from "./cards";
import { NEXT_RELEASE, RELEASE_STATE_LABELS, SPRINT_LANE, type BoardRelease } from "./card-releases";
import { isActive, jobLabel, type Job, type JobEvent, type JobKind } from "./jobs";
import type { Stage } from "./lifecycle";
import { epicDependenciesSection, type EpicDependencies } from "./epic-dependencies";
import { epicProgressSection, epicProgressSummary, type EpicProgress } from "./epic-progress";
import type { EpicIssueView } from "./epic-issue";
import { isProgressStage, PROGRESS_LABELS, progressDetail, progressPill, shippedNote, type Progress } from "./progress-stages";
import { storyStatus } from "./stories-views";
import { formatUsd, type CallRow, type Spend } from "./llm";
import { epicActions, epicHistoryHtml, epicStatusPill } from "./epics-views";
import type { EpicHistoryEntry, EpicState } from "./epic-status";
import { notesHtml, reviewHtml } from "./epic-review";
import { EPIC_REST_FIELD, epicFieldName, epicSections, parseEpicBody } from "./epic-sections";
import { renderMarkdown } from "./markdown";
import { EDITOR_DEFAULT_BUTTON, storyBlocks } from "./story-editor";
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

// The address that never changes, even if the project's repository is
// renamed; with `rev`, the exact version of the card (and of its spec).
export function cardPermalink(id: number, rev?: number): string {
  return `/c/${id}${rev ? `?rev=${rev}` : ""}`;
}

export function cardDraftKey(repo: string): string {
  return `lf-card:${repo.toLowerCase()}`;
}

function tag(dimension: FreeDimension, value: string): string {
  return `<span class="tag"><span class="tag-dim">${DIMENSION_LABELS[dimension]}</span> ${escapeHtml(value)}</span>`;
}

// `status`: what stands for the status pill (the form that changes it).
export function cardPills(tags: Partial<CardTags>, status?: string): string {
  const pills = [
    tags.kind ? `<span class="pill kind">${KIND_LABELS[tags.kind]}</span>` : "",
    status ?? (tags.status ? `<span class="pill card-${tags.status}">${STATUS_LABELS[tags.status]}</span>` : ""),
    ...FREE_DIMENSIONS.map((dimension) => (tags[dimension] ? tag(dimension, tags[dimension] ?? "") : "")),
  ];
  return pills.filter(Boolean).join(" ");
}

// A card's status: where its spec stands, then, once Validated with
// stories, where its stories stand, with their count.
export function statusPill(card: Pick<Card, "status" | "progress">, progress?: Progress | null, since?: string | null): string {
  const shown = shownStatus(card);
  if (isProgressStage(shown) && progress) return progressPill(progress, since);
  return `<span class="pill card-${shown}">${shownStatusLabel(shown)}</span>`;
}

// One card on the board: a white card, its text and its tags.
export function cardTile(card: Card, canMove: boolean, spend?: Spend, working = false, progress?: Progress | null): string {
  const url = cardUrl(card.repo, card.id);
  const text = excerpt(card.body);
  const free = FREE_DIMENSIONS.filter((dimension) => card[dimension]).map((dimension) => tag(dimension, card[dimension] ?? ""));
  return `<article class="fiche${card.archivedAt ? " archived" : ""}" id="card-${card.id}" data-card="${card.id}">
      <div class="fiche-top">
        <a class="fiche-id mono" href="${escapeHtml(url)}">${cardRef(card.id)}</a>
        <span class="pill kind">${KIND_LABELS[card.kind]}</span>
        ${statusPill(card, progress)}
        ${card.priority ? `<span class="pill">${escapeHtml(card.priority)}</span>` : ""}
        ${card.archivedAt ? `<span class="pill alert">Archived</span>` : ""}
        ${working ? `<span class="pill warn">Claude working</span>` : ""}
        ${spend?.calls ? `<span class="fiche-cost mono" title="Claude on this card: ${escapeHtml(spendLine(spend))}">${formatUsd(spend.micros)}</span>` : ""}
        ${canMove ? `<button type="button" class="fiche-grip" data-grip aria-label="Move ${cardRef(card.id)}, ${escapeHtml(card.title)}" title="Drag to move; or Space, then the arrow keys">⠿</button>` : ""}
      </div>
      <h3 class="fiche-title"><a href="${escapeHtml(url)}">${escapeHtml(card.title)}</a></h3>
      ${text ? `<p class="fiche-text">${escapeHtml(text)}</p>` : ""}
      ${free.length ? `<p class="fiche-tags">${free.join(" ")}</p>` : ""}
      ${shippedNote(progress?.shipped, "fiche-shipped small")}
    </article>`;
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function axisSelect(name: string, label: string, current: Axis): string {
  return `<label>${label}
      <select name="${name}" data-autosubmit>
        ${option("none", name === "by" ? "None (free order)" : "None", current === "none")}
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
  if (board.hideEmpty) params["empty"] = "hide";
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
        <legend class="visually-hidden">Arrange</legend>
        ${axisSelect("by", "Lane", board.by)}
        ${board.by === "none" ? "" : axisSelect("then", "Group by", board.then)}
        ${board.by === "none" ? "" : `<label class="check"><input type="checkbox" name="empty" value="hide"${board.hideEmpty ? " checked" : ""} data-autosubmit /> ${board.by === "release" || board.then === "release" ? "Hide closed lanes" : "Hide empty lanes"}</label>`}
      </fieldset>
      <details class="board-show"${active ? " open" : ""}>
        <summary>Filters${active ? ` <span class="pill">${active} on</span>` : ""}</summary>
        <div class="board-show-fields">
        <label>Type
          <select name="kind" data-autosubmit>${option("", "Any", !filters.kind)}${CARD_KINDS.map((kind) => option(kind, KIND_LABELS[kind], filters.kind === kind)).join("")}</select>
        </label>
        <label>Status
          <select name="status" data-autosubmit>${option("", "Any", !filters.status)}${SHOWN_STATUSES.map((status) => option(status, shownStatusLabel(status), filters.status === status)).join("")}</select>
        </label>
        ${free}
        <label>Text
          <input type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="Words, C12, #170" />
        </label>
        <label class="check"><input type="checkbox" name="all" value="1"${filters.all ? " checked" : ""} data-autosubmit /> Dropped and archived</label>
        ${active ? `<a class="board-clear" href="${escapeHtml(base)}/board?by=${board.by}${board.then === "none" ? "" : `&amp;then=${board.then}`}${board.hideEmpty ? "&amp;empty=hide" : ""}">Clear the filters</a>` : ""}
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

// "New lane" in the board's header: a button that unfolds its field. A
// release is planned ahead, in the project's numbering.
function addValueForm(viewer: Viewer, base: string, dimension: FreeDimension, back: string, where: "lane" | "group", next: string | null = null): string {
  const release = dimension === "release";
  const what = release ? "Plan a release" : where === "lane" ? "New lane" : "New group";
  const field = release ? "Version" : `New ${DIMENSION_LABELS[dimension].toLowerCase()}`;
  return `<details class="board-new" data-autofocus>
      <summary class="button quiet">${what}</summary>
      <form method="post" action="${escapeHtml(base)}/board" class="board-new-value">${csrfField(viewer)}
        <input type="hidden" name="action" value="add_value" />
        <input type="hidden" name="dimension" value="${dimension}" />
        <input type="hidden" name="back" value="${escapeHtml(back)}" />
        <label class="visually-hidden" for="new-${where}">${field}</label>
        <input id="new-${where}" name="value" maxlength="${MAX_VALUE}" required placeholder="${escapeHtml(release && next ? next : field)}"${release && next ? ` value="${escapeHtml(next)}"` : ""} />
        <button type="submit" class="button">${release ? "Plan" : "Add"}</button>
        <button type="button" class="button quiet" data-panel-close>Cancel</button>
      </form>
    </details>`;
}

export interface BoardData {
  cards: Card[];
  total: number;
  known: Record<FreeDimension, string[]>;
  board: BoardQuery;
  canWrite: boolean;
  spends: Map<number, Spend>;
  // The cards where Claude is working.
  working: Set<number>;
  notice?: string | undefined;
  failure?: string | undefined;
  // The project's releases, shipped, in progress or planned, by version.
  releases: Map<string, BoardRelease>;
  nextRelease: string | null;
  // Distinct typed Epic values waiting to become epic cards (Product Engineer and above).
  toConvert?: number;
  // Each card's progress, from its stories.
  progress?: Map<number, Progress>;
  // Each epic's progress by lowercased title, for the Epic lanes' headers.
  epics?: Map<string, { id: number; progress: EpicProgress }>;
}

// Shipped is done, in progress is on its way, planned is not started.
const RELEASE_TONES: Record<BoardRelease["state"], string> = { shipped: "ok", in_progress: "warn", planned: "kind" };

export function boardPage(viewer: Viewer, project: Project, data: BoardData): string {
  const base = projectUrl(project.repo);
  const { board, known, canWrite } = data;
  const back = boardQueryString(board).slice(1);
  // Hiding empty lanes keeps only the values the cards shown have, and
  // every release still open (in progress, planned).
  const open = (axis: Axis, value: string) => axis === "release" && (data.releases.get(value)?.state ?? "shipped") !== "shipped";
  const lanes = (axis: Axis) => {
    const values = axisValues(axis, known);
    return board.hideEmpty && axis !== "none"
      ? values.filter((value) => open(axis, value) || data.cards.some((card) => valueOf(card, axis) === value))
      : values;
  };
  const releaseNote = (axis: Axis, value: string) => {
    const release = axis === "release" ? data.releases.get(value) : undefined;
    // Next release needs no pill; the Sprint lane says it is in progress.
    if (release?.version === NEXT_RELEASE) return ` <a class="small" href="${escapeHtml(base)}/refinement">Refine</a>`;
    if (!release) return "";
    const planned = release.sprintVersion ? ` <span class="mono small">${escapeHtml(release.sprintVersion)}</span>` : "";
    if (release.onInt?.length) {
      return `${planned} <span class="pill ${RELEASE_TONES[release.state]} small">${RELEASE_STATE_LABELS[release.state]}</span> <span class="mono small">${release.onInt.map((version) => escapeHtml(version)).join(", ")} (int)</span>`;
    }
    if (planned) return `${planned} <span class="pill ${RELEASE_TONES[release.state]} small">${RELEASE_STATE_LABELS[release.state]}</span>`;
    const label = release.sprint && release.version !== SPRINT_LANE ? "Sprint" : release.integration ? "On int" : RELEASE_STATE_LABELS[release.state];
    return ` <span class="pill ${RELEASE_TONES[release.state]} small">${label}</span>${release.integration ? ` <code class="small">${escapeHtml(release.integration)}</code>` : ""}`;
  };
  const titleOf = (axis: Axis, value: string) => {
    const release = axis === "release" ? data.releases.get(value) : undefined;
    const title = release?.onInt?.length
      ? `${release.title ?? "The sprint in progress"}; ${release.onInt.join(", ")} on the ${release.integration ?? "integration"} branch, waiting for the go`
      : release?.integration
        ? `On the ${release.integration} branch, waiting for the go${release.title ? `: ${release.title}` : ""}`
        : release?.title;
    return title ? ` title="${escapeHtml(title)}"` : "";
  };
  const columns = lanes(board.by);
  const rows = lanes(board.then);
  const cell = (columnValue: string, rowValue: string) => {
    const placed = { [board.by]: columnValue, [board.then]: rowValue };
    const cards = data.cards.filter((card) => valueOf(card, board.by) === columnValue && valueOf(card, board.then) === rowValue);
    return `<div class="board-cell" data-cell${cellAttributes(placed)}>${cards.map((card) => cardTile(card, canWrite, data.spends.get(card.id), data.working.has(card.id), data.progress?.get(card.id))).join("")}</div>`;
  };
  const count = (predicate: (card: Card) => boolean) => data.cards.filter(predicate).length;
  const epicNote = (axis: Axis, value: string) => {
    const progress = axis === "epic" ? data.epics?.get(value.trim().toLowerCase())?.progress : undefined;
    return progress ? `<div class="epic-head">${epicProgressSummary(progress, true)}</div>` : "";
  };
  // An epic lane is headed by the epic's title, linked to its page (la-fabrique#296).
  const labelOf = (axis: Axis, value: string) => {
    const text = escapeHtml(valueLabel(axis, value));
    const epic = axis === "epic" && value ? data.epics?.get(value.trim().toLowerCase()) : undefined;
    return epic ? `<a href="${escapeHtml(cardUrl(project.repo, epic.id))}">${text}</a>` : text;
  };
  const head = (value: string) => {
    const label = valueLabel(board.by, value);
    return `<div class="board-head">
        <span class="board-head-label${value ? "" : " muted"}"${titleOf(board.by, value)}>${labelOf(board.by, value)}${releaseNote(board.by, value)}</span>
        <span class="mono muted small" data-count-column="${escapeHtml(value)}">${count((card) => valueOf(card, board.by) === value)}</span>
        ${epicNote(board.by, value)}
        ${canWrite && !(board.by === "status" && isProgressStage(value)) ? newCardLink(base, { [board.by]: value }, `New card in ${label}`) : ""}
      </div>`;
  };

  let grid: string;
  if (board.by === "none") {
    grid = `<div class="board-free">${cell("", "")}</div>`;
  } else if (board.then === "none") {
    grid = `<div class="board-columns">${columns
      .map((value) => `<section class="board-column" aria-label="${escapeHtml(valueLabel(board.by, value))}">${head(value)}${cell(value, "")}</section>`)
      .join("")}</div>`;
  } else {
    const rowHtml = rows
      .map((rowValue) => {
        const label = valueLabel(board.then, rowValue);
        return `<div class="board-row" role="group" aria-label="${escapeHtml(label)}">
            <div class="board-row-head">
              <span class="board-head-label${rowValue ? "" : " muted"}"${titleOf(board.then, rowValue)}>${labelOf(board.then, rowValue)}${releaseNote(board.then, rowValue)}</span>
              <span class="mono muted small" data-count-row="${escapeHtml(rowValue)}">${count((card) => valueOf(card, board.then) === rowValue)}</span>
              ${epicNote(board.then, rowValue)}
            </div>
            ${columns.map((value) => cell(value, rowValue)).join("")}
          </div>`;
      })
      .join("");
    grid = `<div class="board-grid">
        <div class="board-row board-row-heads"><div class="board-row-head"></div>${columns.map(head).join("")}</div>
        ${rowHtml}
      </div>`;
  }

  const shown = data.cards.length;
  const summary = `<strong>${shown} card${shown === 1 ? "" : "s"}</strong>${shown === data.total ? "" : ` of ${data.total}`}`;
  // A new lane, and a new group when the rows are a free dimension too.
  const newLanes = canWrite
    ? [
        // No release planned by number: it could ship with other work and
        // carry its cards away undone; Next release is there instead.
        ...(isFreeDimension(board.by) && board.by !== "release" ? [addValueForm(viewer, base, board.by, back, "lane", data.nextRelease)] : []),
        ...(isFreeDimension(board.then) && board.then !== board.by && board.then !== "release" ? [addValueForm(viewer, base, board.then, back, "group", data.nextRelease)] : []),
      ].join("")
    : "";

  return layout(
    title(project, "Board"),
    `${projectHeader(project, "board")}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      ${data.toConvert ? `<p class="notice"><a href="${escapeHtml(base)}/cards/epics">${data.toConvert} epic${data.toConvert === 1 ? "" : "s"} to create from the Epic values</a>: review, then confirm.</p>` : ""}
      <div class="board-bar">
        ${filterBar(base, board, known)}
        <div class="board-bar-end">
          <span class="board-summary">${summary}</span>
          ${newLanes}
          ${canWrite ? `<a class="button" href="${escapeHtml(base)}/cards/new">New card</a>` : ""}
        </div>
      </div>
      ${data.total === 0 ? `<p class="muted">No card yet. A card is a few lines about a feature or an idea, before it becomes a story (if ever).</p>` : ""}
      <p class="board-status muted" data-board-status role="status" aria-live="polite"></p>
      <div class="board-scroll">
        <div class="board" data-board data-by="${board.by}" data-then="${board.then}" data-move="${escapeHtml(base)}/board" data-csrf="${escapeHtml(viewer.csrfToken)}">
          ${grid}
        </div>
      </div>
      <p class="muted small board-foot">Drag a card by its handle to another place: it takes that place's values.
        <a href="${escapeHtml(base)}/cards/export">Export every card (JSON)</a>${canWrite ? ` · <a href="${escapeHtml(base)}/cards/import">Import cards (JSON)</a>` : ""}</p>`,
    viewer,
    [BOARD_SCRIPT],
    projectContext(project, false),
  );
}

// ---- A card --------------------------------------------------------------

const TOKEN = /(\d+)/g;

// The text in Markdown, its annotations as tags and links.
// `cards` holds, per card id of the project, the HTML of its link with its
// status: a "C57" naming one of them becomes that.
export function renderCardText(body: string, repo: string, imageUrl?: (src: string) => string | null, cards?: ReadonlyMap<number, string>, embeds?: ReadonlyMap<number, string>): string {
  const pieces: string[] = [];
  const blocks = new Set<number>();
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
    .replace(/^[ \t]*C(\d{1,6})[ \t]*$/gm, (all, id: string) => {
      const block = embeds?.get(Number(id));
      if (!block) return all;
      blocks.add(pieces.length);
      return keep(block);
    })
    .replace(CARD_MENTION, (all, id: string) => {
      const link = cards?.get(Number(id));
      return link ? keep(link) : all;
    })
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
    ...(imageUrl ? { imageUrl } : {}),
  });
  const placed = html.replace(new RegExp(`<p>${TOKEN.source}</p>`, "g"), (all, index: string) =>
    blocks.has(Number(index)) ? (pieces[Number(index)] ?? "") : all,
  );
  return placed.replace(TOKEN, (_all, index: string) => pieces[Number(index)] ?? "");
}

// The test cases Claude wrote for the feature's stories, each editable.
function testsHtml(viewer: Viewer, url: string, tests: CardTests | undefined, canEdit: boolean): string {
  if (!tests) return "";
  const body = tests.stories
    .map((story, i) => {
      const label = `${story.number ? `#${story.number} ` : ""}${story.title}`;
      return canEdit
        ? `<div class="field"><label for="gherkin_${i}">${escapeHtml(label)}</label><textarea id="gherkin_${i}" name="gherkin_${i}" class="mono" rows="${Math.min(24, Math.max(6, story.gherkin.split("\n").length + 1))}" maxlength="20000">${escapeHtml(story.gherkin)}</textarea></div>`
        : `<h3>${escapeHtml(label)}</h3><pre>${escapeHtml(story.gherkin)}</pre>`;
    })
    .join("");
  const head = `<h2 id="tests">Test cases</h2><p class="muted small">Written ${tests.edited ? "and edited " : ""}by Claude on <span class="mono">${escapeHtml(tests.at.slice(0, 10))}</span>, kept in La Fabrique, not on GitHub.${tests.note ? ` ${escapeHtml(tests.note)}` : ""}</p>`;
  return canEdit
    ? `<section class="card-tests">${head}<form method="post" action="${escapeHtml(url)}#tests" data-busy="Saving…">${csrfField(viewer)}${body}<div class="card-actions"><button type="submit" class="button" name="action" value="tests_save">Save the test cases</button></div></form></section>`
    : `<section class="card-tests">${head}${body}</section>`;
}

const PURPOSES: Record<string, string> = {
  spec_draft: "Spec written",
  epic_draft: "Epic document written",
  epic_revise: "Epic document revised",
  spec_revise: "Spec revised",
  spec_split: "Stories proposed",
  spec_tests: "Test cases written",
  epic_features: "Features proposed",
  epic_review: "Epic reviewed",
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

function specHtml(spec: CardSpec | undefined, rubriques: Rubrique[], repo: string, cards?: ReadonlyMap<number, string>, embeds?: ReadonlyMap<number, string>): string {
  if (!spec) return `<p class="muted">No spec yet. Claude can write a first one from the card, the project's principles and what the project already has, and ask what it needs to know.</p>`;
  const sections = rubriques
    .map(
      (rubrique) => `<h3>${escapeHtml(rubrique.titre)}</h3>
        ${spec.answers[rubrique.cle]?.trim() ? `<div class="markdown">${renderCardText(spec.answers[rubrique.cle] ?? "", repo, undefined, cards, embeds)}</div>` : `<p class="muted">—</p>`}`,
    )
    .join("");
  const by = spec.source === "claude" ? "Written with Claude" : "Edited by hand";
  return `<p class="muted small">${by} on <span class="mono">${formatDate(spec.at)}</span>.${spec.note ? ` ${escapeHtml(spec.note)}` : ""}</p>
    <div class="spec">${sections}</div>`;
}

// What Claude asked and was answered (or left): it does not ask again.
function dialogueHtml(spec: CardSpec | undefined): string {
  const dialogue = spec?.dialogue ?? [];
  if (!dialogue.length) return "";
  return `<details class="spec-dialogue">
      <summary>Questions answered (${dialogue.length})</summary>
      <dl>${dialogue
        .map((turn) => `<dt>${escapeHtml(turn.question)}</dt><dd>${turn.skipped ? `<span class="muted">Left unanswered.</span>` : escapeHtml(turn.answer)}</dd>`)
        .join("")}</dl>
    </details>`;
}

// Claude's questions: a field under each one, sent together; or why there
// are none left. Read-only for those who cannot write, and while Claude works.
function questionsHtml(viewer: Viewer, url: string, spec: CardSpec | undefined, canAnswer: boolean): string {
  if (!spec) return "";
  const questions = spec.questions;
  if (!questions.length) {
    if (spec.closed) return `<p class="spec-enough">You closed the questions: Claude asks nothing more unless you ask it for a change.</p>`;
    if (spec.enough) return `<p class="spec-enough"><strong>Claude knows enough to write the stories.</strong>${spec.note ? ` ${escapeHtml(spec.note)}` : ""}</p>`;
    return "";
  }
  if (!canAnswer) {
    return `<div class="spec-questions"><h3>Claude asks</h3><ul>${questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul></div>`;
  }
  const fields = questions
    .map(
      (question, index) => `<div class="field">
          <label for="answer_${index}">${escapeHtml(question)}</label>
          <input type="hidden" name="question_${index}" value="${escapeHtml(question)}" />
          <textarea id="answer_${index}" name="answer_${index}" rows="2" maxlength="2000"></textarea>
        </div>`,
    )
    .join("");
  return `<form method="post" action="${escapeHtml(url)}#claude-job" class="spec-questions" data-busy="Sending…">${csrfField(viewer)}
      <h3>Claude asks</h3>
      <p class="muted small">Answer what you can; leave the rest empty. Claude revises the spec with your answers, and may ask again. When you think it knows enough, close the questions.</p>
      ${fields}
      <div class="field">
        <label for="answer_more">Anything else? <span class="muted">(optional)</span></label>
        <textarea id="answer_more" name="instruction" rows="2" maxlength="4000"></textarea>
      </div>
      <div class="card-actions">
        <button type="submit" class="button claude" name="action" value="spec_answer">Send my answers to Claude</button>
        <button type="submit" class="button quiet" name="action" value="spec_enough" formnovalidate>Enough questions</button>
      </div>
    </form>`;
}

// What Claude's job is doing: its state, the time, its log; pushed live to
// the page (/fabrique.js, the card's CardLive). A failed job says why, keeps
// what was sent, and can be tried again.
function jobHtml(viewer: Viewer, url: string, job: Job | null, events: JobEvent[], canRetry: boolean): string {
  if (!job || job.status === "done") return "";
  const active = isActive(job);
  const sent = job.request.answers.length
    ? `<div class="job-sent"><p class="muted small">Your answers, sent to Claude on <span class="mono">${formatDate(job.createdAt)}</span>:</p>
        <dl>${job.request.answers.map((turn) => `<dt>${escapeHtml(turn.question)}</dt><dd>${escapeHtml(turn.answer)}</dd>`).join("")}</dl>
        ${job.request.instruction ? `<p>${escapeHtml(job.request.instruction)}</p>` : ""}</div>`
    : job.request.instruction
      ? `<div class="job-sent"><p class="muted small">Your request, sent on <span class="mono">${formatDate(job.createdAt)}</span>:</p><p>${escapeHtml(job.request.instruction)}</p></div>`
      : "";
  const log = events.map((event) => `<li><span class="mono muted">${escapeHtml(event.at.slice(11, 19))}</span> ${escapeHtml(event.text)}</li>`).join("");
  const retry =
    job.status === "failed" && canRetry
      ? `<form method="post" action="${escapeHtml(url)}#claude-job" class="inline" data-busy="Sending…">${csrfField(viewer)}
          <button type="submit" class="button claude" name="action" value="job_retry">Try again</button>
        </form>`
      : "";
  return `<section class="claude-job${job.status === "failed" ? " failed" : ""}" id="claude-job"${
    active ? ` data-live="${escapeHtml(url)}/live" data-job="${job.id}" data-since="${escapeHtml(job.createdAt)}"` : ""
  } aria-live="polite">
      <div class="claude-job-head">
        ${active ? `<span class="claude-job-dot" aria-hidden="true"></span>` : ""}
        <strong data-job-label>${escapeHtml(jobLabel(job))}</strong>
        ${active ? `<span class="mono muted" data-job-elapsed></span>` : ""}
      </div>
      ${active ? `<p class="muted small">You can leave the page: Claude goes on, and the spec is here when you come back.</p>` : ""}
      ${sent}
      <details class="claude-job-log"${job.status === "failed" ? " open" : ""}>
        <summary>What Claude does</summary>
        <ol data-job-log>${log}</ol>
      </details>
      ${retry}
    </section>`;
}

export interface CardPageData {
  card: Card;
  // The project's priority labels, highest first.
  priorities: string[];
  revisions: CardRevision[];
  links: CardLink[];
  shown: CardRevision | null;
  canWrite: boolean;
  created: boolean;
  attachedOnCreate?: number | undefined;
  notice?: string | undefined;
  failure?: string | undefined;
  rubriques: Rubrique[];
  claude: { usable: boolean; reason: string | null };
  calls: CallRow[];
  spend: Spend;
  // An epic: the calls on its features too, counted with its own.
  epicSpend?: Spend;
  missing: string[];
  instruction?: string | undefined;
  // The request to Claude kept open after a failure.
  ask?: "draft" | "change" | null;
  job: Job | null;
  events: JobEvent[];
  // Claude's proposal to split the spec, waiting for review.
  split: CardSplit | undefined;
  // The card's stories as GitHub has them: title and stage.
  storyStates: Map<number, StoryState>;
  // Its progress from those stories, and the stages it went through (log).
  progress?: Progress | null;
  progressHistory?: { to: string | null; at: string }[];
  // The stories that name this card ("C5") without being linked to it
  // (la-fabrique#218): proposed, never linked by themselves.
  named?: { number: number; title: string; url: string }[];
  // Cards of the project named in the text or spec ("C57"): link and status.
  mentioned?: ReadonlyMap<number, string>;
  // Cards named alone on a line: the HTML shown in place (la-fabrique#290).
  embedded?: ReadonlyMap<number, string>;
  // The feature's validation (la-fabrique#232), and whether it can be asked now.
  validation?: ValidationState;
  canValidate?: boolean;
  // For an epic: its progress, from its features (la-fabrique#303).
  epic?: import("./epic-progress").EpicProgress;
  // Dependencies on other features or epics, both ways (la-fabrique#298).
  dependencies?: Dependencies;
  dependencyOptions?: { cards: Card[]; epics: string[] };
  dependencyLog?: Awaited<ReturnType<typeof dependencyHistory>>;
  canDepend?: boolean;
  // The project's epic cards (to pick a feature's epic from), and, on an
  // epic, its features and the features that could be attached.
  epics?: Card[];
  epicState?: EpicState | undefined;
  epicHistory?: EpicHistoryEntry[] | undefined;
  epicFeatures?: Card[];
  epicDeps?: EpicDependencies;
  attachable?: Card[];
  // The GitHub epic issue an epic card started from (la-fabrique#287).
  epicIssue?: EpicIssueView;
  keptFeatures?: number;
}

export const epicIssueSectionForTest = (data: Pick<CardPageData, "epicIssue" | "keptFeatures">) => epicIssueSection(data as CardPageData);

function epicIssueSection(data: CardPageData, isEpic = false): string {
  const issue = data.epicIssue;
  if (!issue) return isEpic ? `<section id="epic-issue"><h2>GitHub epic</h2><p class="muted">No GitHub issue yet: it is created when the first feature of this epic enters refinement (Next release).</p></section>` : "";
  const kept = data.keptFeatures ? `<p class="muted">${data.keptFeatures} feature${data.keptFeatures === 1 ? "" : "s"} of its stories stay in another epic.</p>` : "";
  const none = issue.noFeature.length
    ? `<h3>No feature <span class="muted small">${issue.noFeature.length}</span></h3><ul class="card-stories">${issue.noFeature
        .map((story) => `<li><a href="${escapeHtml(story.url)}"><span class="mono">#${story.number}</span> ${escapeHtml(story.title)}</a></li>`)
        .join("")}</ul>`
    : "";
  return `<section id="epic-issue"><h2>GitHub epic</h2><p><a href="${escapeHtml(issue.url)}"><span class="mono">#${issue.number}</span> ${escapeHtml(issue.title)}</a></p>${kept}${none}</section>`;
}

// A feature's Epic: one of the project's epic cards, or a new name.
function epicSection(viewer: Viewer, url: string, card: Card, data: CardPageData): string {
  if (card.kind === "feature") {
    const epics = data.epics ?? [];
    const current = epics.find((epic) => epic.title.toLowerCase() === (card.epic ?? "").toLowerCase());
    const shown = current
      ? `<a href="${escapeHtml(cardUrl(card.repo, current.id))}">${escapeHtml(current.title)}</a>`
      : card.epic
        ? escapeHtml(card.epic)
        : `<span class="muted">none</span>`;
    const form = data.canWrite
      ? `<form method="post" action="${escapeHtml(url)}" data-busy>${csrfField(viewer)}
          <input type="hidden" name="action" value="set_epic" />
          <label for="epic_name">Choose an epic, or type a new name</label>
          <input id="epic_name" name="epic" maxlength="${MAX_VALUE}" list="epic_choices" value="${escapeHtml(card.epic ?? "")}" autocomplete="off" />
          <datalist id="epic_choices">${epics.map((epic) => `<option value="${escapeHtml(epic.title)}"></option>`).join("")}</datalist>
          <div class="card-actions">
            <button type="submit" class="button">Set the epic</button>
            ${card.epic ? `<button type="submit" class="button quiet" name="epic" value="">Remove the epic</button>` : ""}
          </div>
        </form>`
      : "";
    return `<section id="epic"><h2>Epic</h2><p>${shown}</p>${form}</section>`;
  }
  if (card.kind === "epic") {
    const features = data.epicFeatures ?? [];
    const row = (feature: Card): string => `<li><a href="${escapeHtml(cardUrl(card.repo, feature.id))}"><span class="mono">${cardRef(feature.id)}</span> ${escapeHtml(feature.title)}</a>${
      data.canWrite
        ? ` <form method="post" action="${escapeHtml(url)}" class="inline" data-busy>${csrfField(viewer)}
            <input type="hidden" name="action" value="detach_feature" />
            <input type="hidden" name="feature" value="${feature.id}" />
            <button type="submit" class="button quiet small">Remove</button></form>`
        : ""
    }</li>`;
    // Grouped by status, in the order of the statuses.
    const rows = SHOWN_STATUSES.map((status) => ({ status, list: features.filter((f) => shownStatus(f) === status) }))
      .filter((group) => group.list.length)
      .map((group) => `<h3>${escapeHtml(shownStatusLabel(group.status))} <span class="muted small">${group.list.length}</span></h3><ul class="card-stories">${group.list.map(row).join("")}</ul>`)
      .join("");
    const attach =
      data.canWrite && (data.attachable ?? []).length
        ? `<form method="post" action="${escapeHtml(url)}" data-busy>${csrfField(viewer)}
            <input type="hidden" name="action" value="attach_feature" />
            <label for="attach_feature">Attach a feature (it leaves its current epic)</label>
            <select id="attach_feature" name="feature">${(data.attachable ?? []).map((f) => `<option value="${f.id}">${cardRef(f.id)} ${escapeHtml(f.title)}${f.epic ? ` (now in ${escapeHtml(f.epic)})` : ""}</option>`).join("")}</select>
            <button type="submit" class="button">Attach</button>
          </form>`
        : "";
    return `<section id="features"><h2>Features</h2>${rows || `<p class="muted">No feature attached yet.</p>`}${attach}</section>`;
  }
  return "";
}

function epicPill(cards: Card[]): string {
  if (!cards.length) return `<span class="pill">no feature yet</span>`;
  const done = cards.filter((card) => card.status === "validated").length;
  return `<span class="pill">${cards.length} feature${cards.length === 1 ? "" : "s"}, ${done} validated</span>`;
}

function dependenciesHtml(viewer: Viewer, url: string, project: Project, data: CardPageData): string {
  const deps = data.dependencies;
  if (!deps || data.shown) return "";
  const base = projectUrl(project.repo);
  const link = (card: Card) => `<a class="mono" href="${escapeHtml(base)}/cards/${card.id}">${cardRef(card.id)}</a> ${escapeHtml(card.title)} ${statusPill(card)}`;
  const remove = (on: string) =>
    data.canDepend
      ? ` <form method="post" action="${escapeHtml(url)}" class="inline">${csrfField(viewer)}<input type="hidden" name="action" value="depend_remove" /><input type="hidden" name="on" value="${escapeHtml(on)}" /><button type="submit" class="button quiet" aria-label="Remove this dependency">Remove</button></form>`
      : "";
  const dependsOn = [
    ...deps.dependsOn.map((card) => `<li>Depends on ${link(card)}${remove(String(card.id))}</li>`),
    ...deps.dependsOnEpics.map((entry) => `<li>Depends on epic <strong>${escapeHtml(entry.epic)}</strong> ${epicPill(entry.cards)}${remove(`epic:${entry.epic}`)}</li>`),
  ];
  const needed = deps.neededBy.map((entry) => `<li>Needed by ${link(entry.card)}${entry.viaEpic ? ` <span class="muted small">through epic ${escapeHtml(entry.viaEpic)}</span>` : ""}</li>`);
  const options = data.dependencyOptions;
  const chosen = new Set(deps.dependsOn.map((card) => card.id));
  const form =
    data.canDepend && options && !data.card.archivedAt
      ? `<form method="post" action="${escapeHtml(url)}" class="inline" data-busy>${csrfField(viewer)}<input type="hidden" name="action" value="depend_add" />
          <label for="depend-on">Depends on</label>
          <select id="depend-on" name="on">
            <optgroup label="Features">${options.cards.filter((card) => !chosen.has(card.id)).map((card) => `<option value="${card.id}">${cardRef(card.id)} ${escapeHtml(card.title)}</option>`).join("")}</optgroup>
            <optgroup label="Epics">${options.epics.filter((epic) => !deps.dependsOnEpics.some((entry) => entry.epic === epic)).map((epic) => `<option value="epic:${escapeHtml(epic)}">Epic ${escapeHtml(epic)}</option>`).join("")}</optgroup>
          </select>
          <button type="submit" class="button">Add dependency</button></form>`
      : "";
  const log = (data.dependencyLog ?? [])
    .map((entry) => {
      const target = entry.epic ? `epic ${escapeHtml(entry.epic)}` : cardRef(entry.on ?? 0);
      return `<li><span class="mono muted">@${escapeHtml(entry.actor)} · ${formatDate(entry.at)}</span> ${entry.action === "card_dependency_added" ? "added" : "removed"} the dependency of ${cardRef(entry.card)} on ${target}</li>`;
    })
    .join("");
  return `<section class="card-dependencies" id="dependencies"><h2>Dependencies</h2>
      <p class="muted small">Upstream: what has to come first. Stories keep GitHub's blocked by for technical dependencies.</p>
      ${warningsHtml(deps.warnings, (w) => (w.card ? `${base}/cards/${w.card}` : null))}
      ${dependsOn.length || needed.length ? `<ul class="card-stories">${dependsOn.join("")}${needed.join("")}</ul>` : `<p class="muted">No dependency.</p>`}
      ${form}
      ${log ? `<details><summary>Dependency history</summary><ul class="card-history">${log}</ul></details>` : ""}
    </section>`;
}

// A story that names a card it is not linked to: the form that links it
// (Product Engineer and above), back where it was proposed.
export function linkNamedForm(viewer: Viewer, repo: string, card: number, story: number, back: string): string {
  return `<form method="post" action="${escapeHtml(cardUrl(repo, card))}" class="inline" data-busy>${csrfField(viewer)}
      <input type="hidden" name="action" value="link_story" />
      <input type="hidden" name="story" value="${story}" />
      <input type="hidden" name="back" value="${escapeHtml(back)}" />
      <button type="submit" class="button quiet small">Link to ${cardRef(card)}</button>
    </form>`;
}

export interface StoryState {
  title: string;
  stage: Stage | null;
  closed: boolean;
  // Testing on int: validated, and the criteria ticked.
  validated?: { by: string; at: string } | null;
  criteria?: { done: boolean }[];
}

// The status its stories give it, since when, then the stages it went
// through, dated.
function progressSummary(progress: Progress | null | undefined, history: { to: string | null; at: string }[]): string {
  if (!progress) return "";
  const since = history.at(-1)?.at ?? null;
  const steps = history
    .map((step) => `<li><span class="mono">${escapeHtml(step.at.slice(0, 16).replace("T", " "))}</span> ${isProgressStage(step.to) ? PROGRESS_LABELS[step.to] : "No story"}</li>`)
    .join("");
  return `<p class="card-progress">From its stories: ${progressPill(progress, since)}${since ? ` <span class="muted small">since ${escapeHtml(since.slice(0, 10))}</span>` : ""}</p>
    ${shippedNote(progress.shipped)}
    ${history.length > 1 ? `<details class="card-progress-history"><summary>How it went</summary><ol>${steps}</ol></details>` : ""}`;
}

// What Claude proposes, waiting to be reviewed.
function proposalHtml(url: string, split: CardSplit, spec: CardSpec | undefined): string {
  const count = split.stories.length;
  if (split.review) {
    const changes = split.review.filter((story) => story.verdict === "change").length;
    return `<div class="split-proposal">
      <p><strong>Claude reviewed the ${split.review.length} stor${split.review.length === 1 ? "y" : "ies"}</strong>${split.note ? `: ${escapeHtml(split.note)}` : "."}</p>
      ${spec && spec.at !== split.specAt ? `<p class="notice error">The spec changed since this review: discard it and ask Claude again.</p>` : ""}
      <ul class="split-review">${split.review.map((story) => `<li><span class="mono">#${story.number}</span> ${escapeHtml(story.title)} ${verdictPill(story.verdict)}</li>`).join("")}</ul>
      ${count ? `<p>And ${count} new stor${count === 1 ? "y" : "ies"}:</p><ol>${split.stories.map((story) => `<li>${escapeHtml(story.title)}</li>`).join("")}</ol>` : `<p>No new story.</p>`}
      <a class="button" href="${escapeHtml(url)}/stories">${changes || count ? "Review and apply" : "Review and confirm"}</a>
    </div>`;
  }
  return `<div class="split-proposal">
      <p><strong>Claude proposes ${count} stor${count === 1 ? "y" : "ies"}</strong>${split.note ? `: ${escapeHtml(split.note)}` : "."}</p>
      ${spec && spec.at !== split.specAt ? `<p class="notice error">The spec changed since this split: review it, or ask Claude for a new split after discarding it.</p>` : ""}
      <ol>${split.stories.map((story) => `<li>${escapeHtml(story.title)}</li>`).join("")}</ol>
      <a class="button" href="${escapeHtml(url)}/stories">Review and create the stories</a>
    </div>`;
}

function verdictPill(verdict: StoryReview["verdict"]): string {
  return verdict === "change" ? `<span class="pill warn">To change</span>` : `<span class="pill ok">Still fits</span>`;
}

// The status, changed in place; it also follows Claude's work by itself.
// The card's priority, changed in place; its stories take it.
function priorityForm(viewer: Viewer, url: string, current: string | null, priorities: string[]): string {
  return `<form method="post" action="${escapeHtml(url)}" class="card-status-form">${csrfField(viewer)}
      <input type="hidden" name="action" value="priority" />
      <label class="visually-hidden" for="card-priority">Priority</label>
      <select id="card-priority" name="priority" class="pill" data-autosubmit title="The priority of the card; its stories take it, one level lower when nice to have.">
        ${[...priorities, ""].map((value) => `<option value="${escapeHtml(value)}"${(current ?? "") === value ? " selected" : ""}>${value ? escapeHtml(value) : "No priority"}</option>`).join("")}
      </select>
      <noscript><button type="submit" class="button quiet">Set</button></noscript>
    </form>`;
}

function statusForm(viewer: Viewer, url: string, card: Pick<Card, "status" | "progress">, progress: Progress | null | undefined): string {
  const current = card.status;
  const shown = shownStatus(card);
  // Validated with stories: the status follows them; the other choices
  // stay (To validate when the feature changes, Dropped).
  const following = isProgressStage(shown) && progress;
  const options = following
    ? [
        `<option value="validated" selected>${escapeHtml(`${PROGRESS_LABELS[progress.stage]}${progressDetail(progress) ? ` ${progressDetail(progress)}` : ""}`)}</option>`,
        ...CARD_STATUSES.filter((status) => status !== "validated").map((status) => `<option value="${status}">${STATUS_LABELS[status]}</option>`),
      ]
    : CARD_STATUSES.map((status) => `<option value="${status}"${status === current ? " selected" : ""}>${STATUS_LABELS[status]}</option>`);
  const title = following
    ? "Validated, the status follows the card's stories: Stories to prepare, Ready for dev, In sprint, In development, To test, In production. Choose To validate when the feature changes, Dropped to give it up."
    : "Moves by itself as the card's work goes: Shaping when Claude is asked, To validate when the need is clear, Validated when its story is made; then it follows the stories.";
  return `<form method="post" action="${escapeHtml(url)}" class="card-status-form">${csrfField(viewer)}
      <input type="hidden" name="action" value="status" />
      <label class="visually-hidden" for="card-status">Status</label>
      <select id="card-status" name="status" class="pill card-${shown}" data-autosubmit title="${escapeHtml(title)}">
        ${options.join("")}
      </select>
      <noscript><button type="submit" class="button quiet">Set</button></noscript>
    </form>`;
}

function validationHtml(viewer: Viewer, url: string, data: CardPageData): string {
  const v = data.validation;
  if (!v || data.shown || data.card.kind !== "feature") return "";
  const who = (login: string) => (login === viewer.login ? "me" : `@${escapeHtml(login)}`);
  const button = data.canValidate && data.canWrite
    ? `<form method="post" action="${escapeHtml(url)}" class="inline">${csrfField(viewer)}<input type="hidden" name="action" value="validate_feature" /><button type="submit" class="button">Validate the feature</button></form>`
    : "";
  const body =
    v.state === "valid"
      ? `<p><span class="pill ok">Validated</span> by <span class="mono">${who(v.by)}</span> on <span class="mono">${formatDate(v.at)}</span>.</p>`
      : v.state === "outdated"
        ? `<p><span class="pill alert">To validate again</span> Validated by <span class="mono">${who(v.by)}</span> on <span class="mono">${formatDate(v.at)}</span>, but ${escapeHtml(v.why.join(" and "))}. ${button}</p>`
        : `<p><span class="pill">Not validated</span> ${data.canValidate ? `Its stories are ready. ${button}` : `<span class="muted">It can be validated once its spec is complete and all its stories are ready.</span>`}</p>`;
  return `<section class="card-validation" id="validation"><h2>Validation</h2>${body}</section>`;
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
          ${
            card.kind === "epic"
              ? data.epicState
                ? epicActions(viewer, url, card, data.epicState, null)
                : ""
              : `<form method="post" action="${escapeHtml(url)}" class="inline">${csrfField(viewer)}
            <input type="hidden" name="action" value="${card.archivedAt ? "restore" : "archive"}" />
            <button type="submit" class="button quiet">${card.archivedAt ? "Restore" : "Archive"}</button>
          </form>`
          }
        </div>`
      : "";
  const issues = data.links.filter((link) => link.kind === "issue");
  const people = data.links.filter((link) => link.kind === "person");
  const terms = data.links.filter((link) => link.kind === "term");
  const stories = data.links.filter((link) => link.kind === "story");
  // An epic is a document: no spec, stories, tests or Claude.
  const isEpic = card.kind === "epic";
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

  // Claude: write the spec, answer its questions, ask for a change, all in
  // the page; nothing while it works. The story once the required sections
  // are there.
  let work = "";
  const working = isActive(data.job);
  const canAnswer = data.canWrite && !shown && data.claude.usable && !working;
  if (data.canWrite && !shown && !working) {
    // What can come next, in one row; Claude's buttons carry a star. A
    // panel unfolds under the row, one at a time.
    const panel = (action: JobKind, summary: string, primary: boolean, open: boolean, inner: string): string =>
      `<details class="claude-panel" name="spec-work" data-autofocus${open ? " open" : ""}>
          <summary class="button${primary ? "" : " quiet"} claude">${summary}</summary>
          <form method="post" action="${escapeHtml(url)}#claude-job" data-busy="Sending…">${csrfField(viewer)}
            <p class="claude-panel-title">${summary}</p>
            ${inner}
            <div class="card-actions">
              <button type="submit" class="button claude" name="action" value="${action}">Ask Claude</button>
              <button type="button" class="button quiet" data-panel-close>Cancel</button>
            </div>
          </form>
        </details>`;
    const usable = data.claude.usable;
    const draft =
      usable && !spec
        ? panel(
            "spec_draft",
            isEpic ? "Write the document with Claude" : "Write the spec with Claude",
            true,
            data.ask === "draft",
            `<p class="help">${
              isEpic
                ? "Claude reads the epic, its features (titles, synopses, statuses) and the project's principles (its CLAUDE.md), asks at most five questions, then writes the document by the epic's sections."
                : "Claude reads the card, the project's principles (its CLAUDE.md), its other cards and open stories, then writes a first spec and asks what it needs to know."
            } It works in the background: you can leave the page.</p>
            <div class="field">
              <label for="draft">Anything to tell Claude first? <span class="muted">(optional)</span></label>
              <textarea id="draft" name="instruction" rows="3" maxlength="4000">${escapeHtml(data.ask === "draft" ? (data.instruction ?? "") : "")}</textarea>
            </div>`,
          )
        : "";
    // Once the card has stories, Claude reviews them against the spec.
    const made = stories.length;
    const split =
      usable && spec && !data.split && !isEpic
        ? panel(
            "spec_split",
            made ? "Review the stories with Claude" : "Split into stories with Claude",
            true,
            false,
            made
              ? `<p class="help">Claude checks the card's ${made} stor${made === 1 ? "y" : "ies"} against the spec: those that still fit, those to change (a comment on their issue), and the new stories missing. You review it all before anything goes to GitHub.</p>
            <div class="field">
              <label for="split">Anything about the review? <span class="muted">(optional)</span></label>
              <textarea id="split" name="instruction" rows="2" maxlength="4000" placeholder="The offline case moved to a story of its own."></textarea>
            </div>`
              : `<p class="help">Claude proposes stories that can each be built, tested on int and shipped alone, each with its own criteria. You review and edit them before anything goes to GitHub.</p>
            <div class="field">
              <label for="split">Anything about the split? <span class="muted">(optional)</span></label>
              <textarea id="split" name="instruction" rows="2" maxlength="4000" placeholder="At most three stories; the offline case on its own."></textarea>
            </div>`,
          )
        : "";
    const tests =
      usable && spec && (made || data.split) && !isEpic
        ? panel(
            "spec_tests",
            data.card.data.tests ? "Rewrite the test cases with Claude" : "Write test cases with Claude",
            false,
            false,
            `<p class="help">Claude writes Gherkin scenarios for each story of the feature, from its criteria and the spec. They are kept here, not on GitHub; you can edit them, and they go in the preparation document. It counts as one Claude call.</p>
            <div class="field">
              <label for="tests">Anything about the test cases? <span class="muted">(optional)</span></label>
              <textarea id="tests" name="instruction" rows="2" maxlength="4000"></textarea>
            </div>`,
          )
        : "";
    const change =
      usable && spec
        ? panel(
            "spec_revise",
            isEpic ? "Revise the document with Claude" : "Ask Claude for a change",
            false,
            data.ask === "change",
            `<div class="field">
              <label for="change">What should change?</label>
              <p class="help" id="change_help">Say what is wrong, what is missing, what to cut. Claude keeps the rest of the ${isEpic ? "document" : "spec"}.</p>
              <textarea id="change" name="instruction" rows="4" maxlength="4000" required aria-describedby="change_help">${escapeHtml(data.ask === "change" ? (data.instruction ?? "") : "")}</textarea>
            </div>`,
          )
        : "";
    const proposed = data.card.data.featuresProposal;
    const features =
      usable && isEpic && (spec || card.body.trim())
        ? panel(
            "epic_features",
            "Propose features with Claude",
            !proposed,
            false,
            `<p class="help">Claude reads the epic's document and its features, and proposes the ones still missing, each with a synopsis, a need, a priority and its dependencies. You review and edit them before any card is created; they come as drafts attached to the epic, in no release. It counts as one Claude call.</p>
            <div class="field">
              <label for="epic_features">Anything about the features? <span class="muted">(optional)</span></label>
              <textarea id="epic_features" name="instruction" rows="2" maxlength="4000"></textarea>
            </div>`,
          )
        : "";
    const proposedLink = proposed && isEpic
      ? `<p class="notice" role="status">Claude proposed ${proposed.features.length} feature${proposed.features.length === 1 ? "" : "s"}. <a class="button" href="${escapeHtml(url)}/features">Review the proposed features</a></p>`
      : "";
    const review =
      usable && isEpic && (spec || card.body.trim()) && (data.epicFeatures ?? []).length
        ? panel(
            "epic_review",
            "Review with Claude",
            false,
            false,
            `<p class="help">Claude reads the epic's document and its features, and reports what no feature covers, features that overlap, a feature that goes against a decision, and missing dependencies. Nothing is changed: you apply each finding yourself. It counts as one Claude call.</p>
            <div class="field">
              <label for="epic_review">Anything to look at? <span class="muted">(optional)</span></label>
              <textarea id="epic_review" name="instruction" rows="2" maxlength="4000"></textarea>
            </div>`,
          )
        : "";
    const story = spec && !isEpic && !made && !data.missing.length ? `<a class="button quiet" href="${escapeHtml(url)}/story">Make one story on GitHub</a>` : "";
    work = `${data.split ? proposalHtml(url, data.split, spec) : ""}${proposedLink}
      <div class="spec-actions">
        ${draft}${split}${tests}${features}${review}${story}${change}
        <a class="spec-by-hand" href="${escapeHtml(url)}/spec">${isEpic ? (spec ? "Edit the document by hand" : "Write the document by hand") : spec ? "Edit the spec by hand" : "Write the spec by hand"}</a>
      </div>
      ${
        split
          ? `<p class="help">${
              made
                ? "The feature changed since its stories were made? Claude checks them against the spec."
                : "A small feature makes one story; a bigger one, several that ship one by one: Claude proposes them, you review them before GitHub."
            }</p>`
          : ""
      }
      ${spec && !isEpic && !made && data.missing.length ? `<p class="muted">To make one story, fill in: ${data.missing.map(escapeHtml).join(", ")}.</p>` : ""}
      ${usable ? "" : `<p class="muted">${escapeHtml(data.claude.reason ?? "Claude is not available.")}</p>`}`;
  }

  return layout(
    title(project, `${cardRef(card.id)} ${card.title}`),
    `${projectHeader(project, "board")}
      ${data.created ? `<p class="notice ok" role="status" data-draft-clear="${escapeHtml(cardDraftKey(project.repo))}">Card ${cardRef(card.id)} written.${data.attachedOnCreate === undefined ? "" : ` ${data.attachedOnCreate} feature${data.attachedOnCreate === 1 ? "" : "s"} attached from its GitHub epic.`}</p>` : ""}
      ${notice(data.notice, "ok")}
      ${notice(data.failure, "error")}
      <p class="crumbs"><a href="${escapeHtml(base)}/board#card-${card.id}">Board</a> <span aria-hidden="true">›</span> <span class="mono">${cardRef(card.id)}</span></p>
      ${banner}
      <h1>${escapeHtml(heading)}</h1>
      <div class="fiche-tags">${cardPills(
        tags,
        shown
          ? undefined
          : isEpic && data.epicState
            ? epicStatusPill(data.epicState)
            : data.canWrite && !card.archivedAt
            ? statusForm(viewer, url, card, data.progress)
            : statusPill(card, data.progress, data.progressHistory?.at(-1)?.at ?? null),
      )}${
        data.priorities.length
          ? data.canWrite && !shown && !card.archivedAt
            ? ` ${priorityForm(viewer, url, card.priority, data.priorities)}`
            : card.priority
              ? ` <span class="pill">${escapeHtml(card.priority)}</span>`
              : ""
          : ""
      }${
        card.archivedAt ? ` <span class="pill alert">Archived</span>` : ""
      }</div>
      <article class="markdown card-text">
${body.trim() ? renderCardText(body, project.repo, undefined, data.mentioned, data.embedded) : `<p class="muted">${isEpic ? "No document yet." : "No text yet."}</p>`}
      </article>
      ${data.epic && !shown ? epicProgressSection(data.epic) : ""}
      ${data.epicDeps && !shown ? epicDependenciesSection(data.epicDeps, (title) => { const found = (data.epics ?? []).find((e) => e.title.trim().toLowerCase() === title.trim().toLowerCase()); return found ? cardUrl(project.repo, found.id) : null; }) : ""}
      ${actions}
      ${shown ? "" : epicSection(viewer, url, card, data)}
      ${shown ? "" : epicIssueSection(data, isEpic)}
      ${isEpic && !shown ? reviewHtml(viewer, project, card, data.canWrite, new Map((data.epicFeatures ?? []).map((f) => [f.id, f.title]))) + notesHtml(card, new Map((data.epicFeatures ?? []).map((f) => [f.id, f.title])), project.repo) : ""}
      ${isEpic && !shown ? epicHistoryHtml(data.epicHistory ?? []) : ""}
      <section class="card-spec" id="spec">
        <h2>${isEpic ? "Document" : "Spec"}</h2>
        ${shown ? "" : jobHtml(viewer, url, data.job, data.events, data.canWrite && data.claude.usable)}
        ${specHtml(spec, data.rubriques, project.repo, data.mentioned, data.embedded)}
        ${questionsHtml(viewer, url, spec, canAnswer)}
        ${dialogueHtml(spec)}
        ${work}
      </section>
      ${
        stories.length && !isEpic
          ? `<h2 id="stories">Stories</h2>${progressSummary(data.progress, data.progressHistory ?? [])}<ul class="card-stories">${stories
              .map((link) => {
                const state = data.storyStates.get(Number(link.ref));
                return `<li><a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${escapeHtml(link.ref)}">#${escapeHtml(link.ref)}</a>
                  ${state ? `${escapeHtml(state.title)} ${storyStatus(state)}` : `<span class="muted">not read yet</span>`}</li>`;
              })
              .join("")}</ul>`
          : ""
      }
      ${isEpic ? "" : testsHtml(viewer, url, data.card.data.tests, data.canWrite && !shown && !card.archivedAt)}
      ${isEpic ? "" : validationHtml(viewer, url, data)}
      ${dependenciesHtml(viewer, url, project, data)}
      ${
        data.named?.length && !shown && !isEpic
          ? `<section class="card-named" id="named"><h2>Stories that name ${cardRef(card.id)}</h2>
              <p class="muted small">They name this card in their title or text, but are not among its stories.</p>
              <ul class="card-stories">${data.named
                .map(
                  (story) =>
                    `<li><a class="mono" href="${escapeHtml(story.url)}">#${story.number}</a> ${escapeHtml(story.title)} ${
                      data.canWrite ? linkNamedForm(viewer, project.repo, card.id, story.number, `${url}#stories`) : ""
                    }</li>`,
                )
                .join("")}</ul></section>`
          : ""
      }
      ${linkRows.length ? `<h2>Mentioned</h2><dl class="facts">${linkRows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>` : ""}
      <h2>${isEpic ? "Claude on this epic" : "Claude on this card"}</h2>
      <p>${data.spend.calls ? spendLine(data.spend) : `<span class="muted">No call yet.</span>`}${isEpic ? " <span class=\"muted\">(this epic's own calls)</span>" : ""}</p>
      ${isEpic && data.epicSpend ? `<p>${data.epicSpend.calls ? `${spendLine(data.epicSpend)} <span class="muted">(with its features' calls)</span>` : `<span class="muted">No call on its features.</span>`}</p>` : ""}
      ${callsTable(data.calls)}
      <h2>History</h2>
      <p class="muted small">Written by <span class="mono">@${escapeHtml(card.author)}</span> on <span class="mono">${formatDate(card.createdAt)}</span>. Every version is kept.</p>
      <ul class="card-history">${history}</ul>`,
    viewer,
    data.created ? [DRAFT_SCRIPT] : [],
    projectContext(project, false),
  );
}

// ---- Writing a card ------------------------------------------------------

export interface CardFormData {
  card: Card | null;
  input: CardInput;
  known: Record<FreeDimension, string[]>;
  error?: string | undefined;
  conflict?: Card | undefined;
  // Epic issues that can be picked when creating an epic card.
  issues?: { number: number; title: string }[] | undefined;
}

export function cardFormPage(viewer: Viewer, project: Project, data: CardFormData): string {
  const base = projectUrl(project.repo);
  const { card, input, known } = data;
  const action = card ? cardUrl(project.repo, card.id) : `${base}/cards`;
  const isEpic = (card ? card.kind : input.tags.kind) === "epic";
  const sections = epicSections(project);
  const epicFields = (body: string): string => {
    const parsed = parseEpicBody(body, sections);
    return `${sections
      .map(
        (section) => `<div class="field">
          <label for="s_${escapeHtml(section.cle)}">${escapeHtml(section.titre)}</label>
          ${section.aide ? `<p class="help" id="s_${escapeHtml(section.cle)}_help">${escapeHtml(section.aide)}</p>` : ""}
          <textarea id="s_${escapeHtml(section.cle)}" name="${escapeHtml(epicFieldName(section))}" rows="5" maxlength="${MAX_BODY}">${escapeHtml(parsed.texts[section.cle] ?? "")}</textarea>
        </div>`,
      )
      .join("")}${
      parsed.rest
        ? `<div class="field"><label for="s_rest">Other text</label><textarea id="s_rest" name="${EPIC_REST_FIELD}" rows="4" maxlength="${MAX_BODY}">${escapeHtml(parsed.rest)}</textarea></div>`
        : ""
    }`;
  };
  // Creating: the type is chosen first, as it decides the fields.
  const typeChoice = card
    ? ""
    : `<form method="get" action="${escapeHtml(base)}/cards/new" class="request-form card-form" aria-label="Type of the new card">
        <div class="field">
          <label for="f_type_choice">Type</label>
          <select id="f_type_choice" name="kind" data-autosubmit>${CARD_KINDS.map((kind) => option(kind, KIND_LABELS[kind], input.tags.kind === kind)).join("")}</select>
          <noscript><button type="submit" class="button quiet">Choose</button></noscript>
        </div>
      </form>`;
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
      ${typeChoice}
      <form method="post" action="${escapeHtml(action)}" class="request-form card-form"${card ? "" : ` data-draft-key="${escapeHtml(cardDraftKey(project.repo))}"`}>
        ${csrfField(viewer)}
        <input type="hidden" name="action" value="save" />
        ${card ? `<input type="hidden" name="rev" value="${data.conflict?.rev ?? card.rev}" />` : ""}
        <div class="field">
          <label for="f_title">Title <span class="muted">(required)</span></label>
          <input id="f_title" name="title" required maxlength="${MAX_TITLE}" value="${escapeHtml(input.title)}" />
        </div>
        ${
          !card && isEpic && (data.issues ?? []).length
            ? `<div class="field">
          <label for="f_issue">Start from an existing GitHub epic <span class="muted">(optional)</span></label>
          <p class="help" id="f_issue_help">The card links to the issue, whose text is not copied; the features of its stories are attached to this epic.</p>
          <select id="f_issue" name="issue" aria-describedby="f_issue_help"><option value="">None</option>${(data.issues ?? []).map((i) => `<option value="${i.number}">#${i.number} ${escapeHtml(i.title)}</option>`).join("")}</select>
        </div>`
            : ""
        }
        ${
          isEpic
            ? epicFields(input.body)
            : `<div class="field">
          <label for="f_body">Text</label>
          <p class="help" id="f_body_help">A few lines: what it is, for whom, why. Markdown.
            <code>{segment: pro}</code> sets a tag (epic, domain, segment, release; it wins over the fields below),
            <code>#12</code> points to an issue, <code>@login</code> to a person, <code>[[Basket]]</code> to a term.</p>
          <textarea id="f_body" name="body" rows="12" maxlength="${MAX_BODY}" aria-describedby="f_body_help">${escapeHtml(input.body)}</textarea>
        </div>`
        }
        <div class="card-form-tags">
          <div class="field">
            <label for="f_kind">Type</label>
            ${
              card
                ? `<input type="hidden" name="kind" value="${card.kind}" /><p id="f_kind">${KIND_LABELS[card.kind]} <span class="muted small">(fixed at creation)</span></p>`
                : `<input type="hidden" name="kind" value="${input.tags.kind}" /><p id="f_kind">${KIND_LABELS[input.tags.kind]}</p>`
            }
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
    projectContext(project, false),
  );
}

// ---- The spec by hand, and the story ----------------------------------------

// Cards written elsewhere, brought in: a file in the export's format, or
// pasted.
export function importPage(viewer: Viewer, project: Project, data: { error?: string | undefined; text?: string }): string {
  const base = projectUrl(project.repo);
  return layout(
    title(project, "Import cards"),
    `${projectHeader(project, "board", "Import cards")}
      <p class="crumbs"><a href="${escapeHtml(base)}/board">Board</a> <span aria-hidden="true">›</span> Import cards</p>
      ${notice(data.error, "error")}
      <p>Cards in the format of <a href="${escapeHtml(base)}/cards/export">the export</a>: a list of cards, each with its <code>title</code> and, if it has them, its <code>body</code>, <code>kind</code>, <code>status</code>, <code>epic</code>, <code>domain</code>, <code>segment</code>, <code>release</code>, its spec (<code>data.spec</code>) and its stories (<code>links</code>, <code>{"kind": "story", "ref": "138"}</code>).</p>
      <p class="muted">Each becomes a new card, under your name. A card whose title is already on the board is skipped: importing twice creates nothing the second time. Up to ${MAX_IMPORT} cards at once.</p>
      <form method="post" action="${escapeHtml(base)}/cards/import" enctype="multipart/form-data" class="request-form" data-busy="Importing…">${csrfField(viewer)}
        <div class="field">
          <label for="file">A JSON file</label>
          <input id="file" name="file" type="file" accept="application/json,.json" />
        </div>
        <div class="field">
          <label for="text">Or the JSON, pasted</label>
          <textarea id="text" name="text" rows="10" spellcheck="false" class="mono">${escapeHtml(data.text ?? "")}</textarea>
        </div>
        <div class="card-actions">
          <button type="submit" class="button">Import</button>
          <a href="${escapeHtml(base)}/board">Cancel</a>
        </div>
      </form>`,
    viewer,
    [],
    projectContext(project, false),
  );
}

// The review before the conversion: each value, its features, what happens.
export function epicConversionPage(viewer: Viewer, project: Project, pending: PendingEpic[]): string {
  const base = projectUrl(project.repo);
  const rows = pending
    .map((item, index) => {
      const features = `<ul class="card-stories">${item.features.map((f) => `<li><a href="${escapeHtml(cardUrl(project.repo, f.id))}"><span class="mono">${cardRef(f.id)}</span> ${escapeHtml(f.title)}</a></li>`).join("")}</ul>`;
      const what = item.existing
        ? `<fieldset><legend>${escapeHtml(item.value)} matches the epic <a href="${escapeHtml(cardUrl(project.repo, item.existing.id))}"><span class="mono">${cardRef(item.existing.id)}</span> ${escapeHtml(item.existing.title)}</a></legend>
            <label><input type="radio" name="choice_${index}" value="attach" checked /> Attach the features to ${cardRef(item.existing.id)}</label>
            <label><input type="radio" name="choice_${index}" value="create" /> Create a new draft epic “${escapeHtml(item.value)}”</label></fieldset>`
        : `<p>A new draft epic “${escapeHtml(item.value)}” is created, with these features attached.</p>`;
      return `<section><h2>${escapeHtml(item.value)}</h2>${features}${what}</section>`;
    })
    .join("");
  return layout(
    title(project, "Epic values"),
    `${projectHeader(project, "board", "Epic values")}
      <p class="crumbs"><a href="${escapeHtml(base)}/board">Board</a> <span aria-hidden="true">›</span> Epic values</p>
      ${
        pending.length
          ? `<p>Nothing changes until you confirm. The features keep their Epic value, so lanes and filters group the same features.</p>
      <form method="post" action="${escapeHtml(base)}/cards/epics" data-busy>${csrfField(viewer)}
        ${rows}
        <div class="card-actions"><button type="submit" class="button">Confirm</button><a href="${escapeHtml(base)}/board">Cancel</a></div>
      </form>`
          : `<p class="muted">No Epic value to convert.</p>`
      }`,
    viewer,
    [],
    projectContext(project, false),
  );
}

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
    projectContext(project, false),
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
    projectContext(project, false),
  );
}

// Claude's split, to review and edit before the stories go to GitHub.
export function splitPage(
  viewer: Viewer,
  project: Project,
  data: {
    card: Card;
    split: CardSplit;
    rubriques: Rubrique[];
    label: string | null;
    kept: Set<number>;
    bodies: string[];
    // After a review: the stories to comment on, and each comment as sent.
    commented: Set<number>;
    comments: Map<number, string>;
    outdated: boolean;
    errors: Record<number, string>;
    // A blank criterion to fill in, for this story.
    blank?: number | undefined;
    error?: string | undefined;
    priorityOf?: ((nice: boolean) => string | null) | undefined;
  },
): string {
  const { card, split } = data;
  const url = cardUrl(project.repo, card.id);
  const stories = storyBlocks({ repo: project.repo, split, rubriques: data.rubriques, kept: data.kept, bodies: data.bodies, errors: data.errors, blank: data.blank, priorityOf: data.priorityOf });
  const review = split.review;
  const reviewed = (review ?? [])
    .map((story) =>
      story.verdict === "change"
        ? `<fieldset class="split-story">
          <legend class="visually-hidden">#${story.number}</legend>
          <p><a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${story.number}">#${story.number}</a> ${escapeHtml(story.title)} ${verdictPill(story.verdict)}</p>
          <label class="check split-keep"><input type="checkbox" name="comment_${story.number}" value="1"${data.commented.has(story.number) ? " checked" : ""} /> Comment on #${story.number}</label>
          <div class="field">
            <label for="comment_text_${story.number}">What to change</label>
            <textarea id="comment_text_${story.number}" name="comment_text_${story.number}" rows="4" maxlength="4000">${escapeHtml(story.comment)}</textarea>
          </div>
          <details>
            <summary>What GitHub will receive</summary>
            <article class="markdown story-preview">${renderCardText(data.comments.get(story.number) ?? "", project.repo)}</article>
          </details>
        </fieldset>`
        : `<p class="split-fits"><a class="mono" href="https://github.com/${escapeHtml(project.repo)}/issues/${story.number}">#${story.number}</a> ${escapeHtml(story.title)} ${verdictPill(story.verdict)}</p>`,
    )
    .join("");
  const where = `in <code>${escapeHtml(project.repo)}</code>, under your GitHub name${data.label ? `, labelled <code>${escapeHtml(data.label)}</code>` : ""}, with a link to this card and the version of its spec`;
  const intro = review
    ? `<p>Claude reviewed the card's ${review.length} stor${review.length === 1 ? "y" : "ies"} against the spec${split.note ? `: ${escapeHtml(split.note)}` : "."} Check what to send: a comment on each story to change, and the new stories. Each new story becomes an issue ${where}.</p>`
    : `<p>Claude proposes ${split.stories.length} stor${split.stories.length === 1 ? "y" : "ies"}${split.note ? `: ${escapeHtml(split.note)}` : "."} Review them, edit what you want, uncheck those you do not want. Each one becomes an issue ${where}.</p>`;
  const nothing = review && !split.stories.length && !review.some((story) => story.verdict === "change");
  const submit = review ? (nothing ? "Confirm: the stories still fit" : "Send the checked to GitHub") : "Create the checked stories on GitHub";
  return layout(
    title(project, `Stories from ${cardRef(card.id)}`),
    `${projectHeader(project, "board", `Stories from ${cardRef(card.id)}`)}
      <p class="crumbs"><a href="${escapeHtml(projectUrl(project.repo))}/board">Board</a> <span aria-hidden="true">›</span> <a class="mono" href="${escapeHtml(url)}">${cardRef(card.id)}</a> ${escapeHtml(card.title)}</p>
      ${notice(data.error, "error")}
      ${data.outdated ? `<p class="notice error">The spec changed since Claude proposed this.</p>` : ""}
      ${intro}
      <form method="post" action="${escapeHtml(url)}/stories" class="request-form split-form" data-busy="Sending…">${csrfField(viewer)}${EDITOR_DEFAULT_BUTTON}
        ${review ? `<h2>The stories already made</h2>${reviewed}${split.stories.length ? `<h2>New stories</h2>` : ""}` : ""}
        ${stories}
        <div class="card-actions">
          <button type="submit" class="button" name="action" value="create"${!review && !data.kept.size ? " disabled" : ""}>${submit}</button>
          <button type="submit" class="button quiet" name="action" value="save">Save my edits</button>
          <button type="submit" class="button quiet" name="action" value="discard" formnovalidate>Discard the proposal</button>
        </div>
      </form>`,
    viewer,
    [],
    projectContext(project, false),
  );
}
