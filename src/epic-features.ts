import { activityStatement } from "./activity-log";
import { addDependency } from "./card-dependencies";
import { cardRef, cardUrl } from "./card-views";
import { createCard, findCard, saveFeaturesProposal, setCardPriority, type Card, type EpicFeaturesProposal, type ProposedFeature } from "./cards";
import { syncEpicLink } from "./card-epics";
import type { Project } from "./projects";
import { notice, projectContext, projectHeader } from "./project-views";
import { cleanDepends } from "./specs";
import { projectUrl } from "./urls";
import { csrfField, escapeHtml, layout, type Viewer } from "./views";

// The features Claude proposed for an epic, reviewed before any card is
// created (la-fabrique#282): the preview page, its form, and the creation of
// the kept ones as draft cards attached to the epic, in no release (the
// board's Not set lane).

export function featureBody(feature: Pick<ProposedFeature, "synopsis" | "need">): string {
  return [feature.synopsis.trim(), feature.need.trim() ? `## Need\n\n${feature.need.trim()}` : ""].filter(Boolean).join("\n\n");
}

export function readFeaturesForm(form: FormData, proposal: EpicFeaturesProposal, known: Set<number>): { proposal: EpicFeaturesProposal; kept: number[] } {
  const kept: number[] = [];
  const count = proposal.features.length;
  const features = proposal.features.map((feature, index) => {
    if (form.get(`keep_${index}`) === "1") kept.push(index);
    const priority = String(form.get(`priority_${index}`) ?? feature.priority ?? "").trim();
    return {
      title: String(form.get(`title_${index}`) ?? feature.title).replace(/\s+/g, " ").trim().slice(0, 200),
      synopsis: String(form.get(`synopsis_${index}`) ?? feature.synopsis).replace(/\r\n/g, "\n").trim().slice(0, 4000),
      need: String(form.get(`need_${index}`) ?? feature.need).replace(/\r\n/g, "\n").trim().slice(0, 4000),
      priority: priority || null,
      depends: cleanDepends(form.get(`depends_${index}`) ?? feature.depends, index, count, known),
    };
  });
  return { proposal: { ...proposal, features }, kept };
}

export interface CreatedFeatures {
  ids: number[];
  // Dependencies that could not be set (a loop, a feature left out), with why.
  skipped: string[];
}

// Creates the kept features as draft cards attached to the epic, then their
// dependencies (a "P2" is the card made for the 2nd proposed feature), then
// drops the proposal. Journalled once, with the cards made.
export async function createFeatures(
  db: D1Database,
  project: Project,
  epic: Card,
  login: string,
  proposal: EpicFeaturesProposal,
  kept: number[],
): Promise<CreatedFeatures> {
  const made = new Map<number, number>();
  for (const index of kept) {
    const feature = proposal.features[index];
    if (!feature) continue;
    const id = await createCard(db, project.repo, login, {
      title: feature.title,
      body: featureBody(feature),
      tags: { kind: "feature", status: "draft", epic: epic.title, domain: null, segment: null, release: null },
    });
    made.set(index, id);
    const card = await findCard(db, project.repo, id);
    if (!card) continue;
    await syncEpicLink(db, card, login);
    if (feature.priority) await setCardPriority(db, card, feature.priority, login);
  }
  const skipped: string[] = [];
  for (const [index, id] of made) {
    const card = await findCard(db, project.repo, id);
    const feature = proposal.features[index];
    if (!card || !feature) continue;
    for (const ref of feature.depends) {
      const n = Number(ref.slice(1));
      const target = ref.startsWith("P") ? made.get(n - 1) : n;
      if (!target) {
        skipped.push(`${feature.title}: ${ref} was not kept`);
        continue;
      }
      const outcome = await addDependency(db, project.repo, card, { card: target }, login);
      if (!outcome.ok) skipped.push(`${feature.title}: ${outcome.reason}`);
    }
  }
  const fresh = (await findCard(db, project.repo, epic.id)) ?? epic;
  await saveFeaturesProposal(db, fresh, login, null);
  await db.batch([
    activityStatement(db, { actor: login, action: "epic_features_created", repo: project.repo, details: { epic: epic.id, title: epic.title, cards: [...made.values()], ...(skipped.length ? { skipped } : {}) } }),
  ]);
  return { ids: [...made.values()], skipped };
}

