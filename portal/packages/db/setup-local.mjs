/**
 * Bring a local D1 to the state production is actually in — migrations, the shared seed, then the
 * post-rollout feature flags. **Local only. This must never touch production.** The seed is all
 * `INSERT OR IGNORE`, so re-running this never changes rows that already exist.
 *
 * `0037_project_board_order_contract` seeds `tb5a_board_contract_enabled` disabled, and production
 * was flipped on deliberately afterwards. Nothing brought a *local* database to that post-rollout
 * state, so the Kanban rendered disabled in every fresh worktree and drag could not be exercised
 * at all. Full background, and why the shared seed is the wrong home for this, in `docs/lessons.md`
 * under "A staged rollout leaves two states" (#160).
 *
 * Two things here are load-bearing. `workers/app/wrangler.jsonc` carries the **production** D1
 * `database_id`, so `--local` is all that separates this from the real database: it is hard-coded,
 * never taken from a caller, and anything that could redirect the target is refused before a
 * subprocess is spawned. And every step asserts its postcondition — applying SQL proves nothing
 * unless something checks it landed, and printing a row is not checking it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Kept in step with `src/board-schema-variant.ts`; asserted by the wiring guard. */
const BOARD_CONTRACT_FLAG = "tb5a_board_contract_enabled";
const DATABASE_NAME = "quincy-portal";
const CONFIG_PATH = "../../workers/app/wrangler.jsonc";
const packageDirectory = fileURLToPath(new URL("./", import.meta.url));

/** The shared, all-environments seed, applied in place. Its stage keys and admin id are asserted
 * against `@quincy/shared` and `qa-seed/dataset` by the wiring guard. */
export const SEED_PATH = fileURLToPath(new URL("./seed/0001_seed.sql", import.meta.url));
export const SEED_STAGE_KEYS = ["awaiting_raw", "raw_review", "editing_autohdr", "edited_review", "delivered"];
export const BOOTSTRAP_ADMIN_ID = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";

const seedStageKeyList = SEED_STAGE_KEYS.map((key) => `'${key}'`).join(", ");

/** One SELECT of scalar subqueries, not a compound SELECT: local D1 caps those at 5 terms. */
export const SEED_POSTCONDITION_SQL = `SELECT
  (SELECT COUNT(*) FROM pipeline_stages WHERE key IN (${seedStageKeyList})) AS stages,
  (SELECT COUNT(*) FROM pipeline_stages WHERE active = 1 AND key IN (${seedStageKeyList})) AS active_stages,
  (SELECT active FROM user WHERE id = '${BOOTSTRAP_ADMIN_ID}') AS admin_active;`;

/**
 * Flags local dev needs on that production does not have. `UPDATE`, not an upsert: the row always
 * exists once 0037 has run, a missing row already reads as disabled, and an upsert here would
 * reproduce the very pattern `migration-feature-flag-ownership.guard.test.ts` forbids.
 */
export const LOCAL_FLAG_SQL = `UPDATE feature_flags SET enabled = 1, updated_at = unixepoch('now') * 1000 WHERE key = '${BOARD_CONTRACT_FLAG}';`;

/** Refused outright — each one can move the target off local storage. */
const FORBIDDEN_ARGUMENTS = ["--remote", "--env", "--config", "--database", "--preview"];

/**
 * QA scheduling fixture capability fence (#220 follow-on, `qa-seed/`). Three local-only tables,
 * created here — never in a migration, never in `seed/0001_seed.sql`, never in the Drizzle schema
 * — and never dropped by this script. `qa-seed/sql.ts` makes every fixture mutator statement
 * (insert AND teardown delete) require `EXISTS (SELECT 1 FROM __quincy_local_capability WHERE
 * capability = 'scheduling-fixtures')`, so a fixture statement copied out and run against a
 * database that never ran *this* local-only script — production included — dies with `no such
 * table: __quincy_local_capability` instead of silently succeeding. A one-time preflight is not
 * enough: this makes the check part of every statement, not just the first one.
 *
 * `__quincy_local_fixture_run_records` and `__quincy_local_fixture_board_positions` record what an
 * `apply` actually USED and WROTE (the default-editor set it read, the live `board_position` each
 * project landed on), so `db:qa:verify` compares against the run itself rather than recomputing from
 * today's state. `__quincy_local_fixture_closure` is the graph teardown's capture of every row it is
 * about to delete (`qa-seed/teardown-graph.ts`) — recorded BEFORE anything is deleted, so the
 * post-teardown sweep can prove every captured id is gone. `CREATE TABLE IF NOT EXISTS` means
 * re-running this script upgrades a database that
 * predates them; the fixture CLI refuses to run until it has been.
 *
 * Honest limit, stated once here rather than re-litigated in the fixture docs: a privileged
 * operator holding real production credentials could still create this table there by hand and
 * bypass the fence deliberately. Nothing in this repository can stop that; what this fence does
 * stop is every accidental path — a copied statement, a copied file, a `--remote` typo, a CI job —
 * from reaching production with live effect.
 */
