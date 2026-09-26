/**
 * QA scheduling fixture — transport (#220 follow-on). The only file in `qa-seed/` allowed to spawn
 * a subprocess, touch the network, or read `process.env`. Everything it spawns is either `wrangler
 * d1 execute --local ...` against a caller-pinned database name and config, or `npx tsx ./emit.ts`
 * (pure, no side effects of its own — see `emit.ts`'s header). Mirrors `setup-local.mjs`'s own
 * shape and the same two load-bearing properties: `--local` is hard-coded, never taken from a
 * caller, and every step asserts its postcondition rather than trusting that applying SQL worked.
 *
 * Usage:
 *   node ./qa-seed/cli.mjs apply [--tier=core,density] [--anchor=YYYY-MM-DD] [--persist-to DIR]
 *   node ./qa-seed/cli.mjs teardown [--persist-to DIR]
 *   node ./qa-seed/cli.mjs verify [--tier=core,density] [--anchor=YYYY-MM-DD] [--persist-to DIR]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_NAME = "quincy-portal";
const CONFIG_PATH = "../../workers/app/wrangler.jsonc";
const packageDirectory = fileURLToPath(new URL("../", import.meta.url)); // packages/db/ — same cwd setup-local.mjs uses
const BOOTSTRAP_ADMIN_ID = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const CAPABILITY_KEY = "scheduling-fixtures";
const STATEMENTS_PER_FILE = 300;
/** `spawnSync`'s default `maxBuffer` (1 MiB) is smaller than the density tier's JSON plan
 * (~3.2 MB at time of writing) — exceeding it kills the child mid-write, which surfaces as an
 * opaque `EPIPE` from the child's own `process.stdout.write`, not as a clear "buffer exceeded"
 * error. Set generously above any tier this generator is expected to produce. */
const MAX_SUBPROCESS_BUFFER_BYTES = 1024 * 1024 * 200;

/** Kept in exact step with `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor` in `@quincy/shared`;
 * `qa-seed-wiring.guard.test.ts` cross-checks this literal against that source of truth so the two
 * cannot silently drift — this file cannot import the TS package directly (see `emit.ts`'s header:
 * node's built-in TS stripping cannot resolve `@quincy/shared`'s workspace exports). */
export const DEFAULT_EDITOR_ELIGIBLE_ROLES = ["editor", "external_editor", "admin"];
/** Same predicate as `packages/db/src/default-editors.ts`'s `effectiveDefaultEditorSql` (#135) —
 * inlined literals instead of bound params because this goes through `wrangler d1 execute
 * --command`, not a prepared statement, but the WHERE clause and `ORDER BY id` determinism match. */
const DEFAULT_EDITOR_QUERY = `SELECT id FROM user WHERE default_editor = 1 AND active = 1 AND role IN (${DEFAULT_EDITOR_ELIGIBLE_ROLES.map((r) => `'${r}'`).join(", ")}) ORDER BY id;`;

const COMMANDS = ["apply", "teardown", "verify"];
/** Refused outright — each one can move the target off local storage. Same list `setup-local.mjs`
 * refuses, plus `--file`/`--command`, which this script never needs a caller to supply. */
const FORBIDDEN_ARGUMENTS = ["--remote", "--env", "--config", "--database", "--preview", "--file", "--command"];
/** Mirrors `QaTier` in `qa-seed/dataset.ts` — `--tier` never reaches a wrangler argv or a shell (it
 * is only ever one element of an argv array handed to `npx tsx ./qa-seed/emit.ts`), but a malformed
 * value should still be refused here, before any subprocess is spawned, rather than surfacing as an
 * opaque failure out of `emit.ts`. */
const KNOWN_TIERS = ["core", "density"];

/** `--anchor` must be `YYYY-MM-DD` and denote a real calendar date (no `2026-02-30`, no trailing
 * text such as `2026-09-21 --remote`). Sydney-calendar validity is re-checked downstream by
 * `dataset.ts`'s `resolveAnchor`; this is the cheap, dependency-free gate that runs before any
 * subprocess exists. */
function isRealCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseArguments(argv) {
  const command = argv[0];
  if (!COMMANDS.includes(command)) {
    throw new Error(`The first argument must be one of apply, teardown, verify, got ${JSON.stringify(command)}.`);
  }
  const options = { command, tier: undefined, anchor: undefined, persistTo: undefined };
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const bare = argument.split("=")[0];
    if (FORBIDDEN_ARGUMENTS.includes(bare)) {
      throw new Error(
        `Refusing \`${bare}\`: this script is local-only, and ${CONFIG_PATH} carries the production D1 database_id. ` +
          "Run wrangler directly if you genuinely mean to touch another environment.",
      );
    }
    if (bare === "--persist-to") {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : rest[(index += 1)];
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
    if (bare === "--tier") {
      // `verify` accepts `--tier` too (item 6) — after item 2, it is an ASSERTION against the
      // recorded run's own tier, not a new value to recompute against; `teardown` still refuses it
      // outright (teardown removes whatever is registered, regardless of tier).
      if (command !== "apply" && command !== "verify") throw new Error(`\`--tier\` only applies to \`apply\` or \`verify\`, not \`${command}\`.`);
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : rest[(index += 1)];
      if (!value) throw new Error("`--tier` needs a value.");
      const tiers = value.split(",").map((t) => t.trim()).filter(Boolean);
      if (tiers.length === 0) throw new Error("`--tier` needs a value.");
      for (const tier of tiers) {
        if (!KNOWN_TIERS.includes(tier)) {
          throw new Error(`Unknown tier: ${JSON.stringify(tier)}. Expected a comma list drawn from ${KNOWN_TIERS.join(", ")}.`);
        }
      }
      options.tier = value;
      continue;
    }
    if (bare === "--anchor") {
      if (command === "teardown") throw new Error("`--anchor` does not apply to `teardown` (teardown removes whatever is registered, regardless of anchor).");
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : rest[(index += 1)];
      if (!value) throw new Error("`--anchor` needs a value.");
      if (!isRealCalendarDate(value)) {
        throw new Error(`--anchor must be a valid YYYY-MM-DD calendar date, got ${JSON.stringify(value)}.`);
      }
      options.anchor = value;
      continue;
    }
    throw new Error(`Unknown argument \`${argument}\`. Only --tier, --anchor and --persist-to are accepted.`);
  }
  return options;
}

/** Every wrangler invocation this script makes. `--local` is present unconditionally — never taken
 * from a caller, never conditional on anything a caller controls. */
export function wranglerArguments(subcommand, options) {
  const persist = options.persistTo ? ["--persist-to", options.persistTo] : [];
  return ["wrangler", "d1", ...subcommand, DATABASE_NAME, "--local", "--config", CONFIG_PATH, ...persist];
}

