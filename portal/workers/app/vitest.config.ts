import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Worker tests cannot read the host filesystem at runtime. Read the SQL while
// Vite evaluates this Node-side config, then inject it into the test bundle.
const migrationDirectory = new URL("../../packages/db/migrations/", import.meta.url);
const migrationSql = (await Promise.all((await readdir(migrationDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFile(new URL(name, migrationDirectory), "utf8"))))
  .join("\n--> statement-breakpoint\n");
const seedSql = await readFile(new URL("../../packages/db/seed/0001_seed.sql", import.meta.url), "utf8");

// v0.18 configures the Workers pool with this Vitest 4 plugin. It loads every
// binding (DB, MEDIA, SESSIONS, and services) from wrangler.jsonc via Miniflare.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __PORTAL_MIGRATION_SQL__: JSON.stringify(migrationSql),
    __PORTAL_SEED_SQL__: JSON.stringify(seedSql),
    "process.env.DOCUMENT_DIRECT_TEST": JSON.stringify("false"),
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TRANSFORM_SOURCE_SECRET: "test-transform-source-secret-32-bytes",
          // Primary suite is production-shaped: direct browser PUTs must not leak here.
          APP_ENV: "production",
          R2_ACCOUNT_ID: "",
          R2_S3_ACCESS_KEY_ID: "",
          R2_S3_SECRET_ACCESS_KEY: "",
        },
        // The BACKGROUND service binding points at the separately-deployed
        // background Worker; tests don't exercise it, so satisfy the binding
        // with a stub auxiliary worker to let workerd start.
        workers: [
          {
            name: "quincy-portal-background",
            modules: true,
            script:
              "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class QuincyBackground extends WorkerEntrypoint { async processTonomoEvents() {} async publishManualEditedUpload() { return { jobId: crypto.randomUUID() }; } }",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