export const QA_FIXTURE_CAPABILITY_SQL = `
CREATE TABLE IF NOT EXISTS __quincy_local_capability (
  capability text PRIMARY KEY NOT NULL,
  schema_version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS __quincy_local_fixture_runs (
  id text PRIMARY KEY NOT NULL,
  tier text NOT NULL,
  anchor text NOT NULL,
  applied_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS __quincy_local_fixture_entities (
  id text NOT NULL,
  kind text NOT NULL,
  run_id text NOT NULL,
  PRIMARY KEY (id, kind)
);
CREATE TABLE IF NOT EXISTS __quincy_local_fixture_run_records (
  run_id text PRIMARY KEY NOT NULL,
  default_editor_ids text NOT NULL
);
CREATE TABLE IF NOT EXISTS __quincy_local_fixture_board_positions (
  project_id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL,
  board_position real NOT NULL
);
CREATE TABLE IF NOT EXISTS __quincy_local_fixture_closure (
  table_name text NOT NULL,
  row_id integer NOT NULL,
  entity_id text,
  PRIMARY KEY (table_name, row_id)
);
CREATE INDEX IF NOT EXISTS __quincy_local_fixture_closure_entity ON __quincy_local_fixture_closure (table_name, entity_id);
INSERT OR IGNORE INTO __quincy_local_capability (capability, schema_version) VALUES ('scheduling-fixtures', 1);
`.trim();

export function parseArguments(argv) {
  const options = { persistTo: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const bare = argument.split("=")[0];
    if (FORBIDDEN_ARGUMENTS.includes(bare)) {
      throw new Error(
        `Refusing \`${bare}\`: this script is local-only, and ${CONFIG_PATH} carries the production D1 database_id. ` +
          "Run wrangler directly if you genuinely mean to touch another environment.",
      );
    }
    if (bare === "--persist-to") {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[(index += 1)];
      // An empty value or one starting with `-` is how a caller smuggles another flag (`--remote`,
      // `--env=production`, ...) past this parser and into wrangler's argv, right after `--local`.
      // Refused here, before any subprocess exists, same as the FORBIDDEN_ARGUMENTS check above.
      if (!value || value.startsWith("-")) {
        throw new Error(
          `Refusing \`--persist-to ${JSON.stringify(value ?? "")}\`: this script is local-only, and ${CONFIG_PATH} carries the production D1 database_id. ` +
            "Run wrangler directly if you genuinely mean to touch another environment.",
        );
      }
      // Resolved to an absolute path so what reaches wrangler's argv can never be re-parsed as a flag.
      options.persistTo = resolve(process.cwd(), value);
      continue;
    }
    throw new Error(`Unknown argument \`${argument}\`. Only \`--persist-to <directory>\` is accepted.`);
  }
  return options;
}

/** Every wrangler invocation this script makes. `--local` is present unconditionally. */
export function wranglerArguments(subcommand, options) {
  const persist = options.persistTo ? ["--persist-to", options.persistTo] : [];
  return ["wrangler", "d1", ...subcommand, DATABASE_NAME, "--local", "--config", CONFIG_PATH, ...persist];
}

