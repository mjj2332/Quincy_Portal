import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrationDirectory = new URL("../../packages/db/migrations/", import.meta.url);
const migrationSql = (await Promise.all((await readdir(migrationDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFile(new URL(name, migrationDirectory), "utf8"))))
  .join("\n--> statement-breakpoint\n");
const wranglerConfig = await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __PORTAL_MIGRATION_SQL__: JSON.stringify(migrationSql),
    __BACKGROUND_WRANGLER_CONFIG__: JSON.stringify(wranglerConfig),
  },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
