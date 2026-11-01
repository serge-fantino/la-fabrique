import { effectiveRole, type Role } from "./accounts";
import { activityStatement } from "./activity-log";
import { applyCardPriority, markReady, storyPriority } from "./card-priority";
import { cardProgress, PROGRESS_LABELS, type Progress } from "./card-progress";
import { progressDetail } from "./progress-stages";
import { NEXT_RELEASE, SPRINT_LANE } from "./card-releases";
import { cardStories, type CardStory } from "./card-stories";
import { storyCards, isNice } from "./card-groups";
import { cardPermalink, cardRef, cardUrl } from "./card-views";
import {
  advanceStatus,
  createCard,
  dimensionValues,
  findCard,
  isKind,
  isStatus,
  linkStory,
  listCards,
  moveCard,
  readCardForm,
  reopenStatus,
  saveSpec,
  setCardPriority,
  setStatus,
  STATUS_LABELS,
  updateCard,
  type Card,
} from "./cards";
import { canLaunchClaude, launchClaude } from "./claude";
import type { Env } from "./env";
import { installationToken } from "./github-app";
import { cycleRules, projectRules } from "./lifecycle";
import { setPriority } from "./backlog";
import type { GrantProps } from "./oauth";
import { findProject, listProjects, productionBranch, type Project } from "./projects";
import { createIssue } from "./requests";
import { can, type Action } from "./rights";
import { activeSprint, setNice } from "./sprints";
import { closeSprint, startSprint } from "./sprint-flow";
import { canMerge, mergePull, pullDetails } from "./sprint-pulls";
import { hasIntegration } from "./sprint-release";
import { missingSections, specRubriques } from "./specs";
import { loadStoryDetail } from "./story-detail";
import { projectUrl } from "./urls";
import { wordingFor } from "./wording";

// La Fabrique as an MCP server (la-fabrique#155): Claude, connected by the
// person (OAuth, the `fabrique` scope), reads and writes the upstream of
// the projects in that person's name, with that person's rights, read
// again at each call. Every write is in the log under the person's login,
// marked as made through Claude. The go stays a person's act, on its page.
// Streamable HTTP, without sessions nor streams: one JSON answer per POST.

export const MCP_PATH = "/mcp";
export const MCP_SCOPE = "fabrique";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS =
  "La Fabrique extraordinaire is the cockpit of software projects built with Claude. GitHub holds the development (stories are issues, " +
  "code is branches and pull requests); La Fabrique holds the upstream: cards (features, ideas, questions) on a board, their functional " +
  "spec, and the sprint. The cycle: a card (draft) gets a spec in the project's sections (card_spec), is validated, becomes stories on " +
  "GitHub (stories_create, each linked to its card), goes into Next release, then into the sprint (sprint_start); Claude Code is launched " +
  "on each ready story (launch_claude), its pull request is merged (merge), the stories are tested, and the go to production is given by a " +
  "person on La Fabrique's sprint page (never through this server). A card's status follows its stories once validated. Read before " +
  "writing (projects, board, card, sprint, story); say what you are about to write, and give the links the results carry. Everything you " +
  "write is in the person's name and in La Fabrique's log.";

interface Context {
  env: Env;
  login: string;
  role: Role;
  app: string;
  origin: string;
}

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // What the person needs; a write is logged as made through Claude.
  needs: Action | null;
  write: boolean;
  run: (ctx: Context, args: Args) => Promise<unknown>;
}

class ToolError extends Error {}

const fail = (message: string): never => {
  throw new ToolError(message);
};

// ---- Arguments -----------------------------------------------------------

function text(args: Args, key: string, max: number): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return fail(`${key} must be a string.`);
  return value.slice(0, max);
}

