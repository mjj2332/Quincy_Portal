/**
 * QA scheduling fixture — guarded local-only runner (#220 follow-on). Clones the shape of
 * `../setup-local.mjs`: a hard-coded database name and config path, unconditional `--local`, a
 * `FORBIDDEN_ARGUMENTS` list rejected in both `--flag value` and `--flag=value` form, and no
 * argument passthrough (an unrecognised flag throws before anything is spawned).
 *
 * **This file never builds fixture SQL.** It reads argv, runs a handful of fixed preflight/
 * postcondition queries (the same shape `setup-local.mjs` already uses for its own board-flag
 * check), and spawns `npx tsx ./emit.ts <mode> …` to get JSON statements — `dataset.ts`/`sql.ts`
 * (imported only by `emit.ts`, run only under `tsx`) are the only files that construct the
 * ~thousands of fixture INSERT/DELETE statements. The split is deliberate: the half that can reach
 * an environment (this file) cannot construct SQL, and the half that constructs SQL cannot reach
 * an environment.
 *
 * Generated SQL is written to a **temporary** file under `os.tmpdir()` and unlinked in `finally` —
 * never a committed `.sql` file in this directory (a guard test asserts that).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_NAME = "quincy-portal";
const CONFIG_PATH = "../../workers/app/wrangler.jsonc";
/** cwd for every wrangler spawn: `packages/db/`, one level above this file, so `CONFIG_PATH`
 * resolves exactly like `setup-local.mjs`'s own (identical string, identical cwd). */
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const qaSeedDirectory = fileURLToPath(new URL("./", import.meta.url));

const BOOTSTRAP_ADMIN_ID = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
/** Kept in step with `packages/shared/src/project-members.ts`'s `PROJECT_ASSIGNMENT_ELIGIBLE_
 * ROLES.editor`; asserted equal to it by the wiring guard so this literal can never silently
 * drift from the source of truth `default-editors.ts` reads at runtime. */
export const DEFAULT_EDITOR_ELIGIBLE_ROLES = ["editor", "external_editor", "admin"];

const COMMANDS = new Set(["apply", "teardown", "verify"]);
/** Refused outright — each one can move the target off local storage, or (for `--file`/
 * `--command`) let a caller substitute arbitrary SQL for the generated fixture SQL. */
const FORBIDDEN_ARGUMENTS = ["--remote", "--env", "--config", "--database", "--preview", "--file", "--command"];

export function parseArguments(argv) {
  if (argv.length === 0 || !COMMANDS.has(argv[0])) {
    throw new Error(`First argument must be one of apply, teardown, verify. Got ${JSON.stringify(argv[0] ?? null)}.`);
  }
  const command = argv[0];
  const options = { command, tier: undefined, anchor: undefined, persistTo: undefined };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const bare = argument.split("=")[0];
    if (FORBIDDEN_ARGUMENTS.includes(bare)) {
      throw new Error(
        `Refusing \`${bare}\`: this script is local-only, and ${CONFIG_PATH} carries the production D1 database_id. ` +
          "Run wrangler directly if you genuinely mean to touch another environment.",
      );
    }
    if (bare === "--tier") {
      if (!argument.includes("=")) throw new Error("`--tier` needs `=<core|core,density>`.");
      options.tier = argument.slice(argument.indexOf("=") + 1);
      continue;
    }
    if (bare === "--anchor") {
      if (!argument.includes("=")) throw new Error("`--anchor` needs `=<YYYY-MM-DD>`.");
      options.anchor = argument.slice(argument.indexOf("=") + 1);
      continue;
    }
    if (bare === "--persist-to") {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[(index += 1)];
      if (!value) throw new Error("`--persist-to` needs a directory.");
      options.persistTo = value;
      continue;
    }
    throw new Error(`Unknown argument \`${argument}\`. Only \`--tier\`, \`--anchor\` and \`--persist-to <directory>\` are accepted.`);
  }
  if (command !== "apply" && options.tier !== undefined) throw new Error("`--tier` only applies to `apply`.");
  if (command === "teardown" && options.anchor !== undefined) throw new Error("`--anchor` does not apply to `teardown`; it tears down every registered fixture row regardless of anchor.");
  return options;
}

/** Every wrangler invocation this script can construct. `--local` is present unconditionally and
 * is never derived from any input — mirrors `setup-local.mjs:wranglerArguments`. */
export function wranglerArguments(subcommand, options) {
  const persist = options.persistTo ? ["--persist-to", options.persistTo] : [];
  return ["wrangler", "d1", ...subcommand, DATABASE_NAME, "--local", "--config", CONFIG_PATH, ...persist];
}

