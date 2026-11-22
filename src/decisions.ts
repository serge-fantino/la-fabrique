import { repositoryFiles } from "./components";
import type { Env } from "./env";
import { githubFetch, GitHubError, installationToken } from "./github-app";
import type { ConfigCheck, Project } from "./projects";
import { githubContentsPath } from "./urls";

// A project's decisions (ADRs, epic F15): one Markdown file each, in the
// folder its `.fabrique.json` declares (`decisions.dossier`), or found in the
// usual places. La Fabrique reads them at the commit it reads the project at
// and keeps nothing but the cache of what it read, like the documentation.
//
// The format is the common one (docs/decisions/0000-template.md, and the one
// of BeExtraordinary/Armagedon-Project): `NNNN-slug.md`, a title
// `# NNNN. Title`, then a list of fields before the first section:
// `- Status: …`, `- Date: …`, `- Deciders: login, login`, optionally
// `- Serves: #74, C12`. A `## Status` section (Nygard's format) is read too.

export const STATUSES = ["proposed", "accepted", "rejected", "superseded", "deprecated"] as const;
export type DecisionStatus = (typeof STATUSES)[number] | "unknown";

export const STATUS_LABELS: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
  deprecated: "Deprecated",
  unknown: "No status",
};

// Where a project keeps its decisions when it does not say.
export const USUAL_FOLDERS = ["docs/adr", "docs/decisions", "docs/architecture/decisions", "adr", "decisions"];

const FILE = /^(\d{3,5})-[\w.-]+\.md$/;
const MAX_DECISIONS = 300;

export interface Decision {
  // "0003": the number as the file writes it.
  number: string;
  path: string;
  title: string;
  status: DecisionStatus;
  // The status line as written ("Accepted, amended by 0055").
  statusText: string | null;
  date: string | null;
  deciders: string[];
  // The issues (#74) and cards (C12) it says it serves, or names anywhere.
  issues: number[];
  cards: number[];
  // The other decisions it names (ADR 0033, a link to 0033-….md), by number.
  mentions: string[];
}

const LOGIN = /^@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;

function statusOf(text: string | null): DecisionStatus {
  if (!text) return "unknown";
  const first = text.toLowerCase().match(/[a-z]+/)?.[0] ?? "";
  if ((STATUSES as readonly string[]).includes(first)) return first as DecisionStatus;
  // French, for projects that write their decisions in French.
  const french: Record<string, DecisionStatus> = { propos: "proposed", accept: "accepted", adopt: "accepted", refus: "rejected", rejet: "rejected", remplac: "superseded", obsol: "deprecated" };
  const found = Object.entries(french).find(([stem]) => first.startsWith(stem));
  return found ? found[1] : "unknown";
}

// The number as the index writes it: at least four digits.
export function decisionNumber(value: string | number): string {
  return String(Number(value)).padStart(4, "0");
}

