import { knownValues } from "./card-releases";
import { projectLinks } from "./card-dependencies";
import { epicCardsOf } from "./card-epics";
import { listCards, findCard, type Card } from "./cards";
import { epicDependencies } from "./epic-dependencies";
import { isAvailable } from "./dependency-warnings";
import type { Env } from "./env";
import { html, redirect } from "./http";
import { cycleRules } from "./lifecycle";
import { findProject, type Project } from "./projects";
import { can } from "./rights";
import { epicProgress } from "./roadmap";
import { dependencyTree, epicGraph, planSection, type TreeGroup } from "./roadmap-plan-views";
import { clampCapacity, defaultCapacity, epicLevels, featureWaves, HORIZONS, readPlans, savePlans, sprintPlan, sprintsStarted, SPRINT_NEXT } from "./roadmap-plan";
import { roadmapPage } from "./roadmap-views";
import { dependenciesIn } from "./sprint-dependencies";
import { loadStories } from "./stories";
import { moveToRefinement } from "./to-refinement";
import { projectUrl } from "./urls";
import { projectView } from "./view-context";
import { messagePage, type Viewer } from "./views";

function notFound(viewer: Viewer): Response {
  return html(messagePage("Not found", "There is no such project in La Fabrique extraordinaire.", viewer), { status: 404 });
}

async function planData(env: Env, project: Project, perParam: string | null) {
  const [cards, links, plans, started] = await Promise.all([
    listCards(env.DB, project.repo),
    projectLinks(env.DB, project.repo),
    readPlans(env.DB, project.repo),
    sprintsStarted(env.DB, project.repo),
  ]);
  const { releases } = await knownValues(env, project, cards);
  const per = Number(perParam);
  const capacity = perParam && Number.isInteger(per) ? clampCapacity(per) : defaultCapacity(cards, releases);
  const priorities = cycleRules(project.check?.config).priorities;
  const columns = sprintPlan({ cards, links, releases, priorities, capacity, started, plans });
  return { cards, links, releases, capacity, started, columns };
}

// The tree: each epic with its features by wave, then the features with no epic.
function treeGroups(cards: Card[], links: Awaited<ReturnType<typeof projectLinks>>): TreeGroup[] {
  const features = cards.filter((card) => card.kind === "feature" && !card.archivedAt && card.status !== "dropped");
  const waves = featureWaves(features, links);
  const group = (epic: Card | null, own: Card[]): TreeGroup => {
    const todo = own.filter((card) => !isAvailable(card));
    const numbers = [...new Set(todo.map((card) => waves.get(card.id) ?? 1))].sort((a, b) => a - b);
    return {
      epic,
      waves: numbers.map((wave) => ({
        wave,
        cards: todo
          .filter((card) => (waves.get(card.id) ?? 1) === wave)
          .sort((a, b) => a.position - b.position || a.id - b.id)
          .map((card) => ({ card, after: dependenciesIn(card, features, links).filter((other) => !isAvailable(other)).map((other) => other.id) })),
      })),
      done: own.filter(isAvailable),
    };
  };
  const epics = epicCardsOf(cards);
  const same = (card: Card, epic: Card) => (card.epic ?? "").trim().toLowerCase() === epic.title.trim().toLowerCase();
  const loose = features.filter((card) => !epics.some((epic) => same(card, epic)));
  return [
    ...epics.map((epic) => group(epic, features.filter((card) => same(card, epic)))).filter((one) => one.waves.length || one.done.length),
    ...(loose.length ? [group(null, loose)] : []),
  ];
}

export async function showRoadmap(request: Request, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  const url = new URL(request.url);
  const { view, cookies } = await projectView(request, env, project, viewer);
  const [plan, stories] = await Promise.all([planData(env, project, url.searchParams.get("per")), loadStories(env, project)]);
  const epics = epicCardsOf(plan.cards);
  const byTitle = new Map(epics.map((epic) => [epic.title.trim().toLowerCase(), epic.id]));
  const dependsOn = new Map(
    epics.map((epic) => [
      epic.id,
      epicDependencies(epic, plan.cards, plan.links)
        .epics.map((title) => byTitle.get(title.trim().toLowerCase()))
        .filter((id): id is number => id !== undefined && id !== epic.id),
    ]),
  );
  const canWrite = can(viewer.role, "request");
  const graph = `<section class="roadmap-tree" id="dependencies">
      <h2>Dependency tree</h2>
      <p class="muted">The epics, left to right in the order their features' dependencies ask for; then each epic's features by wave: <em>Can start</em> waits for nothing still to do, each next wave after the one before.</p>
      ${epicGraph(project.repo, epicLevels(epics, dependsOn, plan.cards))}
      ${dependencyTree(project.repo, treeGroups(plan.cards, plan.links))}
    </section>`;
  return html(
    roadmapPage(viewer, view, {
      epics: epicProgress(stories.stories, new Date().toISOString().slice(0, 10)),
      plan: planSection(viewer, project, plan.columns, plan.capacity, canWrite, Number(url.searchParams.get("kept")) || 0) + graph,
      failure: stories.failure,
    }),
    { cookies },
  );
}

// Planning by hand: one feature into a sprint to come (or back to the
// proposal, or into Next release); the whole proposal kept; the plan cleared.
export async function roadmapAction(request: Request, form: FormData, env: Env, viewer: Viewer, repo: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer);
  if (!can(viewer.role, "request")) return html(messagePage("Not allowed", "Your role does not let you plan the sprints.", viewer), { status: 403 });
  const action = String(form.get("action") ?? "");
  const per = String(form.get("per") ?? "");
  const back = (extra = "", anchor = "plan") => redirect(`${projectUrl(project.repo)}/roadmap${per || extra ? `?${[per ? `per=${encodeURIComponent(per)}` : "", extra].filter(Boolean).join("&")}` : ""}#${anchor}`);
  const plan = await planData(env, project, per || null);

  if (action === "plan") {
    const card = await findCard(env.DB, project.repo, Number(form.get("card")));
    if (!card || card.kind !== "feature") return back();
    const choice = String(form.get("sprint") ?? "");
    if (choice === "next") {
      await moveToRefinement(env, project, card, plan.releases, viewer.login, new URL(request.url).origin);
      await savePlans(env.DB, project.repo, plan.started, [{ card: card.id, offset: null }], viewer.login, "card_unplanned");
      return back("", `plan-c${card.id}`);
    }
    const offset = Number(choice);
    const wanted = choice === "auto" ? null : Number.isInteger(offset) && offset > SPRINT_NEXT && offset <= HORIZONS + 1 ? offset : undefined;
    if (wanted === undefined) return back();
    await savePlans(env.DB, project.repo, plan.started, [{ card: card.id, offset: wanted }], viewer.login, wanted === null ? "card_unplanned" : "card_planned");
    return back("", `plan-c${card.id}`);
  }
  if (action === "plan_keep") {
    const wanted = plan.columns
      .filter((column) => column.offset > SPRINT_NEXT && Number.isFinite(column.offset))
      .flatMap((column) => column.cards.filter((one) => !one.manual).map((one) => ({ card: one.card.id, offset: column.offset })));
    await savePlans(env.DB, project.repo, plan.started, wanted, viewer.login, "plan_kept");
    return back(`kept=${wanted.length}`);
  }
  if (action === "plan_clear") {
    const wanted = plan.columns.flatMap((column) => column.cards.filter((one) => one.manual).map((one) => ({ card: one.card.id, offset: null })));
    await savePlans(env.DB, project.repo, plan.started, wanted, viewer.login, "plan_cleared");
    return back();
  }
  return back();
}