function integer(args: Args, key: string): number {
  const value = typeof args[key] === "string" ? Number(String(args[key]).replace(/^[#C]/i, "")) : args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fail(`${key} must be a positive number.`);
  return value;
}

// A project by "owner/repo" or by its repository's name alone.
async function projectOf(ctx: Context, args: Args): Promise<Project> {
  const wanted = text(args, "project", 200)?.trim();
  if (!wanted) return fail("Say which project (owner/repo, or the repository's name): the projects tool lists them.");
  const exact = await findProject(ctx.env.DB, wanted);
  if (exact) return exact;
  const matching = (await listProjects(ctx.env.DB)).filter((project) => project.repo.split("/")[1]?.toLowerCase() === wanted.toLowerCase());
  if (matching.length === 1 && matching[0]) return matching[0];
  return fail(matching.length ? `Several projects are called ${wanted}: give owner/repo.` : `No project ${wanted} in La Fabrique.`);
}

async function cardOf(ctx: Context, project: Project, args: Args): Promise<Card> {
  const id = integer(args, "card");
  const card = await findCard(ctx.env.DB, project.repo, id);
  return card ?? fail(`No card ${cardRef(id)} in ${project.repo}.`);
}

const absolute = (ctx: Context, path: string) => new URL(path, ctx.origin).href;

// ---- What is read ----------------------------------------------------------

function cardSummary(ctx: Context, card: Card, progress: Progress | undefined, stories: number[]) {
  return {
    id: card.id,
    ref: cardRef(card.id),
    title: card.title,
    kind: card.kind,
    status: card.status,
    shown_status: progress ? `${PROGRESS_LABELS[progress.stage]}${progressDetail(progress) ? ` ${progressDetail(progress)}` : ""}` : STATUS_LABELS[card.status],
    release: card.release,
    priority: card.priority,
    epic: card.epic,
    domain: card.domain,
    segment: card.segment,
    stories,
    archived: Boolean(card.archivedAt),
    rev: card.rev,
    url: absolute(ctx, cardUrl(card.repo, card.id)),
  };
}

function storySummary(project: Project, story: CardStory | undefined, number: number, nice: boolean) {
  return {
    number,
    title: story?.title ?? null,
    stage: story?.closed ? "done" : (story?.stage ?? null),
    nice_to_have: nice,
    priority: story?.priority ?? null,
    missing_for_ready: story?.missing ?? [],
    criteria: story ? `${story.criteria.filter((criterion) => criterion.done).length}/${story.criteria.length}` : null,
    validated_by: story?.validated?.by ?? null,
    pulls: (story?.pulls ?? []).map((pull) => ({ number: pull.number, state: pull.state, url: pull.url })),
    url: `https://github.com/${project.repo}/issues/${number}`,
  };
}

const PROJECT = { project: { type: "string", description: "The project: owner/repo, or the repository's name" } };
const CARD = { card: { type: "integer", description: "The card's number (C12 → 12)" } };

const RELEASES = [NEXT_RELEASE, SPRINT_LANE];

// ---- Writing a card --------------------------------------------------------

// A card's fields, read as the board's form reads them (annotations of
// the text win over the fields).
async function cardInput(ctx: Context, project: Project, fields: Record<string, string | null>) {
  const cards = await listCards(ctx.env.DB, project.repo);
  const known = await dimensionValues(ctx.env.DB, project.repo, cards);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== null) form.set(key, value);
  return readCardForm(form, known);
}

async function checkRelease(ctx: Context, project: Project, release: string | null | undefined): Promise<void> {
  if (release === undefined || release === null) return;
  if (!RELEASES.includes(release)) fail(`release is "${NEXT_RELEASE}", "${SPRINT_LANE}" or null: a card takes a version only once it ships.`);
  if (release === SPRINT_LANE && !(await activeSprint(ctx.env.DB, project.repo))) fail("No sprint is running: put the card in Next release, then start the sprint.");
}

function checkPriority(project: Project, priority: string | null | undefined): void {
  if (priority === undefined || priority === null) return;
  const priorities = cycleRules(project.check?.config).priorities;
  if (!priorities.includes(priority)) fail(`priority is one of ${priorities.join(", ") || "(none declared by the project)"}, or null.`);
}

function release(args: Args): string | null | undefined {
  return args["release"] === null ? null : text(args, "release", 100);
}

function priority(args: Args): string | null | undefined {
  return args["priority"] === null ? null : text(args, "priority", 50);
}

async function priorityOnGitHub(ctx: Context, project: Project, card: Card, to: string | null): Promise<string[]> {
  if (!(await setCardPriority(ctx.env.DB, card, to, ctx.login))) return [];
  return to ? applyCardPriority(ctx.env, project, { ...card, priority: to }, ctx.login) : [];
}

// ---- The tools ---------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "projects",
    title: "Projects",
    description: "The projects La Fabrique pilots: repository, name, branches, whether a sprint is running, and your role.",
    inputSchema: { type: "object", properties: {} },
    needs: null,
    write: false,
    async run(ctx) {
      const projects = await listProjects(ctx.env.DB);
      return {
        role: ctx.role,
        projects: await Promise.all(
          projects.map(async (project) => ({
            repo: project.repo,
            name: project.check?.config?.nom ?? project.repo,
            production_branch: productionBranch(project),
            integration_branch: hasIntegration(project) ? (project.check?.config?.branches?.integration ?? null) : null,
            sprint_running: Boolean(await activeSprint(ctx.env.DB, project.repo)),
            url: absolute(ctx, projectUrl(project.repo)),
          })),
        ),
      };
    },
  },
  {
    name: "board",
    title: "Board",
    description:
      "A project's cards, in the board's order: status (and, once validated, the stage its stories reached), release lane (Next release, Sprint, or the version that shipped it), priority, stories. Filter by status, release or kind.",
    inputSchema: {
      type: "object",
      properties: {
        ...PROJECT,
        status: { type: "string", description: "draft, shaping, to_validate, validated, dropped" },
        release: { type: "string", description: "Next release, Sprint, a version, or none" },
        kind: { type: "string", description: "feature, idea, question" },
        archived: { type: "boolean", description: "Include archived cards" },
      },
      required: ["project"],
    },
    needs: null,
    write: false,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const status = text(args, "status", 30);
      const wantedRelease = text(args, "release", 100);
      const kind = text(args, "kind", 30);
      const all = await listCards(ctx.env.DB, project.repo);
      const links = await storyCards(ctx.env.DB, project.repo);
      const cards = all.filter(
        (card) =>
          (args["archived"] === true || !card.archivedAt) &&
          (!status || card.status === status) &&
          (!kind || card.kind === kind) &&
          (wantedRelease === undefined || (wantedRelease === "none" ? !card.release : card.release === wantedRelease)),
      );
      const progress = await cardProgress(ctx.env, project, cards, links);
      return {
        project: project.repo,
        cards: cards.map((card) => cardSummary(ctx, card, progress.get(card.id), links.order.get(card.id) ?? [])),
        board: absolute(ctx, `${projectUrl(project.repo)}/board`),
      };
    },
  },
  {
    name: "card",
    title: "A card",
    description: "One card in full: its text, its spec (by the project's sections, with what is still missing), its stories with their stage, testing and pull requests.",
    inputSchema: { type: "object", properties: { ...PROJECT, ...CARD }, required: ["project", "card"] },
    needs: null,
    write: false,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const card = await cardOf(ctx, project, args);
      const links = await storyCards(ctx.env.DB, project.repo);
      const numbers = links.order.get(card.id) ?? [];
      const [stories, progress] = await Promise.all([cardStories(ctx.env, project, numbers), cardProgress(ctx.env, project, [card], links)]);
      const rubriques = specRubriques(project);
      return {
        ...cardSummary(ctx, card, progress.get(card.id), numbers),
        body: card.body,
        spec_sections: rubriques.map((rubrique) => ({ key: rubrique.cle, title: rubrique.titre, required: Boolean(rubrique.obligatoire), help: rubrique.aide ?? null })),
        spec: card.data.spec ? { answers: card.data.spec.answers, source: card.data.spec.source, at: card.data.spec.at, open_questions: card.data.spec.questions } : null,
        spec_missing: missingSections(card.data.spec, rubriques),
        stories: numbers.map((number) => storySummary(project, stories.get(number), number, isNice(links, card.id, number))),
        permalink: absolute(ctx, cardPermalink(card.id, card.rev)),
      };
    },
  },
  {
    name: "sprint",
    title: "The sprint",
    description:
      "A project's running sprint: its cards in order, each with its stories (stage, nice to have, criteria checked, validation, pull requests), and the stories left before the release.",
    inputSchema: { type: "object", properties: { ...PROJECT }, required: ["project"] },
    needs: null,
    write: false,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const sprint = await activeSprint(ctx.env.DB, project.repo);
      const links = await storyCards(ctx.env.DB, project.repo);
      const lane = sprint ? sprint.release : NEXT_RELEASE;
      const cards = (await listCards(ctx.env.DB, project.repo)).filter((card) => card.release === lane && !card.archivedAt);
      const numbers = [...new Set(cards.flatMap((card) => links.order.get(card.id) ?? []))];
      const [stories, progress] = await Promise.all([cardStories(ctx.env, project, numbers), cardProgress(ctx.env, project, cards, links)]);
      const left = cards.flatMap((card) => (links.order.get(card.id) ?? []).filter((number) => !isNice(links, card.id, number) && !stories.get(number)?.closed));
      return {
        project: project.repo,
        running: sprint ? { started_at: sprint.startedAt, started_by: sprint.startedBy, version: sprint.version, name: sprint.name } : null,
        lane,
        note: sprint ? null : "No sprint running: these are the cards of Next release, which sprint_start takes.",
        cards: cards.map((card) => ({
          ...cardSummary(ctx, card, progress.get(card.id), links.order.get(card.id) ?? []),
          stories: (links.order.get(card.id) ?? []).map((number) => storySummary(project, stories.get(number), number, isNice(links, card.id, number))),
        })),
        stories_left: [...new Set(left)],
        url: absolute(ctx, `${projectUrl(project.repo)}/sprint`),
      };
    },
  },
  {
    name: "story",
    title: "A story",
    description: "One story in detail: its steps from ready to production, its acceptance criteria, its pull requests, Claude's runs and its history in La Fabrique's log.",
    inputSchema: { type: "object", properties: { ...PROJECT, story: { type: "integer", description: "The story's issue number" } }, required: ["project", "story"] },
    needs: null,
    write: false,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const number = integer(args, "story");
      const detail = await loadStoryDetail(ctx.env, project, number);
      return {
        number,
        title: detail.story?.title ?? detail.state?.title ?? null,
        stage: detail.state?.closed ? "done" : (detail.state?.stage ?? null),
        cards: detail.cards.map((card) => ({ id: card.id, ref: cardRef(card.id), title: card.title })),
        criteria: (detail.state?.criteria ?? []).map((criterion) => ({ text: criterion.text, done: criterion.done })),
        validated_by: detail.state?.validated?.by ?? null,
        pulls: detail.pulls.map((pull) => ({ number: pull.number, title: pull.title, state: pull.state, base: pull.base, draft: pull.draft, url: pull.url })),
        claude_runs: detail.runs.map((run) => ({ status: run.status, conclusion: run.conclusion, at: run.createdAt, url: run.url })),
        history: detail.history.map((entry) => ({ at: entry.at, actor: entry.actor, action: entry.action, issue: entry.issue, details: entry.details })),
        url: absolute(ctx, `${projectUrl(project.repo)}/sprint/stories/${number}`),
        issue: `https://github.com/${project.repo}/issues/${number}`,
      };
    },
  },
  {
    name: "card_create",
    title: "Create a card",
    description:
      "A new card on the project's board, as a draft. The text is Markdown; annotations such as {segment: Families}, #12, @login or [[Term]] are read as on the board. Put it in Next release to have the next sprint take it.",
    inputSchema: {
      type: "object",
      properties: {
        ...PROJECT,
        title: { type: "string" },
        body: { type: "string", description: "The card's text, in Markdown" },
        kind: { type: "string", enum: ["feature", "idea", "question"] },
        release: { type: ["string", "null"], description: `${NEXT_RELEASE}, ${SPRINT_LANE} (while a sprint runs), or null` },
        priority: { type: ["string", "null"], description: "One of the project's priority labels" },
      },
      required: ["project", "title"],
    },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const title = text(args, "title", 200)?.trim();
      if (!title) fail("A card needs a title.");
      const kind = text(args, "kind", 30) ?? "feature";
      if (!isKind(kind)) fail("kind is feature, idea or question.");
      const lane = release(args);
      await checkRelease(ctx, project, lane);
      const wanted = priority(args);
      checkPriority(project, wanted);
      const input = await cardInput(ctx, project, { title: title ?? "", body: text(args, "body", 50_000) ?? "", kind, status: "draft", release: lane ?? null });
      const id = await createCard(ctx.env.DB, project.repo, ctx.login, input);
      const card = await findCard(ctx.env.DB, project.repo, id);
      if (card && wanted) await setCardPriority(ctx.env.DB, card, wanted, ctx.login);
      const created = (await findCard(ctx.env.DB, project.repo, id)) ?? card;
      return created ? { created: cardSummary(ctx, created, undefined, []) } : fail("The card was not saved.");
    },
  },
  {
    name: "card_update",
    title: "Change a card",
    description:
      "Change a card: its title, text or kind (a validated card whose feature changes goes back to To validate), its status (draft, shaping, to_validate, validated, dropped; not once its stories carry it), its release lane (Next release, Sprint, or null) or its priority (given to its stories on GitHub). Pass rev, read from the card, to refuse to write over a change made since.",
    inputSchema: {
      type: "object",
      properties: {
        ...PROJECT,
        ...CARD,
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string", enum: ["feature", "idea", "question"] },
        status: { type: "string", enum: ["draft", "shaping", "to_validate", "validated", "dropped"] },
        release: { type: ["string", "null"] },
        priority: { type: ["string", "null"] },
        rev: { type: "integer", description: "The card's version you read" },
      },
      required: ["project", "card"],
    },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      let card = await cardOf(ctx, project, args);
      if (args["rev"] !== undefined && integer(args, "rev") !== card.rev) fail(`The card changed since (now version ${card.rev}): read it again.`);
      const changes: string[] = [];
      const title = text(args, "title", 200)?.trim();
      const body = text(args, "body", 50_000);
      const kind = text(args, "kind", 30);
      if (kind !== undefined && !isKind(kind)) fail("kind is feature, idea or question.");
      const status = text(args, "status", 30);
      if (status !== undefined && !isStatus(status)) fail("status is draft, shaping, to_validate, validated or dropped.");
      const lane = release(args);
      if (args["release"] !== undefined) await checkRelease(ctx, project, lane);
      const wanted = priority(args);
      if (args["priority"] !== undefined) checkPriority(project, wanted);
      if (card.archivedAt) fail("This card is archived: bring it back from its page first.");

      if (title !== undefined || body !== undefined || kind !== undefined) {
        const input = await cardInput(ctx, project, {
          title: title || card.title,
          body: body ?? card.body,
          kind: kind ?? card.kind,
          status: card.status,
          epic: card.epic,
          domain: card.domain,
          segment: card.segment,
          release: card.release,
        });
        const outcome = await updateCard(ctx.env.DB, card, ctx.login, input, card.rev);
        if (outcome === "conflict") fail("The card changed while writing: read it again.");
        if (outcome === "saved") {
          changes.push("text");
          if (input.title !== card.title || input.body !== card.body) await reopenStatus(ctx.env.DB, project.repo, card.id, ctx.login, "the card changed");
        }
        card = (await findCard(ctx.env.DB, project.repo, card.id)) ?? card;
      }
      if (status !== undefined && isStatus(status) && (await setStatus(ctx.env.DB, card, ctx.login, status))) {
        changes.push("status");
        card = (await findCard(ctx.env.DB, project.repo, card.id)) ?? card;
      }
      if (args["release"] !== undefined && (lane ?? null) !== card.release) {
        const known = await dimensionValues(ctx.env.DB, project.repo, await listCards(ctx.env.DB, project.repo));
        card = await moveCard(ctx.env.DB, card, ctx.login, { set: { release: lane ?? null }, before: null, after: null }, known, "through Claude");
        changes.push("release");
      }
      let refused: string[] = [];
      if (args["priority"] !== undefined && (wanted ?? null) !== card.priority) {
        refused = await priorityOnGitHub(ctx, project, card, wanted ?? null);
        changes.push("priority");
      }
      const current = (await findCard(ctx.env.DB, project.repo, card.id)) ?? card;
      return { changed: changes, ...(refused.length ? { github_refused: refused } : {}), card: cardSummary(ctx, current, undefined, (await storyCards(ctx.env.DB, project.repo)).order.get(card.id) ?? []) };
    },
  },
  {
    name: "card_spec",
    title: "Write a card's spec",
    description:
      "Write (or rewrite) a card's functional spec, section by section: the keys are the project's sections (card lists them, with which are required). Sections not given keep their text. Acceptance criteria: one line per criterion, checkable by a tester. A validated card whose spec changes goes back to To validate. Then stories_create.",
    inputSchema: {
      type: "object",
      properties: { ...PROJECT, ...CARD, answers: { type: "object", additionalProperties: { type: "string" }, description: "Section key → text (Markdown)" }, validate: { type: "boolean", description: "The spec is complete: move the card to To validate" } },
      required: ["project", "card", "answers"],
    },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const card = await cardOf(ctx, project, args);
      const given = args["answers"];
      if (!given || typeof given !== "object" || Array.isArray(given)) fail("answers is an object: section key → text.");
      const rubriques = specRubriques(project);
      const keys = new Set(rubriques.map((rubrique) => rubrique.cle));
      const unknown = Object.keys(given as object).filter((key) => !keys.has(key));
      if (unknown.length) fail(`Unknown sections: ${unknown.join(", ")}. The project's are ${[...keys].join(", ")}.`);
      const answers = { ...(card.data.spec?.answers ?? {}) };
      for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
        if (typeof value !== "string") fail(`${key} must be a text.`);
        answers[key] = String(value).trim().slice(0, 20_000);
      }
      const before = JSON.stringify(card.data.spec?.answers ?? {});
      await saveSpec(ctx.env.DB, card, ctx.login, { ...(card.data.spec ?? {}), answers, questions: [], source: "claude", note: `Written by Claude through ${ctx.app}.`, at: new Date().toISOString() });
      if (before !== JSON.stringify(answers)) await reopenStatus(ctx.env.DB, project.repo, card.id, ctx.login, "the spec changed");
      const missing = missingSections({ answers, questions: [], source: "claude", at: "" }, rubriques);
      if (args["validate"] === true && !missing.length) await advanceStatus(ctx.env.DB, project.repo, card.id, ctx.login, "to_validate", "spec written");
      const current = (await findCard(ctx.env.DB, project.repo, card.id)) ?? card;
      return { saved: true, missing, card: cardSummary(ctx, current, undefined, (await storyCards(ctx.env.DB, project.repo)).order.get(card.id) ?? []) };
    },
  },
  {
    name: "stories_create",
    title: "Make stories from a card",
    description:
      "Create the card's stories on GitHub, each an issue in the project's sections, linked to the card (its permanent link to this version of the spec, \"story 2 of 3\"), with the card's priority (one level lower when nice to have). One story without answers takes the card's spec. Each story must deliver something on its own, with its own acceptance criteria. The card becomes Validated.",
    inputSchema: {
      type: "object",
      properties: {
        ...PROJECT,
        ...CARD,
        stories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              answers: { type: "object", additionalProperties: { type: "string" }, description: "Section key → text, as in card_spec" },
              nice: { type: "boolean", description: "Nice to have: does not hold the release back" },
            },
            required: ["title"],
          },
        },
      },
      required: ["project", "card", "stories"],
    },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const card = await cardOf(ctx, project, args);
      const given = args["stories"];
      const list: unknown[] = Array.isArray(given) ? given : [];
      if (!list.length || list.length > 12) fail("stories is a list of 1 to 12 stories.");
      const rubriques = specRubriques(project);
      const wanted = list.map((item, index) => {
        if (!item || typeof item !== "object") return fail(`Story ${index + 1} is not an object.`);
        const story = item as Record<string, unknown>;
        const title = typeof story["title"] === "string" ? story["title"].replace(/\s+/g, " ").trim().slice(0, 200) : "";
        const written = story["answers"];
        const answers =
          written && typeof written === "object" && !Array.isArray(written)
            ? Object.fromEntries(Object.entries(written as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "").trim()]))
            : list.length === 1
              ? (card.data.spec?.answers ?? {})
              : fail(`Story ${index + 1} needs its answers (several stories do not share one spec).`);
        const missing = [...(title ? [] : ["Title"]), ...missingSections({ answers, questions: [], source: "claude", at: "" }, rubriques)];
        if (missing.length) fail(`Story ${index + 1} lacks: ${missing.join(", ")}.`);
        return { title, answers, nice: story["nice"] === true };
      });
      const words = wordingFor(project);
      const rules = await projectRules(ctx.env.DB, project);
      const token = await installationToken(ctx.env, project.installationId);
      const permalink = absolute(ctx, cardPermalink(card.id, card.rev));
      const already = (await storyCards(ctx.env.DB, project.repo)).order.get(card.id)?.length ?? 0;
      const total = already + wanted.length;
      const created: { number: number; title: string; url: string; nice: boolean }[] = [];
      for (const [index, story] of wanted.entries()) {
        const origin = words.fromCard(cardRef(card.id), permalink, card.rev, total > 1 ? { index: already + index + 1, total } : undefined);
        const outcome = await createIssue(ctx.env, project, token, ctx.login, { title: story.title, answers: story.answers }, rubriques, origin, "claude");
        if (!outcome.ok) {
          return { created, error: `GitHub refused to create "${story.title}" (HTTP ${outcome.status ?? "?"}); the stories above were made.` };
        }
        await linkStory(ctx.env.DB, card, ctx.login, outcome.number, outcome.url);
        if (story.nice) await setNice(ctx.env.DB, project.repo, card.id, outcome.number, true, ctx.login);
        const to = storyPriority(rules, card.priority, story.nice);
        if (to) await setPriority(ctx.env, project, ctx.login, outcome.number, to);
        created.push({ number: outcome.number, title: story.title, url: outcome.url, nice: story.nice });
      }
      await advanceStatus(ctx.env.DB, project.repo, card.id, ctx.login, "validated", "stories made");
      return { created, card: absolute(ctx, cardUrl(project.repo, card.id)) };
    },
  },
  {
    name: "story_link",
    title: "Link a story to a card",
    description: "Link an existing issue of the project to a card, as one of its stories.",
    inputSchema: { type: "object", properties: { ...PROJECT, ...CARD, story: { type: "integer" }, nice: { type: "boolean" } }, required: ["project", "card", "story"] },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const card = await cardOf(ctx, project, args);
      const number = integer(args, "story");
      const known = await cardStories(ctx.env, project, [number]);
      if (!known.get(number)) fail(`#${number} is not a story La Fabrique knows in ${project.repo}.`);
      await linkStory(ctx.env.DB, card, ctx.login, number, `https://github.com/${project.repo}/issues/${number}`);
      if (args["nice"] === true) await setNice(ctx.env.DB, project.repo, card.id, number, true, ctx.login);
      // A card with its story is validated, as when its stories are made.
      await advanceStatus(ctx.env.DB, project.repo, card.id, ctx.login, "validated", "story linked");
      return { linked: number, card: absolute(ctx, cardUrl(project.repo, card.id)) };
    },
  },
  {
    name: "story_ready",
    title: "Mark a story ready",
    description: "Mark a story ready for Claude (the project's ready label), once it has what its Definition of Ready asks (the story tool says what is missing).",
    inputSchema: { type: "object", properties: { ...PROJECT, story: { type: "integer" } }, required: ["project", "story"] },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const number = integer(args, "story");
      const outcome = await markReady(ctx.env, project, number, ctx.login);
      return outcome.ok ? { ready: number } : fail(outcome.message);
    },
  },
  {
    name: "sprint_start",
    title: "Start the sprint",
    description: "Start the project's sprint: the cards of Next release go into the Sprint lane. One sprint at a time. Its version is the release it will make when it closes: give one (0.82, 1.0), or the next minor after the newest release is taken.",
    inputSchema: {
      type: "object",
      properties: { ...PROJECT, version: { type: "string", description: "The version the sprint will release" }, name: { type: "string", description: "A name, if wanted" } },
      required: ["project"],
    },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const outcome = await startSprint(ctx.env, project, ctx.login, { version: text(args, "version", 30) ?? null, name: text(args, "name", 80) ?? null });
      return outcome.ok ? { started: true, cards: outcome.cards, url: absolute(ctx, `${projectUrl(project.repo)}/sprint`) } : fail(outcome.message);
    },
  },
  {
    name: "sprint_close",
    title: "Close the sprint",
    description:
      "Close the running sprint of a project with an integration branch: each finished card takes the version that shipped it, the others stay for the next sprint. On a project without one, closing makes the release: that is done on the sprint page.",
    inputSchema: { type: "object", properties: { ...PROJECT }, required: ["project"] },
    needs: "request",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const sprint = await activeSprint(ctx.env.DB, project.repo);
      if (!sprint) fail("No sprint is running.");
      if (!hasIntegration(project)) fail(`Closing this sprint makes the release: do it on the sprint page, ${absolute(ctx, `${projectUrl(project.repo)}/sprint`)}.`);
      const version = sprint ? await closeSprint(ctx.env, project, sprint, ctx.login) : null;
      return { closed: true, newest_version: version };
    },
  },
  {
    name: "launch_claude",
    title: "Launch Claude Code on a story",
    description: "Start the project's Claude workflow on a ready story of the sprint: a branch linked to the issue, then a pull request. Within the project's cap of runs at once.",
    inputSchema: { type: "object", properties: { ...PROJECT, story: { type: "integer" } }, required: ["project", "story"] },
    needs: "launch_claude",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const number = integer(args, "story");
      if (!canLaunchClaude(ctx.role)) fail("Launching Claude is for tech leads and super admins.");
      const outcome = await launchClaude(ctx.env, project, ctx.login, number);
      return outcome.ok ? { launched: number, sprint: absolute(ctx, `${projectUrl(project.repo)}/sprint`) } : fail(outcome.message);
    },
  },
  {
    name: "merge",
    title: "Merge a pull request",
    description:
      "Merge an open pull request through the project's merge workflow (which numbers its release notes). Into the integration branch: tech lead; into production: Product Engineer or super admin, as a go.",
    inputSchema: { type: "object", properties: { ...PROJECT, pull: { type: "integer" } }, required: ["project", "pull"] },
    needs: "launch_claude",
    write: true,
    async run(ctx, args) {
      const project = await projectOf(ctx, args);
      const pull = integer(args, "pull");
      const detail = (await pullDetails(ctx.env, project, [pull])).get(pull);
      if (!detail || detail.state !== "open") fail(`#${pull} is not an open pull request of ${project.repo}.`);
      if (!canMerge(ctx.role, project, detail?.base ?? null)) fail("Your role cannot merge into this branch.");
      const outcome = await mergePull(ctx.env, project, ctx.login, pull);
      return outcome.ok ? { merging: pull, sprint: absolute(ctx, `${projectUrl(project.repo)}/sprint`) } : fail(outcome.message);
    },
  },
];

