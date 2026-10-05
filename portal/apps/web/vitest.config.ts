import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../packages/shared/src/testing/require-executed-tests.ts";
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../../packages/shared/src/testing/vitest-timeouts.ts";

// Two projects in one config so `vitest run <path>` finds a unit test (`*.test.ts`) and a DOM
// test (`*.dom.test.tsx`) alike. Before, DOM tests lived in a second config and a path filter
// against the first one reported "No test files found".
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    reporters: ["default", requireExecutedTests("apps/web/vitest.config.ts")],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          server: { deps: { inline: [/@excalidraw/, /open-color/] } },
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["src/**/*.dom.test.tsx"],
          // Fails any test that opens a real network connection — see the file's own header (#167).
          setupFiles: ["./src/testing/no-unmocked-fetch.ts"],
        },
      },
    ],
  },
});
