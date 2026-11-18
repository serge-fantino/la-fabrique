// Search, filter and sort the sprint's list (la-fabrique#373). Pure: the
// state is read from, and written to, the page's address, so a view can be
// shared and works without the script.

export const STAGES = ["ready", "development", "test", "production", "blocked"] as const;
export type StageFilter = (typeof STAGES)[number];
export const SORTS = ["order", "priority", "stage", "activity"] as const;
export type SortKey = (typeof SORTS)[number];

export interface ListView {
  q: string;
  stages: StageFilter[];
  priority: string[];
  epic: string[];
  behind: boolean;
  can: boolean;
  mine: boolean;
  sort: SortKey;
  // One line per feature (default) or per story, grouped by feature.
  by: "feature" | "story";
}

const clean = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 20);

export function readListView(params: URLSearchParams): ListView {
  const sort = params.get("sort") ?? "";
  return {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    stages: clean(params.getAll("stage")).filter((value): value is StageFilter => (STAGES as readonly string[]).includes(value)),
    priority: clean(params.getAll("priority")),
    epic: clean(params.getAll("epic")),
    behind: params.get("behind") === "1",
    can: params.get("can") === "1",
    mine: params.get("mine") === "1",
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as SortKey) : "order",
    by: params.get("by") === "story" ? "story" : "feature",
  };
}

export const isFiltered = (view: ListView) =>
  Boolean(view.q || view.stages.length || view.priority.length || view.epic.length || view.behind || view.can || view.mine);
export const isCustom = (view: ListView) => isFiltered(view) || view.sort !== "order";

// The address of a view, relative to the sprint page.
export function listViewQuery(view: ListView): string {
  const params = new URLSearchParams();
  if (view.q) params.set("q", view.q);
  for (const value of view.stages) params.append("stage", value);
  for (const value of view.priority) params.append("priority", value);
  for (const value of view.epic) params.append("epic", value);
  if (view.behind) params.set("behind", "1");
  if (view.can) params.set("can", "1");
  if (view.mine) params.set("mine", "1");
  if (view.sort !== "order") params.set("sort", view.sort);
  if (view.by === "story") params.set("by", "story");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface StoryFacts {
  number: number;
  title: string;
  stage: StageFilter | "backlog";
  priority: string | null;
  activity?: string | null;
}

export interface FeatureFacts {
  id: number;
  title: string;
  priority: string | null;
  epic: string | null;
  backstage: boolean;
  stories: StoryFacts[];
  // The feature has an action this person's role allows.
  canDo: boolean;
  // Something waits for this person by name.
  waitingForMe: boolean;
  // Latest line of La Fabrique's log about the feature's stories.
  activity: string | null;
}

// "#204", "204", "C147", "c147" or words of a title.
function matchesSearch(feature: FeatureFacts, q: string): { feature: boolean; stories: Set<number> } {
  const text = q.toLowerCase();
  const number = /^#?(\d+)$/.exec(text)?.[1];
  const card = /^c(\d+)$/.exec(text)?.[1];
  const stories = new Set<number>();
  let own = false;
  if (card !== undefined) own = feature.id === Number(card);
  else if (number !== undefined) {
    for (const story of feature.stories) if (String(story.number) === number) stories.add(story.number);
  } else {
    own = feature.title.toLowerCase().includes(text);
    for (const story of feature.stories) if (story.title.toLowerCase().includes(text)) stories.add(story.number);
  }
  return { feature: own, stories };
}

// A feature is kept when it matches, or when one of its stories does.
export function matchesFeature(feature: FeatureFacts, view: ListView): boolean {
  if (view.q) {
    const found = matchesSearch(feature, view.q);
    if (!found.feature && found.stories.size === 0) return false;
  }
  if (view.stages.length && !feature.stories.some((story) => (view.stages as string[]).includes(story.stage))) return false;
  if (view.priority.length) {
    const wanted = view.priority.map((value) => value.toLowerCase());
    const has = (value: string | null) => (value ? wanted.includes(value.toLowerCase()) : wanted.includes("none"));
    if (!has(feature.priority) && !feature.stories.some((story) => has(story.priority))) return false;
  }
  if (view.epic.length && !(feature.epic && view.epic.map((value) => value.toLowerCase()).includes(feature.epic.toLowerCase()))) return false;
  if (view.behind && !feature.backstage) return false;
  if (view.can && !feature.canDo) return false;
  if (view.mine && !feature.waitingForMe) return false;
  return true;
}

const STAGE_RANK: Record<string, number> = { blocked: 0, test: 1, development: 2, ready: 3, backlog: 4, production: 5 };

// The most pressing stage of a feature's stories (lowest rank).
function stageRank(feature: FeatureFacts): number {
  return feature.stories.length ? Math.min(...feature.stories.map((story) => STAGE_RANK[story.stage] ?? 4)) : 6;
}

// Filtered and sorted; "order" keeps the sprint's order, the others are
// stable on it.
export function applyListView<T extends FeatureFacts>(features: T[], view: ListView, priorities: string[]): T[] {
  const kept = features.filter((feature) => matchesFeature(feature, view));
  if (view.sort === "order") return kept;
  const rank = (value: string | null) => {
    const at = value ? priorities.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) : -1;
    return at === -1 ? priorities.length : at;
  };
  const key = (feature: T): number => (view.sort === "priority" ? rank(feature.priority) : stageRank(feature));
  const indexed = kept.map((feature, index) => ({ feature, index }));
  indexed.sort((a, b) => {
    if (view.sort === "activity") {
      const left = a.feature.activity ?? "";
      const right = b.feature.activity ?? "";
      if (left !== right) return left < right ? 1 : -1;
      return a.index - b.index;
    }
    return key(a.feature) - key(b.feature) || a.index - b.index;
  });
  return indexed.map((entry) => entry.feature);
}