function runWrangler(subcommand, options, extra = []) {
  const args = [...wranglerArguments(subcommand, options), ...extra];
  const result = spawnSync("npx", args, { cwd: packageDirectory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (result.status !== 0) throw new Error(`\`npx ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  return result.stdout ?? "";
}

function queryRows(options, sql) {
  const stdout = runWrangler(["execute"], options, ["--json", "--command", sql]);
  const payload = JSON.parse(stdout.slice(stdout.indexOf("[")));
  return payload.at(-1)?.results ?? [];
}

function queryScalar(options, sql) {
  return queryRows(options, sql).at(0);
}

function runStatementFile(options, statements, label) {
  if (statements.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), "quincy-qa-seed-"));
  const file = join(dir, `${label}.sql`);
  try {
    writeFileSync(file, statements.join("\n"), "utf8");
    runWrangler(["execute"], options, ["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function runTsx(args) {
  const result = spawnSync("npx", ["tsx", "./emit.ts", ...args], { cwd: qaSeedDirectory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (result.status !== 0) throw new Error(`\`npx tsx ./emit.ts ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// Preflight / postcondition — fixed, non-dataset-shaped queries only (same rationale as
// `setup-local.mjs`'s own `LOCAL_FLAG_SQL`: these are simple, caller-independent, and never touch
// the generated fixture SQL).
// ---------------------------------------------------------------------------

function assertCapabilityPresent(options) {
  const row = queryScalar(options, "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__quincy_local_capability') AS present;");
  if (Number(row?.present) !== 1) {
    throw new Error("`__quincy_local_capability` is missing. Run `npm run db:migrate:local` (which now creates it) against this database first.");
  }
  const capabilityRow = queryScalar(options, "SELECT EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures') AS present;");
  if (Number(capabilityRow?.present) !== 1) {
    throw new Error("The local capability row for `scheduling-fixtures` is missing. Re-run `npm run db:migrate:local`.");
  }
}

function assertPrerequisites(options) {
  const stages = queryScalar(options, "SELECT COUNT(*) AS n FROM pipeline_stages WHERE active = 1;");
  if (Number(stages?.n) !== 5) {
    throw new Error(`Expected 5 active pipeline_stages, found ${JSON.stringify(stages?.n)}. This local D1 is missing \`seed/0001_seed.sql\` — apply it yourself with a --local --persist-to wrangler command before running this fixture (setup-local.mjs does not apply it; see docs/Guides/Local-QA-Fixtures.md).`);
  }
  const admin = queryScalar(options, `SELECT active FROM user WHERE id = '${BOOTSTRAP_ADMIN_ID}';`);
  if (admin === undefined || Number(admin.active) !== 1) {
    throw new Error("The bootstrap admin user is missing or inactive. This local D1 is missing `seed/0001_seed.sql` — apply it yourself before running this fixture.");
  }
}

function queryDefaultEditorIds(options) {
  const roles = DEFAULT_EDITOR_ELIGIBLE_ROLES.map((role) => `'${role}'`).join(", ");
  const rows = queryRows(options, `SELECT id FROM user WHERE default_editor = 1 AND active = 1 AND role IN (${roles}) ORDER BY id;`);
  return rows.map((row) => row.id);
}

function queryRegisteredEntities(options) {
  const entities = queryRows(options, "SELECT id, kind FROM __quincy_local_fixture_entities ORDER BY kind, id;");
  const runIds = queryRows(options, "SELECT id FROM __quincy_local_fixture_runs ORDER BY id;").map((row) => row.id);
  return { entities, runIds };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function teardownExisting(options) {
  const { entities, runIds } = queryRegisteredEntities(options);
  if (entities.length === 0 && runIds.length === 0) {
    console.log("==> No registered fixture rows to tear down.");
    return { entities, runIds };
  }
  console.log(`==> Tearing down ${entities.length} previously-registered fixture row(s) across ${runIds.length} run(s)`);
  const { statements } = runTsx(["teardown-plan", `--entities=${JSON.stringify(entities)}`, `--run-ids=${JSON.stringify(runIds)}`]);
  for (const [index, group] of chunk(statements, 400).entries()) runStatementFile(options, group, `teardown-${index}`);
  const remaining = queryScalar(options, "SELECT COUNT(*) AS n FROM __quincy_local_fixture_entities;");
  if (Number(remaining?.n) !== 0) throw new Error(`Teardown left ${remaining?.n} registered entities behind — aborting rather than guessing why.`);
  return { entities, runIds };
}

function commandTeardown(options) {
  const started = Date.now();
  teardownExisting(options);
  console.log(`==> Teardown complete in ${Date.now() - started}ms`);
}

function commandApply(options) {
  const started = Date.now();
  assertCapabilityPresent(options);
  assertPrerequisites(options);
  teardownExisting(options);

  const defaultEditorIds = queryDefaultEditorIds(options);
  const tierArg = options.tier ?? "core";
  const anchorArgs = options.anchor ? [`--anchor=${options.anchor}`] : [];
  const plan = runTsx([
    "plan",
    `--tier=${tierArg}`,
    ...anchorArgs,
    `--default-editor-ids=${defaultEditorIds.join(",")}`,
    `--applied-at-ms=${Date.now()}`,
  ]);

  console.log(`==> Applying anchor=${plan.anchor} tiers=${plan.tiers.join(",")} — ${plan.summary.projects} projects, ${plan.summary.subtasks} subtasks`);
  for (const [index, group] of chunk(plan.statements, 400).entries()) runStatementFile(options, group, `apply-${index}`);

  const projectIds = plan.entities.filter((e) => e.kind === "project").map((e) => e.id);
  const projectCount = queryScalar(options, `SELECT COUNT(*) AS n FROM projects WHERE id IN (${projectIds.map((id) => `'${id}'`).join(",")});`);
  if (Number(projectCount?.n) !== plan.summary.projects) {
    throw new Error(`Postcondition failed: expected ${plan.summary.projects} fixture projects, found ${projectCount?.n}.`);
  }
  const unmarked = queryScalar(options, `SELECT COUNT(*) AS n FROM projects WHERE id IN (${projectIds.map((id) => `'${id}'`).join(",")}) AND notes NOT LIKE 'QA-FIXTURE-v1%';`);
  if (Number(unmarked?.n) !== 0) throw new Error(`Postcondition failed: ${unmarked?.n} fixture project(s) are missing the QA-FIXTURE-v1 sentinel.`);

  console.log(`==> Apply complete in ${Date.now() - started}ms: ${plan.summary.projects} projects, ${plan.summary.subtasks} subtasks, ${plan.summary.collections} collections, ${plan.summary.deadlineOccurrences} deadline occurrences, ${plan.summary.members} default-editor memberships.`);
}

function commandVerify(options) {
  const started = Date.now();
  assertCapabilityPresent(options);
  const runRows = queryRows(options, "SELECT anchor, tier FROM __quincy_local_fixture_runs ORDER BY applied_at DESC LIMIT 1;");
  const latest = runRows.at(0);
  if (!latest) throw new Error("No fixture run is registered — nothing to verify. Run `apply` first.");
  const anchor = options.anchor ?? latest.anchor;
  const tier = options.tier ?? latest.tier;
  const manifest = runTsx(["manifest", `--anchor=${anchor}`, `--tier=${tier}`]);

  const checks = [
    ["projects", manifest.projectIds],
    ["project_subtasks", manifest.subtaskIds],
    ["collections", manifest.collectionIds],
    ["project_deadline_occurrences", manifest.deadlineOccurrenceIds],
  ];
  for (const [table, ids] of checks) {
    if (ids.length === 0) continue;
    const row = queryScalar(options, `SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${ids.map((id) => `'${id}'`).join(",")});`);
    if (Number(row?.n) !== ids.length) throw new Error(`verify: ${table} has ${row?.n} of the expected ${ids.length} fixture rows.`);
  }
  const sentinel = queryScalar(options, `SELECT COUNT(*) AS n FROM projects WHERE id IN (${manifest.projectIds.map((id) => `'${id}'`).join(",")}) AND notes NOT LIKE 'QA-FIXTURE-v1%';`);
  if (Number(sentinel?.n) !== 0) throw new Error(`verify: ${sentinel?.n} fixture project(s) are missing the sentinel.`);
  const fkCheck = queryRows(options, "PRAGMA foreign_key_check;");
  if (fkCheck.length !== 0) throw new Error(`verify: PRAGMA foreign_key_check reported ${fkCheck.length} violation(s).`);

  console.log(`==> Verify complete in ${Date.now() - started}ms: anchor=${anchor} tier=${tier}, ${manifest.summary.projects} projects, ${manifest.summary.subtasks} subtasks all present and sentinel-marked.`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "apply") return commandApply(options);
  if (options.command === "teardown") return commandTeardown(options);
  if (options.command === "verify") return commandVerify(options);
  throw new Error(`Unreachable command: ${options.command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\nQA fixture ${process.argv[2] ?? ""} failed: ${error.message}`);
    process.exit(1);
  });
}