// ---- The protocol ------------------------------------------------------------

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (data: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError });

export async function mcpServer(request: Request, env: Env, props: GrantProps): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(failure(null, -32700, "Invalid JSON"), { status: 400 });
  }
  const messages = Array.isArray(body) ? body : [body];
  const answers: unknown[] = [];
  for (const raw of messages) {
    const message = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message && message.id !== undefined) answers.push(failure(message.id ?? null, -32600, "Invalid request"));
      continue;
    }
    // A notification (notifications/initialized…): nothing to answer.
    if (message.id === undefined) continue;
    answers.push(await method(message.id, message.method, (message.params ?? {}) as Record<string, unknown>, request, env, props));
  }
  if (!answers.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? answers : answers[0], { headers: { "cache-control": "no-store" } });
}

async function method(id: unknown, name: string, params: Record<string, unknown>, request: Request, env: Env, props: GrantProps): Promise<unknown> {
  switch (name) {
    case "initialize": {
      const origin = new URL(request.url).origin;
      const asked = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "la-fabrique",
          title: "La Fabrique extraordinaire",
          version: "1.0.0",
          websiteUrl: origin,
          // Its mark, for the assistant to show (MCP 2025-11-25).
          icons: [
            { src: `${origin}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
            { src: `${origin}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
            { src: `${origin}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
          ],
        },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list": {
      const role = await effectiveRole(env, props.login);
      return reply(id, {
        tools: TOOLS.filter((tool) => tool.needs === null || can(role, tool.needs)).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: !tool.write, destructiveHint: false, openWorldHint: false },
        })),
      });
    }
    case "tools/call": {
      const tool = TOOLS.find((candidate) => candidate.name === params["name"]);
      if (!tool) return failure(id, -32602, `Unknown tool: ${String(params["name"])}`);
      // The role is read again at each call: a role taken back counts at once.
      const role = await effectiveRole(env, props.login);
      if (!role) return reply(id, result({ error: "Your account no longer has a role in La Fabrique." }, true));
      if (tool.needs && !can(role, tool.needs)) return reply(id, result({ error: `Your role (${role}) cannot do this.` }, true));
      const args = (params["arguments"] ?? {}) as Args;
      const ctx: Context = { env, login: props.login, role, app: props.app ?? "Claude", origin: new URL(request.url).origin };
      try {
        const data = await tool.run(ctx, args);
        if (tool.write) {
          const repo = typeof args["project"] === "string" ? ((await projectOf(ctx, args).catch(() => null))?.repo ?? null) : null;
          await activityStatement(env.DB, { actor: props.login, action: "mcp_write", ...(repo ? { repo } : {}), details: { tool: tool.name, app: ctx.app } }).run();
        }
        return reply(id, result(data));
      } catch (error) {
        if (error instanceof ToolError) return reply(id, result({ error: error.message }, true));
        console.error(`MCP ${tool.name}`, error);
        return reply(id, result({ error: "La Fabrique could not do it: an error on its side." }, true));
      }
    }
    default:
      return failure(id, -32601, `Unknown method: ${name}`);
  }
}

export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);
