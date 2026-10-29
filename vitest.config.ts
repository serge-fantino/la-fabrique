import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

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
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              COMMIT_SHA: "test-commit",
              SUPER_ADMINS: "Admin-One, @admin-two",
              GITHUB_APP_CLIENT_ID: "Iv1.test-client",
              GITHUB_APP_CLIENT_SECRET: "test-client-secret",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
