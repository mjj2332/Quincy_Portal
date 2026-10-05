/**
 * Two-project harness for the per-project rule in `require-executed-tests.test.ts`. Not named
 * `vitest.*.config.ts` for the same reason as `fixture-vitest.config.ts`.
 *
 * Project "ran" executes a test; project "idle" has only skipped tests.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../src/testing/require-executed-tests.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    reporters: ["default", requireExecutedTests("fixture:multi-project")],
    projects: [
      { extends: true, test: { name: "ran", include: ["passing.fixture.ts"] } },
      { extends: true, test: { name: "idle", include: ["all-skipped.fixture.ts"] } },
    ],
  },
});
