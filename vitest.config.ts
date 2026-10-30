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
          miniflare: {
            compatibilityDate: "2025-10-01",
            compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
            bindings: {
              COMMIT_SHA: "test-commit",
              SUPER_ADMINS: "Admin-One, @admin-two",
              GITHUB_APP_CLIENT_ID: "Iv1.test-client",
              GITHUB_APP_CLIENT_SECRET: "test-client-secret",
              GITHUB_APP_PRIVATE_KEY: appKey.privateKey,
              GITHUB_APP_WEBHOOK_SECRET: "test-webhook-secret",
              TEST_APP_PUBLIC_KEY: appKey.publicKey,
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
