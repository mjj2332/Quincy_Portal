import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../shared/src/testing/require-executed-tests.ts";
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../shared/src/testing/vitest-timeouts.ts";

export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), test: { reporters: ["default", requireExecutedTests("packages/db/vitest.config.ts")], testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS, environment: "node", include: ["src/**/*.test.ts", "test/**/*.test.ts"] } });
