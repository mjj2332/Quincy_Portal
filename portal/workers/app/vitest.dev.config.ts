import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrationDirectory = new URL("../../packages/db/migrations/", import.meta.url);
const migrationSql = (await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort().map((name) => readFile(new URL(name, migrationDirectory), "utf8")))).join("\n--> statement-breakpoint\n");
const seedSql = await readFile(new URL("../../packages/db/seed/0001_seed.sql", import.meta.url), "utf8");

/** Explicit opt-in suite for Miniflare's direct R2 PUT fallback only. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: { __PORTAL_MIGRATION_SQL__: JSON.stringify(migrationSql), __PORTAL_SEED_SQL__: JSON.stringify(seedSql), "process.env.DOCUMENT_DIRECT_TEST": JSON.stringify("true") },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TRANSFORM_SOURCE_SECRET: "test-transform-source-secret-32-bytes", APP_ENV: "dev", R2_ACCOUNT_ID: "", R2_S3_ACCESS_KEY_ID: "", R2_S3_SECRET_ACCESS_KEY: "" }, workers: [{ name: "quincy-portal-background", modules: true, script: "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class QuincyBackground extends WorkerEntrypoint { async processTonomoEvents() {} }" }] } })],
  // Direct R2 PUT is the only dev-only behavior. Keep production redirect assertions out of
  // this config even though they share the API test module.
  test: { include: ["test/api.test.ts"], testNamePattern: "reserves direct R2 document uploads" },
});
