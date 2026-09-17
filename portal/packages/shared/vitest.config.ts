import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireExecutedTests } from "./src/testing/require-executed-tests.ts";
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from "./src/testing/vitest-timeouts.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    reporters: ["default", requireExecutedTests("packages/shared/vitest.config.ts")],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
