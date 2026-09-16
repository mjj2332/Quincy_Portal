import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../packages/shared/src/testing/require-executed-tests.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: { reporters: ["default", requireExecutedTests("apps/web/vitest.config.ts")], environment: "node", include: ["src/**/*.test.ts"] },
});
