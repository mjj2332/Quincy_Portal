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

async function main() {
  const options = parseArguments(process.argv.slice(2));

  console.log("==> Applying migrations to local D1");
  runWrangler(["migrations", "apply"], options);

  // The flag is meaningless without 0037's marker table, which is what gates the Board at all.
  assertSchemaMarkerPresent(queryScalar(options, "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_board_order_0037_rollback') AS present;"));

  console.log(`==> Enabling ${BOARD_CONTRACT_FLAG} for local development`);
  runWrangler(["execute"], options, ["--command", LOCAL_FLAG_SQL]);

  assertFlagEnabled(queryScalar(options, `SELECT enabled FROM feature_flags WHERE key = '${BOARD_CONTRACT_FLAG}';`));

  console.log(`==> Local D1 ready: ${BOARD_CONTRACT_FLAG} = 1, Board drag reachable.`);
}

// Only when run as a command. The parsing and argument-building seams above are importable so
// tests can assert what this *would* spawn without spawning anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\nLocal D1 setup failed: ${error.message}`);
    process.exit(1);
  });
}
