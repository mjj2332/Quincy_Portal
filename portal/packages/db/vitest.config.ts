import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../shared/src/testing/require-executed-tests.ts";

export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), test: { reporters: ["default", requireExecutedTests("packages/db/vitest.config.ts")], environment: "node", include: ["src/**/*.test.ts", "test/**/*.test.ts"] } });
