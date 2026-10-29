import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2025-10-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            COMMIT_SHA: "test-commit",
          },
        },
      },
    },
  },
});
