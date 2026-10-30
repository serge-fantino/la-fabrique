import { effectiveRole } from "./accounts";
import { DEFECT_LABEL, defectTargets, isKnownStory, storiesOnIntOf } from "./defect-targets";
import { activityStatement } from "./activity-log";
import { randomToken } from "./crypto";
import type { Env } from "./env";
import { githubPost, installationToken } from "./github-app";
import { json } from "./http";
import type { GrantProps } from "./oauth";
import { readVersion } from "./production";
import type { Environment, FabriqueConfig } from "./fabrique-config";
import { checkOtherBranch, findProject, type Project } from "./projects";
import { can } from "./rights";
import { applyIssueEvent, type RestIssue } from "./stories";
import { wordingFor } from "./wording";

export { DEFECT_LABEL };

// A defect sent by a project's app in the name of the person using it
// (contract with L'épicerie extraordinaire, la-fabrique#65).

export const DEFECT_ROUTE = /^\/api\/projects\/([^/]+)\/defects$/;
export const TARGETS_ROUTE = /^\/api\/projects\/([^/]+)\/targets$/;
// Reports a day per account and project, from La Fabrique or an app.
export const DAILY_CAP = 20;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
// Base64 makes a screenshot a third larger; the rest of a report is small.
const BODY_MAX_BYTES = 3 * 1024 * 1024;
const PART_BYTES = 500 * 1024;
export const TRIAGE_LABEL = "to triage";
export const SCREENSHOT_ROUTE = /^\/screenshots\/([A-Za-z0-9_-]{20,})\.(png|jpg)$/;

export interface DefectReport {
  title: string;
  seen: string;
  expected: string;
  environment: string;
  version: string;
  deployment: string;
  page: string;
  component: { selector: string; text: string; box: { x: number; y: number; w: number; h: number } | null } | null;
  viewport: { w: number; h: number; dpr: number } | null;
  userAgent: string;
  errors: string[];
  screenshot: { type: "image/png" | "image/jpeg"; bytes: Uint8Array } | null;
  // What it is about, chosen by the reporter among the targets: a story,
  // a version (release note), or neither.
  story: number | null;
  release: string | null;
  // The change chosen in that version's release note: its index.
  change: number | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeScreenshot(value: unknown): DefectReport["screenshot"] | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "invalid";
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) return "invalid";
  let binary: string;
  try {
    binary = atob((match[2] ?? "").replace(/\s/g, ""));
  } catch {
    return "invalid";
  }
  if (binary.length > SCREENSHOT_MAX_BYTES) return "invalid";
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const type = match[1] as "image/png" | "image/jpeg";
  // The bytes must be what the address says.
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((type === "image/png" && !png) || (type === "image/jpeg" && !jpeg)) return "invalid";
  return { type, bytes };
}

