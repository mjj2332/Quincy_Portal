/**
 * The harness for `require-executed-tests.test.ts`. Deliberately NOT named `vitest.*.config.ts`:
 * `ci-vitest-configs.guard.test.ts` discovers configs by that pattern and requires the workflow to
 * run each one, and this is a fixture rather than a suite CI should invoke.
 *
 * Which fixture it collects comes from `FIXTURE`, so the cases differ only in the file under test.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../src/testing/require-executed-tests.ts";

const fixture = process.env.FIXTURE;
if (!fixture) throw new Error("FIXTURE must name a fixture file");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: [fixture],
    reporters: ["default", requireExecutedTests(`fixture:${fixture}`)],
  },
});