// One decision file, read: what it says of itself. Never fails: a file
// without a title or a status is still a decision, said as such.
export function parseDecision(path: string, markdown: string): Decision | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = name.match(FILE);
  if (!match || Number(match[1]) === 0 || /template/i.test(name)) return null;
  const number = decisionNumber(match[1] ?? "0");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const titleLine = lines.find((line) => /^#\s+\S/.test(line));
  const title =
    titleLine
      ?.replace(/^#\s+/, "")
      .replace(/^(ADR[-\s]?)?\d{1,5}\s*[.:·—–-]\s*/i, "")
      .trim() || name.replace(/\.md$/, "").replace(/^\d+-/, "").replace(/-/g, " ");
  // The fields: the lines before the first section.
  const firstSection = lines.findIndex((line) => /^##\s/.test(line));
  const head = lines.slice(0, firstSection === -1 ? lines.length : firstSection);
  const field = (names: string[]): string | null => {
    for (const line of head) {
      const found = line.match(/^\s*(?:[-*]\s*)?\**([A-Za-zÀ-ÿ ]+?)\**\s*:\s*\**\s*(.+?)\s*$/);
      if (found && names.includes((found[1] ?? "").trim().toLowerCase())) return (found[2] ?? "").replace(/\*+$/, "").trim() || null;
    }
    return null;
  };
  let statusText = field(["status", "statut"]);
  if (!statusText) {
    // Nygard's format: a `## Status` section, its first line.
    const at = lines.findIndex((line) => /^##\s+(status|statut)\s*$/i.test(line));
    if (at !== -1) statusText = lines.slice(at + 1).find((line) => line.trim() && !/^#/.test(line))?.trim() ?? null;
  }
  const deciders = (field(["deciders", "décideurs", "decideurs"]) ?? "")
    .split(/[,;]|\s+and\s+|\s+et\s+/)
    .map((part) => part.trim().match(LOGIN)?.[1] ?? null)
    .filter((login): login is string => Boolean(login));
  const issues = new Set<number>();
  const cards = new Set<number>();
  const mentions = new Set<string>();
  for (const found of markdown.matchAll(/(?:^|[\s(])#(\d{1,6})\b/g)) issues.add(Number(found[1]));
  for (const found of markdown.matchAll(/\bC(\d{1,5})\b/g)) cards.add(Number(found[1]));
  for (const found of markdown.matchAll(/\bADRs?\s+(\d{3,5})\b/gi)) mentions.add(decisionNumber(found[1] ?? "0"));
  for (const found of markdown.matchAll(/\((?:\.\/)?(\d{3,5})-[\w.-]+\.md(?:#[\w-]*)?\)/g)) mentions.add(decisionNumber(found[1] ?? "0"));
  for (const found of markdown.matchAll(/\b(?:superseded by|amended by|amends|supersedes|replaces|remplacée? par)\s+(\d{3,5})\b/gi)) mentions.add(decisionNumber(found[1] ?? "0"));
  mentions.delete(number);
  return {
    number,
    path,
    title: title.slice(0, 300),
    status: statusOf(statusText),
    statusText: statusText?.slice(0, 400) ?? null,
    date: field(["date"])?.slice(0, 40) ?? null,
    deciders: deciders.slice(0, 20),
    issues: [...issues].sort((a, b) => a - b).slice(0, 50),
    cards: [...cards].sort((a, b) => a - b).slice(0, 50),
    mentions: [...mentions].sort(),
  };
}

export interface DecisionsView {
  // The folder read; null when the project has none.
  folder: string | null;
  // Declared in .fabrique.json, or found in a usual place.
  declared: boolean;
  decisions: Decision[];
  // The folder's open decisions file, if any (open-decisions.md).
  openDecisions: string | null;
  // The folder's index (README.md), if any.
  index: string | null;
  sha: string | null;
}

// Which decisions name this one, by number.
export function mentionedBy(decisions: Decision[], number: string): Decision[] {
  return decisions.filter((decision) => decision.number !== number && decision.mentions.includes(number));
}

// The decisions of a project at the commit of its check (the reference
// branch's when `branch` is given). Every file is read once per commit with
// one installation token; what was read is kept, parsed, for that commit.
export async function loadDecisions(env: Env, project: Project, check: ConfigCheck | null, branch: string | null): Promise<DecisionsView> {
  const declared = check?.config?.decisions?.dossier ?? null;
  const empty = (folder: string | null): DecisionsView => ({ folder, declared: Boolean(declared), decisions: [], openDecisions: null, index: null, sha: check?.commitSha ?? null });
  if (!check) return empty(declared);
  const sha = check.commitSha;
  const files = await repositoryFiles(env, project, branch, sha);
  const inFolder = (folder: string) => [...files].filter((path) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes("/"));
  const folder = declared ?? USUAL_FOLDERS.find((candidate) => inFolder(candidate).some((path) => parseable(path))) ?? null;
  if (!folder) return empty(null);
  const paths = inFolder(folder).filter(parseable).sort().slice(0, MAX_DECISIONS);
  const view: DecisionsView = {
    folder,
    declared: Boolean(declared),
    decisions: [],
    openDecisions: files.has(`${folder}/open-decisions.md`) ? `${folder}/open-decisions.md` : null,
    index: files.has(`${folder}/README.md`) ? `${folder}/README.md` : null,
    sha,
  };
  const key = `:decisions:${folder}`;
  const cached = await env.DB.prepare("SELECT markdown FROM doc_cache WHERE repo = ? AND commit_sha = ? AND path = ?").bind(project.repo, sha, key).first<string>("markdown");
  if (cached !== null) return { ...view, decisions: JSON.parse(cached) as Decision[] };
  if (paths.length) {
    const token = await installationToken(env, project.installationId);
    const read = await Promise.all(
      paths.map(async (path) => {
        const response = await githubFetch(token, githubContentsPath(project.repo, path, sha), "application/vnd.github.raw+json");
        if (!response.ok) throw new GitHubError(response.status, `Could not read ${path}`);
        return parseDecision(path, await response.text());
      }),
    );
    view.decisions = read.filter((decision): decision is Decision => Boolean(decision));
  }
  await env.DB.prepare("INSERT OR REPLACE INTO doc_cache (repo, commit_sha, path, markdown, branch) VALUES (?, ?, ?, ?, ?)")
    .bind(project.repo, sha, key, JSON.stringify(view.decisions), branch)
    .run();
  return view;
}

function parseable(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = name.match(FILE);
  return Boolean(match) && Number(match?.[1]) !== 0 && !/template/i.test(name);
}

// The rows of a decisions index (README.md: `| [0001](0001-….md) | Title | Status |`),
// by number: what the index says of each file, to check it against them.
export function indexRows(markdown: string): Map<string, { file: string; status: string }> {
  const rows = new Map<string, { file: string; status: string }>();
  for (const line of markdown.split("\n")) {
    const found = line.match(/^\|\s*\[(\d{3,5})\]\(([^)]+)\)\s*\|.*\|\s*([^|]+?)\s*\|\s*$/);
    if (found) rows.set(decisionNumber(found[1] ?? "0"), { file: found[2] ?? "", status: found[3] ?? "" });
  }
  return rows;
}