function runWrangler(subcommand, options, extra = []) {
  const args = [...wranglerArguments(subcommand, options), ...extra];
  const result = spawnSync("npx", args, { cwd: packageDirectory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: MAX_SUBPROCESS_BUFFER_BYTES });
  if (result.status !== 0) throw new Error(`\`npx ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  return result.stdout ?? "";
}

function queryRows(options, sql) {
  const stdout = runWrangler(["execute"], options, ["--json", "--command", sql]);
  const payload = JSON.parse(stdout.slice(stdout.indexOf("[")));
  return payload.at(-1)?.results ?? [];
}

/**
 * The transport seam. Every command below talks to the database ONLY through an executor —
 * `query(sql)` returns result rows, `run(statements, label)` applies mutator statements, `emit(mode,
 * args)` runs the pure generator. `wranglerExecutor` is the only production implementation (always
 * `--local`, see `wranglerArguments`); the qa-seed integration tests supply a `node:sqlite`-backed one
 * over the real migrations, so the orchestration they exercise is this file's own code, not a copy.
 */
export function wranglerExecutor(options) {
  return {
    query: (sql) => queryRows(options, sql),
    run: (statements, label) => applyStatements(options, statements, label),
    emit: (mode, args) => runEmit(mode, args),
  };
}

function queryScalar(executor, sql) {
  return executor.query(sql).at(0);
}

function runEmit(mode, args) {
  const result = spawnSync("npx", ["tsx", "./qa-seed/emit.ts", mode, ...args], { cwd: packageDirectory, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: MAX_SUBPROCESS_BUFFER_BYTES });
  if (result.status !== 0) throw new Error(`\`npx tsx ./qa-seed/emit.ts ${mode} ${args.join(" ")}\` exited with ${result.status ?? "a signal"}.`);
  return JSON.parse(result.stdout);
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function applyStatements(options, statements, label) {
  if (statements.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), `quincy-qa-seed-${label}-`));
  try {
    chunk(statements, STATEMENTS_PER_FILE).forEach((group, index) => {
      const file = join(dir, `${label}-${index}.sql`);
      writeFileSync(file, group.join("\n"), "utf8");
      runWrangler(["execute"], options, ["--file", file]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Preflight — every command needs the capability fence; `apply` also needs a usable pipeline.
// ---------------------------------------------------------------------------

/** Every reserved table this CLI reads or writes. `setup-local.mjs` is the only thing that creates
 * them (`CREATE TABLE IF NOT EXISTS`, so re-running it upgrades an older local database). */
const RESERVED_TABLES = [
  "__quincy_local_capability", "__quincy_local_fixture_runs", "__quincy_local_fixture_entities",
  "__quincy_local_fixture_run_records", "__quincy_local_fixture_board_positions",
];

export function assertCapabilityPresent(executor) {
  const row = queryScalar(executor, `SELECT EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = '${CAPABILITY_KEY}') AS present;`);
  if (Number(row?.present) !== 1) {
    throw new Error("The QA fixture capability fence is not installed on this database. Run `npm run db:migrate:local` first (see setup-local.mjs).");
  }
  const present = new Set(executor.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${RESERVED_TABLES.map((t) => `'${t}'`).join(", ")});`).map((r) => r.name));
  const missing = RESERVED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(`This local database predates ${missing.join(", ")}. Re-run \`npm run db:migrate:local\` (it only adds the missing local-only tables) and try again.`);
  }
}

function assertApplyPrerequisites(executor) {
  const stages = queryScalar(executor, "SELECT COUNT(*) AS n FROM pipeline_stages WHERE active = 1;");
  if (Number(stages?.n) !== 5) throw new Error(`Expected 5 active pipeline_stages, found ${stages?.n}. Run the shared seed (\`seed/0001_seed.sql\`) first.`);
  const admin = queryScalar(executor, `SELECT active FROM user WHERE id = '${BOOTSTRAP_ADMIN_ID}';`);
  if (Number(admin?.active) !== 1) throw new Error("The bootstrap admin (seed/0001_seed.sql) is missing or inactive. Run the shared seed first.");
}

// ---------------------------------------------------------------------------
// Teardown-first — every `apply` begins here too, so re-running never doubles up.
// ---------------------------------------------------------------------------

function readRegistry(executor) {
  const entityRows = executor.query("SELECT id, kind FROM __quincy_local_fixture_entities;");
  const runRows = executor.query("SELECT id FROM __quincy_local_fixture_runs;");
  return { entities: entityRows.map((r) => ({ id: r.id, kind: r.kind })), runIds: runRows.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Rot-proof sweep (build spec item 1) — run AFTER teardown's own deletes, against ids captured
// BEFORE teardown emptied the registry. Introspects the live schema itself
// (`sqlite_master`/`PRAGMA table_info`/`PRAGMA foreign_key_list`) rather than a hand list, so a
// table added by a future migration that carries a `project_id` column or an FK to
// `projects`/`project_subtasks`/`collections` is swept automatically the first time this runs
// against it, not the first time it silently leaks a fixture row. `audit_log` and
// `notification_delivery_ledger`-via-`notification_outbox` (in practice: plain
// `notification_outbox.project_id`, which the generic column scan below already finds) are named
// explicitly in the build spec because `audit_log.target_id` has no FK at all — introspection alone
// can never discover it — so it is swept by name, the same way `sql.ts`'s teardown deletes it.
// ---------------------------------------------------------------------------

const SWEEP_IGNORED_TABLES = new Set([
  "__quincy_local_capability", "__quincy_local_fixture_runs", "__quincy_local_fixture_entities",
  "project_board_order_0037_rollback", // the migration's own historical snapshot, not the live board contract
]);
const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Same canonical-UUID shape `sql.ts`'s `UUID_RE` enforces on every id it inlines;
 * `qa-seed-wiring.guard.test.ts` cross-checks the two literals. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertSafeIdentifier(name, describe) {
  if (!SAFE_IDENTIFIER_RE.test(String(name))) {
    throw new Error(`Refusing to interpolate a non-identifier-shaped ${describe} discovered via schema introspection: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Every table (other than the ignored/capability ones) with a plain `project_id` column, or —
 * failing that — an FK to `projects`, `project_subtasks`, or `collections`, paired with the
 * registry id-kind its matching column should be checked against. */
function discoverSweepTargets(executor) {
  // `sqlite_%` is SQLite's own reserved prefix; `_cf_%` is wrangler/Miniflare's local D1 bookkeeping
  // (e.g. `_cf_METADATA`) — real, not app schema, and `PRAGMA table_info` on it comes back
  // `SQLITE_AUTH: not authorized` rather than a normal result, discovered by running this against a
  // real local D1 (a `sqlite_%`-only filter let it through and crashed the sweep outright).
  const tableRows = executor.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\';");
  const targets = [];
  for (const row of tableRows) {
    const table = assertSafeIdentifier(row.name, "table name");
    if (SWEEP_IGNORED_TABLES.has(table)) continue;
    const columns = executor.query(`PRAGMA table_info(${table});`).map((c) => c.name);
    if (columns.includes("project_id")) {
      targets.push({ table, column: "project_id", registryKind: "project" });
      continue;
    }
    const fks = executor.query(`PRAGMA foreign_key_list(${table});`);
    const fkTo = (parent) => fks.find((fk) => fk.table === parent);
    const projectsFk = fkTo("projects");
    const subtaskFk = fkTo("project_subtasks");
    const collectionFk = fkTo("collections");
    if (projectsFk) targets.push({ table, column: assertSafeIdentifier(projectsFk.from, "FK column"), registryKind: "project" });
    else if (subtaskFk) targets.push({ table, column: assertSafeIdentifier(subtaskFk.from, "FK column"), registryKind: "subtask" });
    else if (collectionFk) targets.push({ table, column: assertSafeIdentifier(collectionFk.from, "FK column"), registryKind: "collection" });
  }
  return targets;
}

function countMatchesChunked(executor, table, column, ids) {
  let total = 0;
  for (const group of chunk(ids, 400)) {
    if (group.length === 0) continue;
    const idList = group.map((id) => `'${id}'`).join(", ");
    const row = queryScalar(executor, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${idList});`);
    total += Number(row?.n ?? 0);
  }
  return total;
}

function countTypedMatchesChunked(executor, table, typeColumn, typeValue, idColumn, ids) {
  let total = 0;
  for (const group of chunk(ids, 400)) {
    if (group.length === 0) continue;
    const idList = group.map((id) => `'${id}'`).join(", ");
    const row = queryScalar(executor, `SELECT COUNT(*) AS n FROM ${table} WHERE ${typeColumn} = '${typeValue}' AND ${idColumn} IN (${idList});`);
    total += Number(row?.n ?? 0);
  }
  return total;
}

/** `registeredByKind` must be captured BEFORE teardown's own deletes ran — by the time this
 * function is called the registry itself is already empty. Fails loudly, naming every offending
 * table, rather than passing silently on "found nothing to check". */
function sweepForOrphans(executor, registeredByKind) {
  const failures = [];
  for (const { table, column, registryKind } of discoverSweepTargets(executor)) {
    const ids = registeredByKind[registryKind] ?? [];
    if (ids.length === 0) continue;
    const n = countMatchesChunked(executor, table, column, ids);
    if (n > 0) failures.push(`${table}.${column}: ${n} row(s) still reference a torn-down ${registryKind} id`);
  }
  // `audit_log` has no FK at all (`target_id` is untyped text) — PRAGMA foreign_key_list can never
  // discover it, so it is checked by name against both target types the app actually writes.
  const projectIds = registeredByKind.project ?? [];
  const subtaskIds = registeredByKind.subtask ?? [];
  let auditOrphans = 0;
  if (projectIds.length > 0) auditOrphans += countTypedMatchesChunked(executor, "audit_log", "target_type", "project", "target_id", projectIds);
  if (subtaskIds.length > 0) auditOrphans += countTypedMatchesChunked(executor, "audit_log", "target_type", "project_subtask", "target_id", subtaskIds);
  if (auditOrphans > 0) failures.push(`audit_log.target_id: ${auditOrphans} row(s) still reference a torn-down project/project_subtask id`);

  if (failures.length > 0) throw new Error(`Rot-proof sweep found orphaned rows after teardown:\n  - ${failures.join("\n  - ")}`);
}

export function teardown(executor) {
  const registry = readRegistry(executor);
  if (registry.entities.length === 0 && registry.runIds.length === 0) {
    console.log("==> No registered QA fixture rows found — nothing to tear down.");
    return;
  }
  console.log(`==> Tearing down ${registry.entities.length} registered fixture rows across ${registry.runIds.length} run(s)`);
  const registeredByKind = { project: [], subtask: [], collection: [], deadline_occurrence: [], member: [] };
  for (const entity of registry.entities) (registeredByKind[entity.kind] ??= []).push(entity.id);

  const { statements } = executor.emit("teardown-plan", [`--entities=${JSON.stringify(registry.entities)}`, `--run-ids=${JSON.stringify(registry.runIds)}`]);
  executor.run(statements, "teardown");

  const remainingEntities = queryScalar(executor, "SELECT COUNT(*) AS n FROM __quincy_local_fixture_entities;");
  const remainingRuns = queryScalar(executor, "SELECT COUNT(*) AS n FROM __quincy_local_fixture_runs;");
  const remainingProjects = queryScalar(executor, "SELECT COUNT(*) AS n FROM projects WHERE notes LIKE 'QA-FIXTURE-v1%';");
  if (Number(remainingEntities?.n) !== 0 || Number(remainingRuns?.n) !== 0 || Number(remainingProjects?.n) !== 0) {
    throw new Error(
      `Teardown did not reach zero: ${remainingEntities?.n} registered entities, ${remainingRuns?.n} runs, ` +
        `${remainingProjects?.n} sentinel-tagged projects remain.`,
    );
  }

  console.log("==> Running the rot-proof sweep (schema introspection, not a hand list)");
  sweepForOrphans(executor, registeredByKind);
  console.log("==> Teardown verified: zero registered fixture rows, zero sentinel-tagged projects remain, sweep clean.");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export function apply(executor, options) {
  assertApplyPrerequisites(executor);
  teardown(executor);

  const defaultEditorIds = executor.query(DEFAULT_EDITOR_QUERY).map((r) => r.id);
  const planArgs = [`--applied-at-ms=${Date.now()}`];
  if (options.tier) planArgs.push(`--tier=${options.tier}`);
  if (options.anchor) planArgs.push(`--anchor=${options.anchor}`);
  if (defaultEditorIds.length > 0) planArgs.push(`--default-editor-ids=${defaultEditorIds.join(",")}`);

  console.log("==> Building the fixture dataset");
  const plan = executor.emit("plan", planArgs);
  console.log(`==> Applying ${plan.statements.length} statements (anchor=${plan.anchor}, tiers=${plan.tiers.join(",")})`);
  executor.run(plan.statements, "apply");

  const registered = queryScalar(executor, `SELECT COUNT(*) AS n FROM __quincy_local_fixture_entities WHERE run_id = '${plan.runId}';`);
  if (Number(registered?.n) !== plan.entities.length) {
    throw new Error(`Expected ${plan.entities.length} registered entities for run ${plan.runId}, found ${registered?.n}.`);
  }
  const record = queryScalar(executor, `SELECT COUNT(*) AS n FROM __quincy_local_fixture_run_records WHERE run_id = '${plan.runId}';`);
  if (Number(record?.n) !== 1) throw new Error(`Expected exactly one recorded default-editor set for run ${plan.runId}, found ${record?.n}.`);
  const positions = queryScalar(executor, `SELECT COUNT(*) AS n FROM __quincy_local_fixture_board_positions WHERE run_id = '${plan.runId}';`);
  if (Number(positions?.n) !== plan.summary.projects) {
    throw new Error(`Expected ${plan.summary.projects} recorded board positions for run ${plan.runId}, found ${positions?.n}.`);
  }
  const sentinelProjects = queryScalar(executor, `SELECT COUNT(*) AS n FROM projects WHERE notes LIKE 'QA-FIXTURE-v1 · anchor=${plan.anchor} · tier=%';`);
  if (Number(sentinelProjects?.n) !== plan.summary.projects) {
    throw new Error(`Expected ${plan.summary.projects} sentinel-tagged projects, found ${sentinelProjects?.n}.`);
  }

  console.log(`==> Applied: ${plan.summary.projects} projects, ${plan.summary.subtasks} subtasks, ${plan.summary.collections} collections, ${plan.summary.deadlineOccurrences} deadline occurrences, ${plan.summary.members} members.`);
  console.log(`==> Run id: ${plan.runId}`);
}

// ---------------------------------------------------------------------------
// Verify — read-only, never writes (build spec item 2). Recomputes the dataset for the CURRENTLY
// APPLIED run's own recorded anchor/tier/applied-at (`__quincy_local_fixture_runs`) — not
// `Date.now()`, not whatever `--anchor`/`--tier` the caller passes — and diffs it against the
// database: exact id sets AND a per-column content fingerprint for every generator-owned table,
// including `project_members` (the old version silently skipped it). A `--anchor`/`--tier` the
// caller passes is an ASSERTION against the recorded run, not a new value to recompute against —
// mutating a fixture project's stage/priority/deadline, a subtask's schedule, or deleting a
// membership now makes this fail, and it is EXPECTED to fail after a browser pass has edited
// fixture rows: that is its job. Re-`apply` resets to the generator's own state.
// ---------------------------------------------------------------------------

/** `scope: "registry"` diffs the rows whose ids apply registered. `project_members` is instead
 * scoped to EVERY membership on a fixture project (`scope: "fixture-projects"`), so a membership the
 * app added after apply is reported as unexpected, not silently ignored for lacking a registry row —
 * memberships are verified present/absent exactly (Sol round 2, finding 6). */
const VERIFY_DIFF_TABLES = [
  { label: "projects", table: "projects", registryKind: "project", manifestKey: "projects", scope: "registry" },
  { label: "project_subtasks", table: "project_subtasks", registryKind: "subtask", manifestKey: "subtasks", scope: "registry" },
  { label: "collections", table: "collections", registryKind: "collection", manifestKey: "collections", scope: "registry" },
  { label: "project_deadline_occurrences", table: "project_deadline_occurrences", registryKind: "deadline_occurrence", manifestKey: "deadlineOccurrences", scope: "registry" },
  { label: "project_members", table: "project_members", registryKind: "member", manifestKey: "members", scope: "fixture-projects" },
];
const VERIFY_MAX_REPORTED_IDS = 10;

/** The generator-owned column set for a table is read off the manifest's OWN expected rows (any
 * one of them) rather than hand-listed here a second time — the two can never drift apart. `id` is
 * always included: with zero expected rows (e.g. a run that recorded no default editors) the actual
 * rows must STILL be fetched, or an unexpected row would be invisible — the old early `return {}`
 * here is how a disabled sole default editor made the membership check vanish (finding 6). */
function fingerprintColumnsOf(expectedRows) {
  const anyId = Object.keys(expectedRows)[0];
  const columns = anyId ? Object.keys(expectedRows[anyId]) : [];
  return columns.includes("id") ? columns : ["id", ...columns];
}

function fetchActualFingerprintRows(executor, table, registryKind, columns, scope) {
  const columnList = columns.map((c) => assertSafeIdentifier(c, "fingerprint column")).join(", ");
  const where = scope === "fixture-projects"
    ? "project_id IN (SELECT id FROM __quincy_local_fixture_entities WHERE kind = 'project')"
    : `id IN (SELECT id FROM __quincy_local_fixture_entities WHERE kind = '${registryKind}')`;
  const rows = executor.query(`SELECT ${columnList} FROM ${table} WHERE ${where};`);
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/** Exact, type-aware equality (finding 4): NULL is not `''`, `1` is not `"1"`, and a column the
 * database row does not have at all (`undefined`) matches nothing — not even an expected NULL.
 * No `String()` coercion anywhere. */
export function fingerprintValuesEqual(expected, actual) {
  if (actual === undefined || expected === undefined) return false;
  if (expected === null || actual === null) return expected === null && actual === null;
  if (typeof expected !== typeof actual) return false;
  return expected === actual;
}

function diffFingerprintTable(label, expectedTable, actualRowsById, failures) {
  const expectedIds = expectedTable.ids;
  const expectedIdSet = new Set(expectedIds);
  const actualIdSet = new Set(Object.keys(actualRowsById));

  const missing = expectedIds.filter((id) => !actualIdSet.has(id));
  if (missing.length > 0) {
    failures.push(`${label}: ${missing.length} expected id(s) missing from the database, e.g. ${missing.slice(0, VERIFY_MAX_REPORTED_IDS).join(", ")}`);
  }
  const unexpected = [...actualIdSet].filter((id) => !expectedIdSet.has(id));
  if (unexpected.length > 0) {
    failures.push(`${label}: ${unexpected.length} unexpected id(s) found, e.g. ${unexpected.slice(0, VERIFY_MAX_REPORTED_IDS).join(", ")}`);
  }

  const rowMismatches = [];
  for (const id of expectedIds) {
    const actualRow = actualRowsById[id];
    if (!actualRow) continue; // already reported as missing above
    const expectedRow = expectedTable.rows[id];
    const differingColumns = Object.keys(expectedRow).filter((column) => !fingerprintValuesEqual(expectedRow[column], actualRow[column]));
    if (differingColumns.length > 0) rowMismatches.push(`${id} (${differingColumns.join(", ")})`);
  }
  if (rowMismatches.length > 0) {
    failures.push(`${label}: ${rowMismatches.length} row(s) differ from the generator, e.g. ${rowMismatches.slice(0, VERIFY_MAX_REPORTED_IDS).join("; ")}`);
  }
}

/** What `apply` recorded about this run (`setup-local.mjs`'s run-record and board-position tables).
 * A run with no record — applied by a fixture version that predates recording — fails loudly: the
 * only other source for the editor set is today's `user` table, and falling back to it is exactly
 * the bug this replaces (finding 6). */
function readRunRecord(executor, runId) {
  if (!UUID_RE.test(String(runId))) throw new Error(`Refusing a non-canonical run id from the registry: ${JSON.stringify(runId)}`);
  const record = queryScalar(executor, `SELECT default_editor_ids FROM __quincy_local_fixture_run_records WHERE run_id = '${runId}';`);
  if (!record) {
    throw new Error(`Run ${runId} has no recorded default-editor set (it was applied before apply recorded one). Re-apply the fixture: \`npm run db:qa:apply\`.`);
  }
  const defaultEditorIds = String(record.default_editor_ids).split(",").filter(Boolean);
  for (const id of defaultEditorIds) {
    if (!UUID_RE.test(id)) throw new Error(`Recorded default-editor id is not a canonical UUID: ${JSON.stringify(id)}`);
  }
  const positionRows = executor.query(
    `SELECT e.id AS project_id, b.board_position AS board_position FROM __quincy_local_fixture_entities e LEFT JOIN __quincy_local_fixture_board_positions b ON b.project_id = e.id AND b.run_id = '${runId}' WHERE e.kind = 'project' AND e.run_id = '${runId}';`,
  );
  const unrecorded = positionRows.filter((row) => typeof row.board_position !== "number").map((row) => row.project_id);
  if (unrecorded.length > 0) {
    throw new Error(`Run ${runId} has no recorded board_position for ${unrecorded.length} project(s), e.g. ${unrecorded.slice(0, VERIFY_MAX_REPORTED_IDS).join(", ")}. Re-apply the fixture: \`npm run db:qa:apply\`.`);
  }
  return { defaultEditorIds, boardPositions: Object.fromEntries(positionRows.map((row) => [row.project_id, row.board_position])) };
}

export function verify(executor, options) {
  const runs = executor.query("SELECT id, tier, anchor, applied_at FROM __quincy_local_fixture_runs ORDER BY applied_at DESC;");
  if (runs.length === 0) throw new Error("No QA fixture run is registered. Run `npm run db:qa:apply` first.");
  if (runs.length > 1) {
    throw new Error(
      `Expected exactly one registered QA fixture run — every \`apply\` tears down before re-applying — found ${runs.length}. ` +
        "The database is in an inconsistent state; run `npm run db:qa:teardown` and re-apply.",
    );
  }
  const run = runs[0];

  if (options.anchor !== undefined && options.anchor !== run.anchor) {
    throw new Error(
      `--anchor=${options.anchor} does not match the applied run's own anchor (${run.anchor}). ` +
        "`verify` checks the CURRENTLY APPLIED run, not a hypothetical one — re-apply with that anchor first if that's what you want to check.",
    );
  }
  const recordedTierSet = [...new Set(String(run.tier).split(","))].sort();
  if (options.tier !== undefined) {
    const requestedTierSet = [...new Set(options.tier.split(","))].sort();
    if (JSON.stringify(requestedTierSet) !== JSON.stringify(recordedTierSet)) {
      throw new Error(
        `--tier=${options.tier} does not match the applied run's own tier (${run.tier}). ` +
          "`verify` checks the CURRENTLY APPLIED run, not a hypothetical one — re-apply with that tier first if that's what you want to check.",
      );
    }
  }

  // Recomputed against the RECORDED run's own anchor/tier/applied-at — never the caller's values,
  // never `Date.now()` — so occurrence status (the one apply-time-dependent field, item 4) is
  // reproduced exactly as this run actually inserted it, not as a fresh apply would today. The
  // default-editor set and every project's board_position are likewise the values THIS run recorded
  // (findings 5 and 6) — never today's editors, never a column left out of the comparison.
  const { defaultEditorIds, boardPositions } = readRunRecord(executor, run.id);
  const manifestArgs = [`--anchor=${run.anchor}`, `--tier=${run.tier}`, `--applied-at-ms=${run.applied_at}`, `--board-positions=${JSON.stringify(boardPositions)}`];
  if (defaultEditorIds.length > 0) manifestArgs.push(`--default-editor-ids=${defaultEditorIds.join(",")}`);
  const manifest = executor.emit("manifest", manifestArgs);

  const failures = [];
  for (const { label, table, registryKind, manifestKey, scope } of VERIFY_DIFF_TABLES) {
    const expectedTable = manifest[manifestKey];
    const columns = fingerprintColumnsOf(expectedTable.rows);
    const actualRowsById = fetchActualFingerprintRows(executor, table, registryKind, columns, scope);
    diffFingerprintTable(label, expectedTable, actualRowsById, failures);
  }

  const fkViolations = executor.query("PRAGMA foreign_key_check;");
  if (fkViolations.length > 0) failures.push(`${fkViolations.length} foreign_key_check violation(s)`);

  if (failures.length > 0) throw new Error(`Verify failed:\n  - ${failures.join("\n  - ")}`);
  console.log(
    `==> Verified: run ${run.id} (anchor=${run.anchor}, tier=${run.tier}) matches the database exactly — id sets and content fingerprints ` +
      `for ${manifest.summary.projects} projects, ${manifest.summary.subtasks} subtasks, ${manifest.summary.collections} collections, ` +
      `${manifest.summary.deadlineOccurrences} deadline occurrences, ${manifest.summary.members} members.`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const executor = wranglerExecutor(options);
  assertCapabilityPresent(executor);
  if (options.command === "apply") return apply(executor, options);
  if (options.command === "teardown") return teardown(executor);
  return verify(executor, options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\nQA fixture ${process.argv[2] ?? ""} failed: ${error.message}`);
    process.exit(1);
  });
}