function runWrangler(subcommand, options, extra = [], spawn = spawnSync) {
  const args = [...wranglerArguments(subcommand, options), ...extra];
  const result = spawn("npx", args, { cwd: packageDirectory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`\`npx ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  }
  return result.stdout ?? "";
}

/**
 * The postcondition. Exported so the wiring guard can assert the *behaviour* rather than match the
 * source text: applying SQL proves nothing unless something checks it landed.
 */
export function assertFlagEnabled(row) {
  if (Number(row?.enabled) !== 1) {
    throw new Error(`${BOARD_CONTRACT_FLAG} is ${JSON.stringify(row?.enabled)} after the update, not 1. The Board would still render disabled.`);
  }
}

/** The other postcondition: the flag is meaningless without 0037's schema marker. */
export function assertSchemaMarkerPresent(row) {
  if (Number(row?.present) !== 1) {
    throw new Error("Migration 0037 has not been applied — its rollback marker table is absent. Local D1 is not in a state the Board can run against.");
  }
}

/** The QA fixture capability fence's own postcondition — applying SQL proves nothing unless
 * something checks the row landed, same rationale as `assertFlagEnabled` above. */
export function assertCapabilityInstalled(row) {
  if (Number(row?.present) !== 1) {
    throw new Error("__quincy_local_capability's 'scheduling-fixtures' row did not land. `npm run db:qa:apply` would refuse to run against this database.");
  }
}

export function assertSeedApplied(row) {
  const stages = Number(row?.stages);
  if (stages !== SEED_STAGE_KEYS.length) {
    throw new Error(`${Number.isFinite(stages) ? stages : 0} of ${SEED_STAGE_KEYS.length} seeded pipeline stages present after applying seed/0001_seed.sql.`);
  }
  if (row?.admin_active === null || row?.admin_active === undefined) {
    throw new Error(
      `The bootstrap admin user row (id ${BOOTSTRAP_ADMIN_ID}) is missing after applying seed/0001_seed.sql. ` +
        "user.email is unique, so if another user row already holds the bootstrap admin's email the seed's INSERT OR IGNORE skipped it. " +
        "Resolve that by hand; this script will not delete user data.",
    );
  }
}

/** Rows that exist but were changed in Admin are legitimate local states the seed cannot (and
 * must not) change — so these warn rather than fail. */
export function seedWarnings(row) {
  const warnings = [];
  if (Number(row.active_stages) !== SEED_STAGE_KEYS.length) {
    warnings.push(`${SEED_STAGE_KEYS.length - Number(row.active_stages)} of ${SEED_STAGE_KEYS.length} seeded pipeline stages are inactive — re-activate them in Admin if you need them.`);
  }
  if (Number(row.admin_active) !== 1) {
    warnings.push("The bootstrap admin is inactive — signing in as it will fail until it is re-activated in Admin.");
  }
  return warnings;
}

function runSqlFile(options, sql, label, spawn) {
  const dir = mkdtempSync(join(tmpdir(), `quincy-setup-local-${label}-`));
  const file = join(dir, `${label}.sql`);
  try {
    writeFileSync(file, sql, "utf8");
    runWrangler(["execute"], options, ["--file", file], spawn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every wrangler call goes through `wranglerArguments`, so `--local` pinning is unchanged; the
 * executor seam only exists so tests can run the same sequence against an in-memory SQLite.
 */
export function wranglerSetupExecutor(options, spawn = spawnSync) {
  return {
    migrate: () => runWrangler(["migrations", "apply"], options, [], spawn),
    run: (sql, label) => runSqlFile(options, sql, label, spawn),
    runFile: (path) => runWrangler(["execute"], options, ["--file", path], spawn),
    query: (sql) => {
      const stdout = runWrangler(["execute"], options, ["--json", "--command", sql], spawn);
      const payload = JSON.parse(stdout.slice(stdout.indexOf("[")));
      return payload.at(-1)?.results ?? [];
    },
  };
}

export function setupLocal(executor, log) {
  log("==> Applying migrations to local D1");
  executor.migrate();

  // The flag is meaningless without 0037's marker table, which is what gates the Board at all.
  assertSchemaMarkerPresent(executor.query("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_board_order_0037_rollback') AS present;")[0]);

  log("==> Applying the shared seed (seed/0001_seed.sql)");
  executor.runFile(SEED_PATH);
  const row = executor.query(SEED_POSTCONDITION_SQL)[0];
  assertSeedApplied(row);
  for (const warning of seedWarnings(row)) log(`  ! ${warning}`);

  log(`==> Enabling ${BOARD_CONTRACT_FLAG} for local development`);
  executor.run(LOCAL_FLAG_SQL, "board-flag");

  assertFlagEnabled(executor.query(`SELECT enabled FROM feature_flags WHERE key = '${BOARD_CONTRACT_FLAG}';`)[0]);

  log("==> Installing the QA scheduling fixture capability fence (local-only)");
  executor.run(QA_FIXTURE_CAPABILITY_SQL, "qa-fixture-capability");
  assertCapabilityInstalled(executor.query("SELECT EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures') AS present;")[0]);

  log(`==> Local D1 ready: pipeline stages and bootstrap admin seeded, ${BOARD_CONTRACT_FLAG} = 1, Board drag reachable, QA fixture capability installed.`);
}

export function main(argv, { spawn = spawnSync, log = console.log } = {}) {
  setupLocal(wranglerSetupExecutor(parseArguments(argv), spawn), log);
}

// Only when run as a command. The parsing and argument-building seams above are importable so
// tests can assert what this *would* spawn without spawning anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nLocal D1 setup failed: ${error.message}`);
    process.exit(1);
  }
}
