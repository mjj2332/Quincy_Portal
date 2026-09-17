import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireExecutedTests } from "./src/testing/require-executed-tests.ts";
import { CI_HOOK_TIMEOUT_MS, CI_TEST_TIMEOUT_MS } from "./src/testing/ci-timeouts.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    reporters: ["default", requireExecutedTests("packages/shared/vitest.config.ts")],
    testTimeout: CI_TEST_TIMEOUT_MS,
    hookTimeout: CI_HOOK_TIMEOUT_MS,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
