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
  // Unique ids when several editors share a page.
  prefix?: string;
}

const button = (name: string, label: string, aria: string, disabled = false) =>
  `<button type="submit" class="button quiet small" name="action" value="${escapeHtml(name)}" data-plain aria-label="${escapeHtml(aria)}" formnovalidate${disabled ? " disabled" : ""}>${label}</button>`;

export function storyBlocks(data: StoryEditorData): string {
  const prefix = data.prefix ?? "";
  const criteriaKey = criteriaRubrique(data.rubriques)?.cle;
  return data.split.stories
    .map((story, index) => {
      const id = `${prefix}${index}`;
      const kept = data.kept.has(index);
      const fields = data.rubriques
        .map((rubrique) => {
          const label = `${escapeHtml(rubrique.titre)}${rubrique.obligatoire ? ` <span class="muted">(required)</span>` : ""}`;
          if (rubrique.cle === criteriaKey) {
            const list = criteriaOf(story.answers[rubrique.cle] ?? "");
            if (data.blank === index) list.push("");
            const rows = list
              .map(
                (criterion, at) => `<li class="criterion">
                  <textarea id="c_${id}_${at}" name="c_${index}" rows="1" data-grow aria-label="Criterion ${at + 1} of story ${index + 1}">${escapeHtml(criterion)}</textarea>
                  <span class="criterion-tools">${button(`crit_up:${index}:${at}`, "↑", `Move criterion ${at + 1} up`, at === 0)}${button(`crit_down:${index}:${at}`, "↓", `Move criterion ${at + 1} down`, at === list.length - 1)}${button(`crit_del:${index}:${at}`, "Remove", `Remove criterion ${at + 1}`)}</span>
                </li>`,
              )
              .join("");
            return `<div class="field criteria">
              <span class="label">${label} <span class="muted small">(one per line)</span></span>
              <input type="hidden" name="rows_${index}" value="1" />
              <ol class="criteria-list">${rows}</ol>
              ${button(`crit_add:${index}`, "Add a criterion", `Add a criterion to story ${index + 1}`)}
            </div>`;
          }
          return `<div class="field">
              <label for="s_${id}_${rubrique.cle}">${label}</label>
              <textarea id="s_${id}_${rubrique.cle}" name="s_${index}_${rubrique.cle}" rows="2" data-grow>${escapeHtml(story.answers[rubrique.cle] ?? "")}</textarea>
            </div>`;
        })
        .join("");
      return `<fieldset class="split-story${data.errors[index] ? " invalid" : ""}${kept ? "" : " left-out"}">
          <legend class="visually-hidden">Story ${index + 1}</legend>
          <div class="split-flags">
            <label class="check split-keep"><input type="checkbox" name="keep_${index}" value="1"${kept ? " checked" : ""} data-autosubmit /> Create this story</label>
            <label class="check split-keep"><input type="checkbox" name="nice_${index}" value="1"${story.nice ? " checked" : ""} data-autosubmit /> Nice to have <span class="muted small">(its priority one level below the card's)</span></label>
          </div>
          ${data.errors[index] ? `<p class="notice error" role="alert">${escapeHtml(data.errors[index] ?? "")}</p>` : ""}
          <div class="field">
            <label for="title_${id}">Title</label>
            <input id="title_${id}" name="title_${index}" maxlength="200" value="${escapeHtml(story.title)}" />
          </div>
          ${fields}
          ${
            kept
              ? `<details open>
            <summary>What GitHub will receive</summary>
            <article class="markdown story-preview">${renderCardText(data.bodies[index] ?? "", data.repo)}</article>
          </details>`
              : `<p class="muted small">Left out: nothing will be created for it.</p>`
          }
        </fieldset>`;
    })
    .join("");
}

// The actions of the form; the hidden first button is what Enter presses.
export const EDITOR_DEFAULT_BUTTON = `<button type="submit" class="visually-hidden" name="action" value="refresh" tabindex="-1" aria-hidden="true" data-plain></button>`;
