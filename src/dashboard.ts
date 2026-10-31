import type { Role } from "./accounts";
import type { DeliveryData } from "./delivery";
import { IN_DEV, isStalled, type InDevData } from "./in-dev";
import { cycleRules, isEpic, priorityOf, stagesOf } from "./lifecycle";
import { PRODUCTION, type ProductionStatus } from "./production";
import { productionBranch, type Project } from "./projects";
import { RELEASES, type Release } from "./roadmap";
import { STORIES, type Story } from "./stories";

export type TileKey = "to_test" | "production" | "in_dev" | "ready" | "top_priority" | "ci" | "versions" | "release";

export interface Tile {
  key: TileKey;
  label: string;
  value: string;
  detail: string | null;
  tone: "ok" | "warn" | "alert" | null;
  path: string;
}

export interface ProjectCard {
  project: Project;
  tiles: Tile[];
  // When the oldest of the snapshots used was read; null: nothing read yet.
  readAt: string | null;
  // The production snapshot is old: the card refreshes once shown.
  stale: boolean;
}

const STALE_MS = 10 * 60 * 1000;

// What each role looks at first.
const ORDER: Record<Role, TileKey[]> = {
  tester: ["to_test", "versions", "production", "in_dev", "ready", "top_priority", "ci", "release"],
  tech_lead: ["ci", "in_dev", "production", "to_test", "ready", "top_priority", "versions", "release"],
  product_engineer: ["to_test", "ready", "top_priority", "in_dev", "production", "versions", "release", "ci"],
  super_admin: ["production", "to_test", "in_dev", "ci", "ready", "top_priority", "versions", "release"],
};

interface Snapshots {
  stories?: { data: Story[]; fetchedAt: string };
  production?: { data: ProductionStatus; fetchedAt: string };
  inDev?: { data: InDevData; fetchedAt: string };
  delivery?: { data: DeliveryData; fetchedAt: string };
  releases?: { data: { releases: Release[] }; fetchedAt: string };
}

