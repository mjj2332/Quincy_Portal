import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { requireExecutedTests } from "../../packages/shared/src/testing/require-executed-tests.ts";

export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), test: { reporters: ["default", requireExecutedTests("workers/webhook-ingress/vitest.config.ts")], environment: "node", include: ["test/**/*.test.ts"] } });
