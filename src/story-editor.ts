// The editor of the stories Claude proposes (la-fabrique#228): one block per
// story, its title, each section of the project in a multi-line field that
// grows with its text, the acceptance criteria one per line (add, remove,
// move), nice to have, keep or leave out, and what GitHub will receive.
// Used on the card's stories page and in the feature's card on Refinement.
import { renderCardText } from "./card-views";
import type { CardSplit } from "./cards";
import type { Rubrique } from "./requests";
import { escapeHtml } from "./views";

// The section that holds the acceptance criteria: by its key, else its title.
export function criteriaRubrique(rubriques: Rubrique[]): Rubrique | undefined {
  return rubriques.find((rubrique) => /^(criteria|criteres|criterias)$/i.test(rubrique.cle)) ?? rubriques.find((rubrique) => /criteri|critère/i.test(rubrique.titre));
}

// A section's text as criteria: one per line, task-list marks removed.
export function criteriaOf(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s*)?(?:\[[ xX]\]\s*)?/, "").trim())
    .filter(Boolean);
}

export function criteriaText(criteria: string[]): string {
  return criteria
    .map((criterion) => criterion.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((criterion) => `- [ ] ${criterion}`)
    .join("\n");
}

// A move asked by a button: `crit_up:2:1`, `crit_down:2:1`, `crit_del:2:1`,
// `crit_add:2`. Returns the new list for the story, or null if not a move.
export function moveCriterion(action: string, lists: string[][]): { index: number; list: string[]; blank?: boolean } | null {
  const [verb, i, n] = action.split(":");
  const index = Number(i);
  const list = lists[index];
  if (!verb?.startsWith("crit_") || !list) return null;
  const at = Number(n);
  const copy = [...list];
  if (verb === "crit_add") return { index, list: copy, blank: true };
  if (!Number.isInteger(at) || at < 0 || at >= copy.length) return { index, list: copy };
  if (verb === "crit_del") copy.splice(at, 1);
  else if (verb === "crit_up" && at > 0) [copy[at - 1], copy[at]] = [copy[at] as string, copy[at - 1] as string];
  else if (verb === "crit_down" && at < copy.length - 1) [copy[at + 1], copy[at]] = [copy[at] as string, copy[at + 1] as string];
  return { index, list: copy };
}

export interface StoryEditorData {
  repo: string;
  split: CardSplit;
  rubriques: Rubrique[];
  kept: Set<number>;
  // What GitHub will receive for each story, as it will read.
  bodies: string[];
  errors: Record<number, string>;
  // A blank criterion to fill in, for this story.
  blank?: number | undefined;
  // The priority the story will get on GitHub, from its card's (one level
  // lower when nice to have); null when the card has none.
  priorityOf?: ((nice: boolean) => string | null) | undefined;
  // Unique ids when several editors share a page.
  prefix?: string;
}

const button = (name: string, label: string, aria: string, disabled = false, className = "", attribute = "") =>
  `<button type="submit" class="button quiet small${className ? ` ${className}` : ""}" name="action" value="${escapeHtml(name)}" data-plain aria-label="${escapeHtml(aria)}" formnovalidate${disabled ? " disabled" : ""}${attribute ? ` ${attribute}` : ""}>${label}</button>`;

// The marks that go with the issue and not in its text: nice to have, and
// the priority label.
export function priorityLine(nice: boolean, priorityOf?: (nice: boolean) => string | null): string {
  const priority = priorityOf?.(nice) ?? null;
  const parts = [nice ? "Nice to have" : "Needed by the feature", priority ? `priority: ${escapeHtml(priority)}` : "no priority (the card has none)"];
  return parts.join(" · ");
}

// The section shown with the title while a story is folded: its context.
export function contextRubrique(rubriques: Rubrique[]): Rubrique | undefined {
  const criteria = criteriaRubrique(rubriques)?.cle;
  return rubriques.find((rubrique) => /context/i.test(rubrique.cle) || /context/i.test(rubrique.titre)) ?? rubriques.find((rubrique) => rubrique.cle !== criteria);
}

// One criterion: a handle to drag it, its text, a cross to remove it; the
// arrows are for pages without the script.
function criterionRow(index: number, id: string, at: number, total: number, criterion: string): string {
  return `<li class="criterion" data-crit>
      <button type="button" class="crit-grip" data-crit-grip aria-label="Move criterion ${at + 1}: drag it, or use the up and down arrow keys" title="Drag to reorder">⠿</button>
      <textarea id="c_${id}_${at}" name="c_${index}" rows="1" class="soft-field" data-grow aria-label="Criterion ${at + 1} of story ${index + 1}">${escapeHtml(criterion)}</textarea>
      <span class="criterion-tools">${button(`crit_up:${index}:${at}`, "↑", `Move criterion ${at + 1} up`, at === 0, "crit-move")}${button(`crit_down:${index}:${at}`, "↓", `Move criterion ${at + 1} down`, at === total - 1, "crit-move")}${button(`crit_del:${index}:${at}`, "×", `Remove criterion ${at + 1}`, false, "crit-del", "data-crit-del")}</span>
    </li>`;
}

// Each story folded to its title and context, unfolded to edit it; the box
// beside it keeps it or leaves it out.
export function storyBlocks(data: StoryEditorData): string {
  const prefix = data.prefix ?? "";
  const criteriaKey = criteriaRubrique(data.rubriques)?.cle;
  const contextKey = contextRubrique(data.rubriques)?.cle;
  return data.split.stories
    .map((story, index) => {
      const id = `${prefix}${index}`;
      const kept = data.kept.has(index);
      const fields = data.rubriques
        .map((rubrique) => {
          const label = `${escapeHtml(rubrique.titre)}${rubrique.obligatoire ? ` <span class="muted small">(required)</span>` : ""}`;
          if (rubrique.cle === criteriaKey) {
            const list = criteriaOf(story.answers[rubrique.cle] ?? "");
            if (data.blank === index) list.push("");
            return `<div class="field criteria">
              <span class="label">${label} <span class="muted small">(one per line)</span></span>
              <input type="hidden" name="rows_${index}" value="1" />
              <ol class="criteria-list" data-criteria data-story="${index}" data-id="${escapeHtml(id)}">${list.map((criterion, at) => criterionRow(index, id, at, list.length, criterion)).join("")}</ol>
              ${button(`crit_add:${index}`, "+ Add a criterion", `Add a criterion to story ${index + 1}`, false, "crit-add", "data-crit-add")}
            </div>`;
          }
          return `<div class="field">
              <label for="s_${id}_${rubrique.cle}">${label}</label>
              <textarea id="s_${id}_${rubrique.cle}" name="s_${index}_${rubrique.cle}" rows="2" class="soft-field" data-grow>${escapeHtml(story.answers[rubrique.cle] ?? "")}</textarea>
            </div>`;
        })
        .join("");
      const context = contextKey ? (story.answers[contextKey] ?? "").trim() : "";
      const error = data.errors[index];
      return `<section class="split-story${error ? " invalid" : ""}${kept ? "" : " left-out"}" data-split-story aria-label="Story ${index + 1}">
          <label class="split-keep-box" title="Create this story"><input type="checkbox" name="keep_${index}" value="1"${kept ? " checked" : ""} data-split-keep aria-label="Create story ${index + 1}" /></label>
          <details class="split-body"${error ? " open" : ""} data-split-body>
            <summary>
              <span class="split-summary-head"><span class="mono muted small">${index + 1}</span> <strong class="split-title" data-split-title-text>${escapeHtml(story.title) || "Untitled"}</strong>
                <span class="pill small split-nice"${story.nice ? "" : " hidden"} data-split-nice-pill>Nice to have</span>
                <span class="pill small split-out">Left out</span>
                <span class="split-unfold small" aria-hidden="true"><span class="when-closed">Edit</span><span class="when-open">Fold</span></span></span>
              ${context ? `<span class="split-context">${escapeHtml(context)}</span>` : ""}
            </summary>
            ${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}
            <div class="split-fields">
              <label class="check split-nice-box"><input type="checkbox" name="nice_${index}" value="1"${story.nice ? " checked" : ""} data-split-nice /> Nice to have <span class="muted small">(its priority one level below the card's)</span></label>
              <div class="field">
                <label for="title_${id}">Title</label>
                <input id="title_${id}" name="title_${index}" maxlength="200" class="soft-field" value="${escapeHtml(story.title)}" data-split-title />
              </div>
              ${fields}
              <details class="split-preview">
                <summary>What GitHub will receive</summary>
                <p class="small story-marks">${priorityLine(story.nice === true, data.priorityOf)}</p>
                <article class="markdown story-preview">${renderCardText(data.bodies[index] ?? "", data.repo)}</article>
              </details>
            </div>
          </details>
        </section>`;
    })
    .join("");
}

// The editor's bar: what is proposed and how many are kept, with its
// buttons; it stays at the top while the stories scroll by, not after.
// `feature`: what the bar shows of the feature once it sticks (its title,
// status, priority), hidden while the bar sits below the card's own head.
export function splitBar(heading: string, buttons: string, total: number, kept: number, feature = ""): string {
  return `<div class="split-bar" data-split-bar>
      ${feature ? `<div class="split-bar-feature">${feature}</div>` : ""}
      <p class="split-bar-title">${heading} <span class="muted small" data-split-count data-total="${total}">${kept} of ${total} checked</span>
        <button type="button" class="button quiet small split-toggle-all" data-split-all hidden>Unfold all</button></p>
      <div class="split-bar-actions">${buttons}</div>
    </div>`;
}

// The actions of the form; the hidden first button is what Enter presses.
export const EDITOR_DEFAULT_BUTTON = `<button type="submit" class="visually-hidden" name="action" value="refresh" tabindex="-1" aria-hidden="true" data-plain></button>`;