// The stories of a kept feature to show open: those that match the search.
export function matchingStories(feature: FeatureFacts, view: ListView): Set<number> {
  return view.q ? matchesSearch(feature, view.q).stories : new Set();
}

// By story (la-fabrique#375): the stories that pass the view, with their
// feature. Sorted by the sprint's order they stay grouped by feature; any
// other sort leaves the groups and the stories are one flat list.
export interface StoryLine<T extends FeatureFacts> {
  feature: T;
  story: StoryFacts;
}

function storyKept(feature: FeatureFacts, story: StoryFacts, view: ListView): boolean {
  if (view.q) {
    const text = view.q.toLowerCase();
    const number = /^#?(\d+)$/.exec(text)?.[1];
    const card = /^c(\d+)$/.exec(text)?.[1];
    if (card !== undefined) {
      if (feature.id !== Number(card)) return false;
    } else if (number !== undefined) {
      if (String(story.number) !== number) return false;
    } else if (!story.title.toLowerCase().includes(text) && !feature.title.toLowerCase().includes(text)) return false;
  }
  if (view.stages.length && !(view.stages as string[]).includes(story.stage)) return false;
  if (view.priority.length) {
    const wanted = view.priority.map((value) => value.toLowerCase());
    const own = story.priority ?? feature.priority;
    if (!(own ? wanted.includes(own.toLowerCase()) : wanted.includes("none"))) return false;
  }
  return true;
}

export function applyStoryView<T extends FeatureFacts>(features: T[], view: ListView, priorities: string[]): StoryLine<T>[] {
  const kept = features.filter((feature) => matchesFeature(feature, view));
  const lines = kept.flatMap((feature) => feature.stories.filter((story) => storyKept(feature, story, view)).map((story) => ({ feature, story })));
  if (view.sort === "order") return lines;
  const rank = (value: string | null) => {
    const at = value ? priorities.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) : -1;
    return at === -1 ? priorities.length : at;
  };
  const indexed = lines.map((line, index) => ({ line, index }));
  indexed.sort((a, b) => {
    if (view.sort === "activity") {
      const left = a.line.story.activity ?? "";
      const right = b.line.story.activity ?? "";
      if (left !== right) return left < right ? 1 : -1;
      return a.index - b.index;
    }
    const key = (line: StoryLine<T>) => (view.sort === "priority" ? rank(line.story.priority ?? line.feature.priority) : (STAGE_RANK[line.story.stage] ?? 4));
    return key(a.line) - key(b.line) || a.index - b.index;
  });
  return indexed.map((entry) => entry.line);
}