// The report as the contract gives it; the fields that are wrong, if any.
export function readReport(data: unknown): { report: DefectReport } | { invalid: string[] } {
  if (!isObject(data)) return { invalid: ["body"] };
  const invalid: string[] = [];
  const title = text(data["title"], 200);
  const seen = text(data["seen"], 4000);
  const environment = text(data["environment"], 40);
  if (!title) invalid.push("title");
  if (!seen) invalid.push("seen");
  if (!environment) invalid.push("environment");
  const page = text(data["page"], 500);
  if (page && !page.startsWith("/")) invalid.push("page");

  let component: DefectReport["component"] = null;
  if (data["component"] !== undefined && data["component"] !== null) {
    const raw = data["component"];
    if (!isObject(raw)) invalid.push("component");
    else {
      const box = isObject(raw["box"]) ? raw["box"] : null;
      const values = box ? [number(box["x"]), number(box["y"]), number(box["w"]), number(box["h"])] : null;
      component = {
        selector: text(raw["selector"], 300),
        text: text(raw["text"], 300),
        box: values && values.every((value) => value !== null)
          ? { x: values[0] ?? 0, y: values[1] ?? 0, w: values[2] ?? 0, h: values[3] ?? 0 }
          : null,
      };
    }
  }

  let viewport: DefectReport["viewport"] = null;
  if (data["viewport"] !== undefined && data["viewport"] !== null) {
    const raw = data["viewport"];
    const w = isObject(raw) ? number(raw["w"]) : null;
    const h = isObject(raw) ? number(raw["h"]) : null;
    if (w === null || h === null) invalid.push("viewport");
    else viewport = { w, h, dpr: (isObject(raw) ? number(raw["dpr"]) : null) ?? 1 };
  }

  const rawErrors = data["errors"];
  if (rawErrors !== undefined && rawErrors !== null && !Array.isArray(rawErrors)) invalid.push("errors");
  const errors = Array.isArray(rawErrors)
    ? rawErrors.filter((error): error is string => typeof error === "string").slice(0, 20).map((error) => error.slice(0, 1000))
    : [];

  const screenshot = decodeScreenshot(data["screenshot"]);
  if (screenshot === "invalid") invalid.push("screenshot");

  const rawStory = data["story"];
  const story = rawStory === undefined || rawStory === null ? null : Number.isInteger(rawStory) && (rawStory as number) > 0 ? (rawStory as number) : NaN;
  if (Number.isNaN(story)) invalid.push("story");
  const rawRelease = data["release"];
  if (rawRelease !== undefined && rawRelease !== null && (typeof rawRelease !== "string" || rawRelease.length > 40)) invalid.push("release");
  const rawChange = data["change"];
  const change = rawChange === undefined || rawChange === null ? null : Number.isInteger(rawChange) && (rawChange as number) >= 0 && (rawChange as number) < 100 ? (rawChange as number) : NaN;
  if (Number.isNaN(change)) invalid.push("change");

  if (invalid.length) return { invalid };
  return {
    report: {
      title,
      seen,
      expected: text(data["expected"], 4000),
      environment,
      version: text(data["version"], 60),
      deployment: text(data["deployment"], 60),
      page,
      component,
      viewport,
      userAgent: text(data["user_agent"], 400),
      errors,
      screenshot: screenshot === "invalid" ? null : screenshot,
      story: Number.isNaN(story) ? null : story,
      release: typeof rawRelease === "string" && rawRelease.trim() ? rawRelease.trim() : null,
      change: Number.isNaN(change) ? null : change,
    },
  };
}

// Inline code in Markdown: no backtick can close it early.
function code(value: string): string {
  return `\`${value.replace(/`/g, "'").replace(/\s+/g, " ")}\``;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

export function defectBody(
  project: Project,
  report: DefectReport,
  context: {
    login: string;
    app: string | null;
    environmentUrl: string;
    story: number | null;
    onInt: number[];
    screenshotUrl: string | null;
    triage: boolean;
    release?: { version: string; title: string | null; change?: string | null } | null;
  },
): string {
  const words = wordingFor(project);
  const rows = words.contextRows;
  const lines: [string, string][] = [];
  lines.push([rows.environment, `${code(report.environment)} (${context.environmentUrl})`]);
  if (report.version || report.deployment) {
    lines.push([rows.version, [report.version && code(report.version), report.deployment && `${words.deployment} ${code(report.deployment)}`].filter(Boolean).join(" · ")]);
  }
  if (report.page) {
    let address: string | null = null;
    try {
      const url = new URL(report.page, context.environmentUrl);
      if (url.origin === new URL(context.environmentUrl).origin) address = url.href;
    } catch {
      address = null;
    }
    lines.push([rows.page, address ? `[${cell(report.page).replace(/[[\]]/g, "")}](${address.replace(/\)/g, "%29")})` : code(report.page)]);
  }
  if (report.component) {
    const { selector, text: label, box } = report.component;
    lines.push([
      rows.component,
      [selector && code(selector), label && `« ${cell(label)} »`, box && `(${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.w)} × ${Math.round(box.h)})`]
        .filter(Boolean)
        .join(" "),
    ]);
  }
  if (report.viewport) lines.push([rows.viewport, `${report.viewport.w} × ${report.viewport.h} @${report.viewport.dpr}x`]);
  if (report.userAgent) lines.push([rows.userAgent, code(report.userAgent)]);

  const parts = [
    [
      words.appDefectIntro(report.environment, context.story),
      context.release ? words.aboutRelease(context.release.version, context.release.title) : "",
      context.story === null && !context.release && context.onInt.length ? words.onIntThen(context.onInt) : "",
    ]
      .filter(Boolean)
      .join(" "),
    ...(context.release?.change ? [`> ${context.release.change.replace(/\s+/g, " ")}`] : []),
    `## ${words.saw}\n\n${report.seen}`,
    `## ${words.expected}\n\n${report.expected || "—"}`,
    `## ${words.context}\n\n| | |\n|---|---|\n${lines.map(([label, value]) => `| ${label} | ${value} |`).join("\n")}`,
  ];
  if (report.errors.length) {
    parts.push(`### ${words.errors}\n\n\`\`\`text\n${report.errors.join("\n").replace(/```/g, "'''")}\n\`\`\``);
  }
  if (context.screenshotUrl) parts.push(`### ${words.screenshot}\n\n![${words.screenshot}](${context.screenshotUrl})`);
  if (context.triage) parts.push(words.toTriage(context.login));
  parts.push(`---\n${words.appDefectSignature(context.login, context.app)}`);
  return parts.join("\n\n");
}