// One query per project, no GitHub call.
async function readSnapshots(db: D1Database, repo: string): Promise<Snapshots> {
  const { results } = await db
    .prepare("SELECT kind, data, fetched_at FROM snapshots WHERE repo = ? AND kind IN (?, ?, ?, ?, ?)")
    .bind(repo, STORIES, PRODUCTION, IN_DEV, "delivery", RELEASES)
    .all<{ kind: string; data: string; fetched_at: string }>();
  const found: Snapshots = {};
  for (const row of results) {
    const entry = { data: JSON.parse(row.data), fetchedAt: row.fetched_at };
    if (row.kind === STORIES) found.stories = entry;
    else if (row.kind === PRODUCTION) found.production = entry;
    else if (row.kind === IN_DEV) found.inDev = entry;
    else if (row.kind === "delivery") found.delivery = entry;
    else found.releases = entry;
  }
  return found;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function buildCard(project: Project, found: Snapshots, role: Role, now = Date.now()): ProjectCard {
  const base = `/projects/${project.repo}`;
  const config = project.check?.config;
  const rules = cycleRules(config);
  const stories = found.stories?.data ?? [];
  const status = found.production?.data ?? null;
  const onInt = new Set((status?.groups ?? []).flatMap((group) => group.issues));
  const stages = stagesOf(stories, rules, onInt);
  const count = (stage: string) => [...stages.values()].filter((value) => value === stage).length;
  const tiles: Tile[] = [];

  if (config?.branches?.integration) {
    const known = new Set(stories.filter((story) => !isEpic(story)).map((story) => story.number));
    const testing = [...onInt].filter((number) => known.has(number)).length;
    const changes = (status?.waiting ?? []).reduce((total, release) => total + release.changes.length, 0);
    const oldest = (status?.groups ?? [])
      .map((group) => group.mergedAt)
      .filter((date): date is string => Boolean(date))
      .sort()[0];
    tiles.push({
      key: "to_test",
      label: "To test on int",
      value: status ? String(testing) : "…",
      detail: status ? `${plural(changes, "change")}${oldest ? `, since ${oldest.slice(0, 10)}` : ""}` : "not read yet",
      tone: testing ? "warn" : null,
      path: `${base}/to-test`,
    });
    tiles.push({
      key: "production",
      label: "Production",
      value: !status ? "…" : status.aheadBy === 0 ? "Up to date" : status.ready ? "Ready" : "Not ready",
      detail: !status ? null : status.aheadBy === 0 ? null : status.ready ? `${plural(status.aheadBy, "commit")} waiting` : (status.blockers[0]?.text ?? null),
      tone: !status ? null : status.aheadBy === 0 || status.ready ? "ok" : "alert",
      path: `${base}/production`,
    });
  } else {
    // No integration branch: the stories merged and still open are
    // validated in production, from To test.
    const toValidate = count("to_validate");
    tiles.push({
      key: "to_test",
      label: "To validate",
      value: String(toValidate),
      detail: toValidate ? "merged, criteria to check in production" : "nothing merged waits",
      tone: toValidate ? "warn" : null,
      path: `${base}/to-test`,
    });
  }

  // Stories in development by their stage, and those the working branches
  // read for In development refer to.
  const inDev = found.inDev?.data;
  const stalled = inDev ? inDev.items.filter((item) => isStalled(item, now)).length : 0;
  const developing = new Set([...stages].filter(([, stage]) => stage === "in_dev").map(([number]) => number));
  for (const item of inDev?.items ?? []) {
    for (const number of item.stories) if (stages.has(number) && !["done", "on_int", "to_validate"].includes(stages.get(number) ?? "")) developing.add(number);
  }
  tiles.push({
    key: "in_dev",
    label: "In development",
    value: String(developing.size),
    detail: stalled ? `${stalled} stalled` : inDev ? plural(inDev.items.length, "branch", "branches") : null,
    tone: stalled ? "alert" : null,
    path: `${base}/in-development`,
  });
  tiles.push({ key: "ready", label: "Ready to start", value: String(count("ready")), detail: `${count("backlog")} not ready`, tone: null, path: `${base}/backlog` });

  const top = rules.priorities[0];
  if (top) {
    const waiting = stories.filter((story) => {
      const stage = stages.get(story.number);
      return (stage === "backlog" || stage === "ready") && priorityOf(story, rules) === top;
    });
    tiles.push({
      key: "top_priority",
      label: `${top} in the backlog`,
      value: String(waiting.length),
      detail: `${waiting.filter((story) => stages.get(story.number) === "ready").length} ready`,
      tone: null,
      path: `${base}/backlog`,
    });
  }

  const production = productionBranch(project);
  const ciRun = (found.delivery?.data.runs ?? []).find((run) => run.workflow === "ci" && run.branch === production);
  if (typeof config?.workflows?.["ci"] === "string") {
    tiles.push({
      key: "ci",
      label: `CI on ${production ?? "production"}`,
      value: !ciRun ? "…" : ciRun.result === "success" ? "Passed" : ciRun.result === "failure" ? "Failed" : ciRun.result === "running" ? "Running" : "Other",
      detail: ciRun ? ciRun.startedAt.slice(0, 16).replace("T", " ") : "not read yet",
      tone: !ciRun ? null : ciRun.result === "success" ? "ok" : ciRun.result === "failure" ? "alert" : "warn",
      path: `${base}/delivery`,
    });
  }

  const versions = status?.versions ?? [];
  if (versions.length) {
    tiles.push({
      key: "versions",
      label: "Versions",
      value: versions.map((version) => version.version ?? "?").join(" / "),
      detail: versions.map((version) => version.environment).join(" / "),
      tone: null,
      path: `${base}/production`,
    });
  }
  const release = (found.releases?.data.releases ?? []).find((candidate) => !candidate.upcoming);
  if (release) {
    tiles.push({
      key: "release",
      label: "Last release",
      value: release.version,
      detail: `${release.date}${release.title ? ` · ${release.title}` : ""}`,
      tone: null,
      path: `${base}/releases`,
    });
  }

  const order = ORDER[role];
  tiles.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  // Snapshots marked stale by a webhook carry 1970: not a reading date.
  const dates = [found.stories, found.production, found.inDev]
    .map((entry) => entry?.fetchedAt)
    .filter((date): date is string => Boolean(date) && !date?.startsWith("1970"))
    .sort();
  const productionAge = found.production ? now - Date.parse(found.production.fetchedAt) : Infinity;
  return {
    project,
    tiles,
    readAt: dates[0] ?? null,
    stale: Boolean(config?.branches?.integration) && productionAge > STALE_MS,
  };
}

export async function projectCard(db: D1Database, project: Project, role: Role): Promise<ProjectCard> {
  return buildCard(project, await readSnapshots(db, project.repo), role);
}
