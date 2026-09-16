import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireExecutedTests } from "./src/testing/require-executed-tests.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    reporters: ["default", requireExecutedTests("packages/shared/vitest.config.ts")],
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