async function storeScreenshot(env: Env, repo: string, login: string, screenshot: NonNullable<DefectReport["screenshot"]>): Promise<string> {
  const id = randomToken(24);
  const statements = [
    env.DB.prepare("INSERT INTO screenshots (id, repo, reporter, content_type, size) VALUES (?, ?, ?, ?, ?)").bind(
      id,
      repo,
      login,
      screenshot.type,
      screenshot.bytes.byteLength,
    ),
  ];
  for (let start = 0, part = 0; start < screenshot.bytes.byteLength; start += PART_BYTES, part++) {
    statements.push(
      env.DB.prepare("INSERT INTO screenshot_parts (screenshot_id, part, data) VALUES (?, ?, ?)").bind(
        id,
        part,
        screenshot.bytes.slice(start, start + PART_BYTES).buffer,
      ),
    );
  }
  await env.DB.batch(statements);
  return `${id}.${screenshot.type === "image/png" ? "png" : "jpg"}`;
}

// The screenshot behind the address the issue links to.
export async function serveScreenshot(env: Env, id: string, extension: string): Promise<Response | null> {
  const row = await env.DB.prepare("SELECT content_type FROM screenshots WHERE id = ?").bind(id).first<{ content_type: string }>();
  if (!row || (row.content_type === "image/png") !== (extension === "png")) return null;
  const { results } = await env.DB.prepare("SELECT data FROM screenshot_parts WHERE screenshot_id = ? ORDER BY part")
    .bind(id)
    .all<{ data: ArrayBuffer | number[] }>();
  const chunks = results.map((part) => new Uint8Array(part.data));
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    headers: {
      "content-type": row.content_type,
      "cache-control": "public, max-age=86400, immutable",
      "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

// An environment is declared by the branch deployed on it: int runs the
// integration branch, whose `.fabrique.json` may open reporting before it
// reaches production. An environment production declares as production
// stays closed whatever the other branch says.
export async function integrationConfig(env: Env, project: Project): Promise<FabriqueConfig | null> {
  const integration = project.check?.config?.branches?.integration;
  if (!integration) return null;
  const branch = await checkOtherBranch(env, project, integration);
  return branch.ok ? branch.check.config : null;
}

export async function reportingEnvironments(env: Env, project: Project, onIntegration?: FabriqueConfig | null): Promise<Record<string, Environment>> {
  const production = project.check?.config;
  const declared = { ...(production?.environnements ?? {}) };
  const integration = onIntegration === undefined ? await integrationConfig(env, project) : onIntegration;
  for (const [name, environment] of Object.entries(integration?.environnements ?? {})) {
    if (declared[name]?.type !== "production") declared[name] = environment;
  }
  return Object.fromEntries(
    Object.entries(declared).filter(([, environment]) => environment.signalement && environment.type !== "production"),
  );
}

function startOfDay(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function failure(status: number, error: string, message: string, extra: Json = {}): Response {
  return json({ error, message, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

export async function reportDefectFromApp(request: Request, env: Env, props: GrantProps, projectParam: string): Promise<Response> {
  let wanted: string;
  try {
    wanted = decodeURIComponent(projectParam);
  } catch {
    wanted = "";
  }
  const project = await findProject(env.DB, props.repo);
  if (!project || wanted.toLowerCase() !== props.repo.slice(props.repo.indexOf("/") + 1).toLowerCase()) {
    return failure(403, "no_access", "This connection reports on another project.");
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > BODY_MAX_BYTES) return failure(400, "invalid", "The report is too large.", { fields: ["screenshot"] });
  let data: unknown;
  try {
    const body = await request.text();
    if (body.length > BODY_MAX_BYTES) return failure(400, "invalid", "The report is too large.", { fields: ["screenshot"] });
    data = JSON.parse(body);
  } catch {
    return failure(400, "invalid", "The report is not JSON.", { fields: ["body"] });
  }
  const read = readReport(data);
  if ("invalid" in read) return failure(400, "invalid", `Missing or invalid: ${read.invalid.join(", ")}.`, { fields: read.invalid });
  const report = read.report;

  const role = await effectiveRole(env, props.login);
  if (!can(role, "report_defect")) return failure(403, "no_access", "This account cannot report defects.");

  // Reporting only from an environment the project opens to it, which
  // says it is that environment.
  const environment = (await reportingEnvironments(env, project))[report.environment];
  if (!environment) return failure(403, "reporting_disabled", `Reporting is off on ${report.environment}.`);
  const deployed = environment.version ? await readVersion(report.environment, environment.url, environment.version) : null;
  if (deployed?.answers !== report.environment || deployed.answers === "production") {
    return failure(403, "reporting_disabled", `${environment.url} does not say it is ${report.environment}.`);
  }

  const today = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM activity_log WHERE actor = ? AND repo = ? AND action = 'defect_reported' AND occurred_at >= ?",
  )
    .bind(props.login, project.repo, startOfDay())
    .first<{ count: number }>();
  if ((today?.count ?? 0) >= DAILY_CAP) {
    return failure(429, "daily_cap", `At most ${DAILY_CAP} reports a day on this project: try again tomorrow.`);
  }

  // The story the reporter chose, else the only one on int when the
  // reporter did not say.
  if (report.story !== null && !(await isKnownStory(env, project, report.story))) {
    return failure(400, "invalid", `Story #${report.story} is not one of this project's stories.`, { fields: ["story"] });
  }
  const triage = role === null;
  const targets = await defectTargets(env, project);
  const onInt = storiesOnIntOf(targets);
  // A change of a version that declares a single story is about that story.
  const target = report.release ? targets.find((candidate) => candidate.version === report.release) : undefined;
  const change = target && report.change !== null ? (target.changes[report.change] ?? null) : null;
  const story =
    report.story ??
    (report.release === null
      ? onInt.length === 1 ? (onInt[0] ?? null) : null
      : change && target?.stories.length === 1 ? (target.stories[0]?.number ?? null) : null);
  const release = report.release ? { version: report.release, title: target?.title ?? null, change } : null;
  const screenshot = report.screenshot ? await storeScreenshot(env, project.repo, props.login, report.screenshot) : null;
  const screenshotUrl = screenshot ? new URL(`/screenshots/${screenshot}`, request.url).href : null;
  const body = defectBody(project, report, {
    login: props.login,
    app: props.app ?? null,
    environmentUrl: environment.url,
    story,
    onInt,
    screenshotUrl,
    triage,
    release,
  });

  let created: RestIssue;
  try {
    // Written by La Fabrique's App (an app's token is never a GitHub
    // token); the issue says who reported it.
    const token = await installationToken(env, project.installationId);
    const response = await githubPost(token, `/repos/${project.repo}/issues`, {
      title: report.title,
      body,
      labels: triage ? [DEFECT_LABEL, TRIAGE_LABEL] : [DEFECT_LABEL],
    });
    if (!response.ok) return failure(502, "github", `GitHub refused the issue (HTTP ${response.status}).`);
    created = (await response.json()) as RestIssue;
    if (story) {
      await githubPost(token, `/repos/${project.repo}/issues/${story}/comments`, {
        body: wordingFor(project).defectOnStory(props.login, created.number),
      });
    }
    await applyIssueEvent(env, project.repo, "opened", created);
  } catch (error) {
    return failure(502, "github", error instanceof Error ? error.message : String(error));
  }

  await activityStatement(env.DB, {
    actor: props.login,
    action: "defect_reported",
    repo: project.repo,
    ...(story ? { issueNumber: story } : {}),
    details: {
      defect: created.number,
      title: report.title,
      version: report.version || null,
      environment: report.environment,
      via: props.app ?? "app",
      triage,
      ...(report.release ? { release: report.release } : {}),
      ...(change ? { change: change.slice(0, 500) } : {}),
      ...(screenshot ? { screenshot } : {}),
    },
  }).run();

  return json(
    { issue: { number: created.number, url: created.html_url }, story: story ? { number: story } : null, triage },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

// What a report can be about: the versions on int, then those released,
// each with its stories (GET /api/projects/{project}/targets).
export async function defectTargetsForApp(env: Env, props: GrantProps, projectParam: string): Promise<Response> {
  let wanted: string;
  try {
    wanted = decodeURIComponent(projectParam);
  } catch {
    wanted = "";
  }
  const project = await findProject(env.DB, props.repo);
  if (!project || wanted.toLowerCase() !== props.repo.slice(props.repo.indexOf("/") + 1).toLowerCase()) {
    return failure(403, "no_access", "This connection reports on another project.");
  }
  return json({ versions: await defectTargets(env, project) }, { headers: { "cache-control": "no-store" } });
}
