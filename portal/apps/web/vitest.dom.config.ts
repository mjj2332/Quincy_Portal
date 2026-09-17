import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../packages/shared/src/testing/require-executed-tests.ts";
import { CI_HOOK_TIMEOUT_MS, CI_TEST_TIMEOUT_MS } from "../../packages/shared/src/testing/ci-timeouts.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    reporters: ["default", requireExecutedTests("apps/web/vitest.dom.config.ts")],
    testTimeout: CI_TEST_TIMEOUT_MS,
    hookTimeout: CI_HOOK_TIMEOUT_MS,
    environment: "happy-dom",
    include: ["src/**/*.dom.test.tsx"],
    // Fails any test that opens a real network connection — see the file's own header (#167).
    setupFiles: ["./src/testing/no-unmocked-fetch.ts"],
  },
});
