import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  COMMIT_SHA: string;
  SUPER_ADMINS?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  // Claude in La Fabrique: the API key is a secret of the Worker, never shown;
  // the model and the quotas are plain variables (wrangler.jsonc).
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_DAILY_CALLS?: string;
  CLAUDE_MONTHLY_BUDGET_USD?: string;
  // Claude works in the background: the queue of its jobs, and the object
  // per card that pushes their progress to the open pages.
  CLAUDE_QUEUE?: Queue<{ job: number }>;
  CARD_LIVE?: DurableObjectNamespace<import("./live").CardLive>;
  // The sprint that runs by itself: one object per project (src/sprint-run.ts).
  SPRINT_RUN?: DurableObjectNamespace<import("./sprint-run").SprintRun>;
  // Set on each request: the OAuth library's store (in D1) and its helpers.
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}
