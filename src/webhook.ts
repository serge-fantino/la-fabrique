import { promotionRunEvent } from "./go";
import { mergeRunEvent } from "./sprint-pulls";
import { claudeRunEvent, type RestWorkflowRun } from "./claude";
import { sprintLiveFor } from "./live";
import { safeEqual } from "./crypto";
import type { Env } from "./env";
import { json } from "./http";
import { activityChanged } from "./activity";
import { branchesChanged } from "./branches";
import { inDevChanged } from "./in-dev";
import { deliveryChanged } from "./delivery";
import { productionChanged } from "./production";
import { branchKind, checkPushedCommit, findProject } from "./projects";
import { markStale } from "./snapshots";
import { applyIssueEvent, storiesChanged, type RestIssue } from "./stories";

async function signatureOf(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

interface Payload {
  action?: string;
  ref?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  repository?: { full_name?: string; default_branch?: string };
  head_commit?: { timestamp?: string } | null;
  issue?: RestIssue;
  workflow_run?: RestWorkflowRun;
}

const STORY_EVENTS = new Set(["sub_issues", "pull_request", "create", "delete"]);

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return json({ error: "webhook not configured" }, { status: 503 });

  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!safeEqual(signature, await signatureOf(env.GITHUB_APP_WEBHOOK_SECRET, body))) {
    return json({ error: "bad signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") return json({ ok: true });

  const payload = JSON.parse(body) as Payload;
  const repo = payload.repository?.full_name;
  const project = repo ? await findProject(env.DB, repo) : null;
  if (!project) return json({ ignored: "unknown project" }, { status: 202 });

  if (event === "issues" && payload.issue) {
    await applyIssueEvent(env, project.repo, payload.action ?? "", payload.issue);
    return json({ updated: payload.issue.number });
  }
  if (STORY_EVENTS.has(event)) {
    await storiesChanged(env, project.repo);
    // A pull request moved: the open sprint pages show it.
    if (event === "pull_request") {
      await sprintLiveFor(env, project.repo)?.notify({ kind: "pull_request", issue: null, status: payload.action ?? "", conclusion: null, url: "", at: new Date().toISOString() });
    }
    await inDevChanged(env, project.repo);
    if (event === "create" || event === "delete") await branchesChanged(env, project.repo);
    return json({ refresh: "stories" });
  }
  if (event === "workflow_run") {
    // A run of the Claude workflow: the sprint follows it.
    if (payload.workflow_run) await claudeRunEvent(env, project, payload.action ?? "", payload.workflow_run);
    // The promotion done: the stories validated on int are shipped.
    if (payload.workflow_run) await promotionRunEvent(env, project, payload.action ?? "", payload.workflow_run).catch(() => []);
    // A merge run: merged, or refused and why.
    if (payload.workflow_run) await mergeRunEvent(env, project, payload.action ?? "", payload.workflow_run).catch(() => false);
    await productionChanged(env, project.repo);
    await deliveryChanged(env, project.repo);
    await inDevChanged(env, project.repo);
    return json({ refresh: "production" });
  }
  if (event !== "push") return json({ ignored: event }, { status: 202 });
  await productionChanged(env, project.repo);
  await activityChanged(env, project.repo);
  await inDevChanged(env, project.repo);
  if (payload.created || payload.deleted) await branchesChanged(env, project.repo);

  const branch = payload.ref?.startsWith("refs/heads/") ? payload.ref.slice("refs/heads/".length) : null;
  const sha = payload.after;
  if (!branch || !sha || /^0+$/.test(sha)) return json({ ignored: "push" }, { status: 202 });
  await markStale(env.DB, project.repo, branchKind(branch));

  const production = project.check?.config?.branches?.production ?? payload.repository?.default_branch;
  if (branch !== production) return json({ ignored: "not the production branch" }, { status: 202 });

  const outcome = await checkPushedCommit(env, project, branch, {
    sha,
    committedAt: payload.head_commit?.timestamp ?? null,
  });
  return outcome.ok
    ? json({ checked: sha, errors: outcome.check.errors.length })
    : json({ error: outcome.message }, { status: 502 });
}
