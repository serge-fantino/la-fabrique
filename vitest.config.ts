import { generateKeyPairSync } from "node:crypto";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// A throwaway key in GitHub's own PKCS#1 format, so no private key is committed.
const appKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          // One runtime for every file, run one after another; storage is
          // still reset between tests. Without it, the pool starts one
          // workerd per test file, all at once: on the CI runner one of
          // them sometimes dies ("fetch failed: other side closed") and its
          // file's results are lost, which failed the deploy with no test
          // failing. Measured locally: 63 s instead of 59 s.
          singleWorker: true,
          miniflare: {
            compatibilityDate: "2025-10-01",
            compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
            // Tests run Claude's jobs themselves (worker.queue): the jobs
            // they send go to a queue nobody consumes. Delivered, they would
            // reach queue() in the middle of a later file (the single runtime
            // lives longer than the queue's minute) and write to D1 while its
            // storage is being reset ("Isolated storage failed").
            queueProducers: { CLAUDE_QUEUE: "la-fabrique-claude-tests" },
            queueConsumers: { "la-fabrique-claude": { maxBatchSize: 100, maxBatchTimeout: 60, maxRetries: 0 } },
            bindings: {
              COMMIT_SHA: "test-commit",
              SUPER_ADMINS: "Admin-One, @admin-two",
              GITHUB_APP_CLIENT_ID: "Iv1.test-client",
              GITHUB_APP_CLIENT_SECRET: "test-client-secret",
              GITHUB_APP_PRIVATE_KEY: appKey.privateKey,
              GITHUB_APP_WEBHOOK_SECRET: "test-webhook-secret",
              ANTHROPIC_API_KEY: "sk-ant-test",
              CLAUDE_MODEL: "claude-opus-5-5",
              CLAUDE_DAILY_CALLS: "3",
              CLAUDE_MONTHLY_BUDGET_USD: "1",
              TEST_APP_PUBLIC_KEY: appKey.publicKey,
              TEST_MIGRATIONS: migrations,
              // On main (CI and deploy), a release-notes entry must be
              // numbered and dated; on a branch it may still be "next".
              TEST_ON_MAIN: process.env["GITHUB_REF_NAME"] === "main" ? "1" : "",
            },
          },
        },
      },
    },
  };
});
