import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireExecutedTests } from "../../packages/shared/src/testing/require-executed-tests.ts";
import { CI_HOOK_TIMEOUT_MS, CI_TEST_TIMEOUT_MS } from "../../packages/shared/src/testing/ci-timeouts.ts";

const migrationDirectory = new URL("../../packages/db/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(new URL(name, migrationDirectory), "utf8"),
})));
const migrationSql = migrations.map(({ sql }) => sql)
  .join("\n--> statement-breakpoint\n");
const migrationSqlBefore0015 = migrations
  .filter(({ name }) => name < "0015_")
  .map(({ sql }) => sql)
  .join("\n--> statement-breakpoint\n");
const migration0015Sql = migrations.find(({ name }) => name.startsWith("0015_"))?.sql ?? "";
const migrationSqlBefore0029 = migrations.filter(({ name }) => name < "0029_").map(({ sql }) => sql).join("\n--> statement-breakpoint\n");
const migration0029Sql = migrations.find(({ name }) => name.startsWith("0029_"))?.sql ?? "";
const wranglerConfig = await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __PORTAL_MIGRATION_SQL__: JSON.stringify(migrationSql),
    __PORTAL_MIGRATION_SQL_BEFORE_0015__: JSON.stringify(migrationSqlBefore0015),
    __PORTAL_MIGRATION_0015_SQL__: JSON.stringify(migration0015Sql),
    __PORTAL_MIGRATION_SQL_BEFORE_0029__: JSON.stringify(migrationSqlBefore0029),
    __PORTAL_MIGRATION_0029_SQL__: JSON.stringify(migration0029Sql),
    __BACKGROUND_WRANGLER_CONFIG__: JSON.stringify(wranglerConfig),
  },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { AUTOHDR_API_KEY: "test-autohdr-api-key" } } })],
  test: { reporters: ["default", requireExecutedTests("workers/background/vitest.config.ts")], testTimeout: CI_TEST_TIMEOUT_MS, hookTimeout: CI_HOOK_TIMEOUT_MS, include: ["test/**/*.test.ts"] },
});
