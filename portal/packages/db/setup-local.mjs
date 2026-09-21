/**
 * Bring a local D1 to the state production is actually in — migrations, then the post-rollout
 * feature flags. **Local only. This must never touch production.**
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Kept in step with `src/board-schema-variant.ts`; asserted by the wiring guard. */
const BOARD_CONTRACT_FLAG = "tb5a_board_contract_enabled";
const DATABASE_NAME = "quincy-portal";
const CONFIG_PATH = "../../workers/app/wrangler.jsonc";
const packageDirectory = fileURLToPath(new URL("./", import.meta.url));

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
      if (!value) throw new Error("`--persist-to` needs a directory.");
      options.persistTo = value;
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

function runWrangler(subcommand, options, extra = []) {
  const args = [...wranglerArguments(subcommand, options), ...extra];
  const result = spawnSync("npx", args, { cwd: packageDirectory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`\`npx ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  }
  return result.stdout ?? "";
}

function queryScalar(options, sql) {
  const stdout = runWrangler(["execute"], options, ["--json", "--command", sql]);
  const payload = JSON.parse(stdout.slice(stdout.indexOf("[")));
  return payload.at(-1)?.results?.at(0);
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

function runSqlFile(options, sql, label) {
  const dir = mkdtempSync(join(tmpdir(), `quincy-setup-local-${label}-`));
  const file = join(dir, `${label}.sql`);
  try {
    writeFileSync(file, sql, "utf8");
    runWrangler(["execute"], options, ["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  console.log("==> Applying migrations to local D1");
  runWrangler(["migrations", "apply"], options);

  // The flag is meaningless without 0037's marker table, which is what gates the Board at all.
  assertSchemaMarkerPresent(queryScalar(options, "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_board_order_0037_rollback') AS present;"));

  console.log(`==> Enabling ${BOARD_CONTRACT_FLAG} for local development`);
  runWrangler(["execute"], options, ["--command", LOCAL_FLAG_SQL]);

  assertFlagEnabled(queryScalar(options, `SELECT enabled FROM feature_flags WHERE key = '${BOARD_CONTRACT_FLAG}';`));

  console.log("==> Installing the QA scheduling fixture capability fence (local-only)");
  runSqlFile(options, QA_FIXTURE_CAPABILITY_SQL, "qa-fixture-capability");
  assertCapabilityInstalled(queryScalar(options, "SELECT EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures') AS present;"));

  console.log(`==> Local D1 ready: ${BOARD_CONTRACT_FLAG} = 1, Board drag reachable, QA fixture capability installed.`);
}

// Only when run as a command. The parsing and argument-building seams above are importable so
// tests can assert what this *would* spawn without spawning anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\nLocal D1 setup failed: ${error.message}`);
    process.exit(1);
  });
}