export function featuresPage(
  viewer: Viewer,
  project: Project,
  data: {
    epic: Card;
    proposal: EpicFeaturesProposal;
    kept: Set<number>;
    priorities: string[];
    titles: Map<number, string>;
    outdated: boolean;
    error?: string | undefined;
  },
): string {
  const { epic, proposal } = data;
  const url = cardUrl(project.repo, epic.id);
  const named = (ref: string): string => {
    const n = Number(ref.slice(1));
    const title = ref.startsWith("P") ? proposal.features[n - 1]?.title : data.titles.get(n);
    return `${escapeHtml(ref)}${title ? ` ${escapeHtml(title)}` : ""}`;
  };
  const blocks = proposal.features
    .map((feature, index) => {
      const priorities = ["", ...data.priorities, ...(feature.priority && !data.priorities.includes(feature.priority) ? [feature.priority] : [])];
      return `<fieldset class="split-story">
        <legend><span class="mono">P${index + 1}</span> ${escapeHtml(feature.title)}</legend>
        <label class="check split-keep"><input type="checkbox" name="keep_${index}" value="1"${data.kept.has(index) ? " checked" : ""} /> Create this feature</label>
        <div class="field"><label for="ft_${index}">Title</label><input id="ft_${index}" name="title_${index}" maxlength="200" value="${escapeHtml(feature.title)}" /></div>
        <div class="field"><label for="fs_${index}">Synopsis</label><textarea id="fs_${index}" name="synopsis_${index}" rows="3" maxlength="4000">${escapeHtml(feature.synopsis)}</textarea></div>
        <div class="field"><label for="fn_${index}">Need</label><textarea id="fn_${index}" name="need_${index}" rows="3" maxlength="4000">${escapeHtml(feature.need)}</textarea></div>
        ${
          data.priorities.length
            ? `<div class="field"><label for="fp_${index}">Priority</label><select id="fp_${index}" name="priority_${index}">${priorities.map((p) => `<option value="${escapeHtml(p)}"${(feature.priority ?? "") === p ? " selected" : ""}>${p ? escapeHtml(p) : "Not set"}</option>`).join("")}</select></div>`
            : ""
        }
        <div class="field"><label for="fd_${index}">Depends on</label>
          <input id="fd_${index}" name="depends_${index}" class="mono" value="${escapeHtml(feature.depends.join(", "))}" aria-describedby="fdh_${index}" />
          <p class="help" id="fdh_${index}">${feature.depends.length ? feature.depends.map(named).join("; ") : "Nothing."} C12 is a feature of the project, P2 the 2nd proposed one.</p></div>
      </fieldset>`;
    })
    .join("");
  return layout(
    `Features of ${cardRef(epic.id)} · ${project.check?.config?.nom || project.repo} · La Fabrique extraordinaire`,
    `${projectHeader(project, "board", `Features of ${cardRef(epic.id)}`)}
      <p class="crumbs"><a href="${escapeHtml(projectUrl(project.repo))}/board">Board</a> <span aria-hidden="true">›</span> <a class="mono" href="${escapeHtml(url)}">${cardRef(epic.id)}</a> ${escapeHtml(epic.title)}</p>
      ${notice(data.error, "error")}
      ${data.outdated ? `<p class="notice error">The epic's document changed since Claude proposed this.</p>` : ""}
      <p>Claude proposes ${proposal.features.length} feature${proposal.features.length === 1 ? "" : "s"}${proposal.note ? `: ${escapeHtml(proposal.note)}` : "."} Edit what you want, uncheck those you do not want. Each checked one becomes a draft card attached to the epic, in the <em>Not set</em> release lane; you assign the releases.</p>
      <form method="post" action="${escapeHtml(url)}/features" class="request-form split-form" data-busy="Sending…">${csrfField(viewer)}
        ${blocks}
        <div class="card-actions">
          <button type="submit" class="button" name="action" value="create"${data.kept.size ? "" : " disabled"}>Create the checked features</button>
          <button type="submit" class="button quiet" name="action" value="save">Save my edits</button>
          <button type="submit" class="button quiet" name="action" value="discard" formnovalidate>Discard the proposal</button>
        </div>
      </form>`,
    viewer,
    [],
    projectContext(project, false),
  );
}
