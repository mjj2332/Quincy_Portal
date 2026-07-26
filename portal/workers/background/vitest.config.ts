import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
  .filter(({ name }) => !name.startsWith("0015_"))
  .map(({ sql }) => sql)
  .join("\n--> statement-breakpoint\n");
const migration0015Sql = migrations.find(({ name }) => name.startsWith("0015_"))?.sql ?? "";
const wranglerConfig = await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __PORTAL_MIGRATION_SQL__: JSON.stringify(migrationSql),
    __PORTAL_MIGRATION_SQL_BEFORE_0015__: JSON.stringify(migrationSqlBefore0015),
    __PORTAL_MIGRATION_0015_SQL__: JSON.stringify(migration0015Sql),
    __BACKGROUND_WRANGLER_CONFIG__: JSON.stringify(wranglerConfig),
  },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
