import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_APP_PUBLIC_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
    TEST_ON_MAIN: string;
  }
}
