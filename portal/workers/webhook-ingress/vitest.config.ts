import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../packages/shared/src/testing/require-executed-tests.ts";
import { CI_HOOK_TIMEOUT_MS, CI_TEST_TIMEOUT_MS } from "../../packages/shared/src/testing/ci-timeouts.ts";

export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), test: { reporters: ["default", requireExecutedTests("workers/webhook-ingress/vitest.config.ts")], testTimeout: CI_TEST_TIMEOUT_MS, hookTimeout: CI_HOOK_TIMEOUT_MS, environment: "node", include: ["test/**/*.test.ts"] } });
