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
      if (command !== "apply") throw new Error(`\`--tier\` only applies to \`apply\`, not \`${command}\`.`);
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

function queryScalar(options, sql) {
  return queryRows(options, sql).at(0);
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

function assertCapabilityPresent(options) {
  const row = queryScalar(options, `SELECT EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = '${CAPABILITY_KEY}') AS present;`);
  if (Number(row?.present) !== 1) {
    throw new Error("The QA fixture capability fence is not installed on this database. Run `npm run db:migrate:local` first (see setup-local.mjs).");
  }
}

function assertApplyPrerequisites(options) {
  const stages = queryScalar(options, "SELECT COUNT(*) AS n FROM pipeline_stages WHERE active = 1;");
  if (Number(stages?.n) !== 5) throw new Error(`Expected 5 active pipeline_stages, found ${stages?.n}. Run the shared seed (\`seed/0001_seed.sql\`) first.`);
  const admin = queryScalar(options, `SELECT active FROM user WHERE id = '${BOOTSTRAP_ADMIN_ID}';`);
  if (Number(admin?.active) !== 1) throw new Error("The bootstrap admin (seed/0001_seed.sql) is missing or inactive. Run the shared seed first.");
}

// ---------------------------------------------------------------------------
// Teardown-first — every `apply` begins here too, so re-running never doubles up.
// ---------------------------------------------------------------------------

function readRegistry(options) {
  const entityRows = queryRows(options, "SELECT id, kind FROM __quincy_local_fixture_entities;");
  const runRows = queryRows(options, "SELECT id FROM __quincy_local_fixture_runs;");
  return { entities: entityRows.map((r) => ({ id: r.id, kind: r.kind })), runIds: runRows.map((r) => r.id) };
}

function teardown(options) {
  const registry = readRegistry(options);
  if (registry.entities.length === 0 && registry.runIds.length === 0) {
    console.log("==> No registered QA fixture rows found — nothing to tear down.");
    return;
  }
  console.log(`==> Tearing down ${registry.entities.length} registered fixture rows across ${registry.runIds.length} run(s)`);
  const { statements } = runEmit("teardown-plan", [`--entities=${JSON.stringify(registry.entities)}`, `--run-ids=${JSON.stringify(registry.runIds)}`]);
  applyStatements(options, statements, "teardown");

  const remainingEntities = queryScalar(options, "SELECT COUNT(*) AS n FROM __quincy_local_fixture_entities;");
  const remainingRuns = queryScalar(options, "SELECT COUNT(*) AS n FROM __quincy_local_fixture_runs;");
  const remainingProjects = queryScalar(options, "SELECT COUNT(*) AS n FROM projects WHERE notes LIKE 'QA-FIXTURE-v1%';");
  if (Number(remainingEntities?.n) !== 0 || Number(remainingRuns?.n) !== 0 || Number(remainingProjects?.n) !== 0) {
    throw new Error(
      `Teardown did not reach zero: ${remainingEntities?.n} registered entities, ${remainingRuns?.n} runs, ` +
        `${remainingProjects?.n} sentinel-tagged projects remain.`,
    );
  }
  console.log("==> Teardown verified: zero registered fixture rows, zero sentinel-tagged projects remain.");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function apply(options) {
  assertApplyPrerequisites(options);
  teardown(options);

  const defaultEditorIds = queryRows(options, DEFAULT_EDITOR_QUERY).map((r) => r.id);
  const planArgs = [`--applied-at-ms=${Date.now()}`];
  if (options.tier) planArgs.push(`--tier=${options.tier}`);
  if (options.anchor) planArgs.push(`--anchor=${options.anchor}`);
  if (defaultEditorIds.length > 0) planArgs.push(`--default-editor-ids=${defaultEditorIds.join(",")}`);

  console.log("==> Building the fixture dataset");
  const plan = runEmit("plan", planArgs);
  console.log(`==> Applying ${plan.statements.length} statements (anchor=${plan.anchor}, tiers=${plan.tiers.join(",")})`);
  applyStatements(options, plan.statements, "apply");

  const registered = queryScalar(options, `SELECT COUNT(*) AS n FROM __quincy_local_fixture_entities WHERE run_id = '${plan.runId}';`);
  if (Number(registered?.n) !== plan.entities.length) {
    throw new Error(`Expected ${plan.entities.length} registered entities for run ${plan.runId}, found ${registered?.n}.`);
  }
  const sentinelProjects = queryScalar(options, `SELECT COUNT(*) AS n FROM projects WHERE notes LIKE 'QA-FIXTURE-v1 · anchor=${plan.anchor} · tier=%';`);
  if (Number(sentinelProjects?.n) !== plan.summary.projects) {
    throw new Error(`Expected ${plan.summary.projects} sentinel-tagged projects, found ${sentinelProjects?.n}.`);
  }

  console.log(`==> Applied: ${plan.summary.projects} projects, ${plan.summary.subtasks} subtasks, ${plan.summary.collections} collections, ${plan.summary.deadlineOccurrences} deadline occurrences, ${plan.summary.members} members.`);
  console.log(`==> Run id: ${plan.runId}`);
}

// ---------------------------------------------------------------------------
// Verify — read-only. Recomputes the expected shape from the same generator and diffs it against
// what is actually in the database; never writes.
// ---------------------------------------------------------------------------

function verify(options) {
  const runs = queryRows(options, "SELECT id, tier, anchor, applied_at FROM __quincy_local_fixture_runs ORDER BY applied_at DESC;");
  if (runs.length === 0) throw new Error("No QA fixture run is registered. Run `npm run db:qa:apply` first.");
  const latest = runs[0];
  const tier = options.tier ?? latest.tier;
  const anchor = options.anchor ?? latest.anchor;

  const manifestArgs = [`--anchor=${anchor}`, `--tier=${tier}`];
  const manifest = runEmit("manifest", manifestArgs);

  const failures = [];
  const checks = [
    ["projects", manifest.projectIds.length],
    ["project_subtasks", manifest.subtaskIds.length],
    ["collections", manifest.collectionIds.length],
    ["project_deadline_occurrences", manifest.deadlineOccurrenceIds.length],
  ];
  for (const [table, expected] of checks) {
    const actual = queryScalar(options, `SELECT COUNT(*) AS n FROM ${table} WHERE id IN (SELECT id FROM __quincy_local_fixture_entities WHERE kind = '${table === "projects" ? "project" : table === "project_subtasks" ? "subtask" : table === "collections" ? "collection" : "deadline_occurrence"}');`);
    if (Number(actual?.n) !== expected) failures.push(`${table}: expected ${expected}, found ${actual?.n}`);
  }

  const sentinel = queryScalar(options, `SELECT COUNT(*) AS n FROM projects WHERE id IN (SELECT id FROM __quincy_local_fixture_entities WHERE kind = 'project') AND notes NOT LIKE 'QA-FIXTURE-v1%';`);
  if (Number(sentinel?.n) !== 0) failures.push(`${sentinel?.n} registered projects are missing the QA-FIXTURE-v1 sentinel in notes`);

  const fkViolations = queryRows(options, "PRAGMA foreign_key_check;");
  if (fkViolations.length > 0) failures.push(`${fkViolations.length} foreign_key_check violation(s)`);

  if (failures.length > 0) throw new Error(`Verify failed:\n  - ${failures.join("\n  - ")}`);
  console.log(`==> Verified: run ${latest.id} (anchor=${anchor}, tier=${tier}) matches the database. ${manifest.summary.projects} projects, ${manifest.summary.subtasks} subtasks, ${manifest.summary.collections} collections, ${manifest.summary.deadlineOccurrences} deadline occurrences.`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertCapabilityPresent(options);
  if (options.command === "apply") return apply(options);
  if (options.command === "teardown") return teardown(options);
  return verify(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`\nQA fixture ${process.argv[2] ?? ""} failed: ${error.message}`);
    process.exit(1);
  });
}
