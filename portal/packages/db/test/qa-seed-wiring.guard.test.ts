/**
 * QA scheduling fixture wiring guard (#220 follow-on). Mirrors `local-setup-wiring.guard.test.ts`:
 * this file proves the *wiring* — every wrangler invocation the transport layer can construct is
 * pinned local, every forbidden flag throws before a subprocess could be spawned, no committed
 * `.sql` artifact exists, no CI workflow references the fixture scripts, and — the layer specific
 * to this fixture — every generated mutator statement (apply AND teardown) carries the capability
 * predicate. Nothing here proves your own `.wrangler/state` has the fixture applied; that is a
 * runtime claim, closed by `npm run db:qa:verify`, not by this file.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ASSIGNMENT_ELIGIBLE_ROLES } from "@quincy/shared";
import { parseArguments, wranglerArguments, DEFAULT_EDITOR_ELIGIBLE_ROLES, SAFE_IDENTIFIER_RE as CLI_SAFE_IDENTIFIER_RE, UUID_RE as CLI_UUID_RE } from "../qa-seed/cli.mjs";
import { QA_FIXTURE_CAPABILITY_SQL } from "../setup-local.mjs";
import { anchorReferenceInstantMs, buildQaFixtureDataset } from "../qa-seed/dataset";
import { buildApplyPlan, CAPABILITY_PREDICATE, FIXTURE_BOARD_POSITIONS_TABLE, FIXTURE_RUN_RECORDS_TABLE, UUID_RE } from "../qa-seed/sql";
import { FIXTURE_CLOSURE_TABLE, SAFE_IDENTIFIER_RE } from "../qa-seed/teardown-graph";
import { freshFixtureDatabase, liveTeardownPlan } from "./qa-seed-sqlite-executor";

const qaSeedDir = fileURLToPath(new URL("../qa-seed/", import.meta.url));
const dbPackageDir = fileURLToPath(new URL("../", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
// `test/` -> `packages/db/` -> `packages/` -> `portal/` -> repo root -> `.github/workflows/`. This
// file lives at `portal/packages/db/test/`, so the real repo-root workflow directory
// (`.github/workflows/portal.yml`) needs FOUR `..` segments, not three — the old three-segment path
// resolved to `portal/.github/workflows/` (which does not exist), so `readdirSync` threw ENOENT,
// the catch below turned that into an empty list, and the "not referenced by any workflow" checks
// after it passed vacuously no matter what `.github/workflows/portal.yml` actually contained.
const workflowsDir = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url));
const sharedSeed = readFileSync(new URL("../seed/0001_seed.sql", import.meta.url), "utf8");

const ANCHOR = "2026-09-21";
const APPLIED_AT_MS = anchorReferenceInstantMs(ANCHOR);

const SUBCOMMANDS = [["migrations", "apply"], ["execute"]] as const;

describe("guard: the QA fixture runner cannot be pointed at production", () => {
  it.each(SUBCOMMANDS)("passes --local for `d1 %s`", (...subcommand) => {
    expect(wranglerArguments(subcommand, {})).toContain("--local");
  });

  it.each(SUBCOMMANDS)("pins the database name and config for `d1 %s`", (...subcommand) => {
    const args = wranglerArguments(subcommand, {});
    expect(args).toContain("quincy-portal");
    expect(args).toContain("../../workers/app/wrangler.jsonc");
  });

  it("keeps --local when isolated persistence is requested", () => {
    const options = parseArguments(["apply", "--persist-to", "/tmp/scratch"]);
    expect(wranglerArguments(["execute"], options)).toContain("--local");
  });

  it.each(["--remote", "--env", "--config", "--database", "--preview", "--file", "--command"])("refuses %s before any subcommand form", (flag) => {
    expect(() => parseArguments(["apply", flag, "production"])).toThrow(/local-only/);
    expect(() => parseArguments(["apply", `${flag}=production`])).toThrow(/local-only/);
  });

  it("requires a known command as the first argument", () => {
    expect(() => parseArguments([])).toThrow(/must be one of apply, teardown, verify/);
    expect(() => parseArguments(["--remote"])).toThrow(/must be one of apply, teardown, verify/);
    expect(() => parseArguments(["destroy"])).toThrow(/must be one of apply, teardown, verify/);
  });

  it("refuses arguments it does not recognise rather than passing them through", () => {
    expect(() => parseArguments(["apply", "--json"])).toThrow(/Unknown argument/);
  });

  it("accepts only --tier, --anchor and --persist-to", () => {
    expect(parseArguments(["apply", "--tier=core,density", "--anchor=2026-09-21", "--persist-to", "/tmp/scratch"])).toEqual({
      command: "apply", tier: "core,density", anchor: "2026-09-21", persistTo: "/tmp/scratch",
    });
    expect(parseArguments(["teardown"])).toEqual({ command: "teardown", tier: undefined, anchor: undefined, persistTo: undefined });
  });

  it("rejects --tier on teardown, and --anchor on teardown", () => {
    expect(() => parseArguments(["teardown", "--tier=core"])).toThrow(/--tier. only applies to .apply. or .verify/);
    expect(() => parseArguments(["teardown", "--anchor=2026-09-21"])).toThrow(/--anchor. does not apply to .teardown/);
  });

  // Item 6: the CLI's own usage docstring documents `verify --tier=core,density`, and `verify()`
  // has always supported it (item 2 — after that fix, `--tier`/`--anchor` on `verify` are
  // ASSERTIONS against the applied run's own recorded tier/anchor, not new values to recompute
  // against) — but the parser used to reject it outright before either code path ever ran.
  it("accepts --tier on verify (documented, and required by item 2's recorded-run assertion)", () => {
    expect(parseArguments(["verify", "--tier=core,density"])).toEqual({
      command: "verify", tier: "core,density", anchor: undefined, persistTo: undefined,
    });
    expect(() => parseArguments(["verify", "--tier=core,density", "--anchor=2026-09-21"])).not.toThrow();
  });

  // A `--persist-to` value is never checked against FORBIDDEN_ARGUMENTS — it is consumed whole as
  // the *value* of the flag before it, so a caller can smuggle `--remote` (or any other flag) past
  // that check and into wrangler's argv, right after `--local`. These prove the smuggle is refused.
  it.each([
    ["apply", "--persist-to", "--remote"],
    ["apply", "--persist-to=--remote"],
    ["apply", "--persist-to", "--env=production"],
    ["apply", "--persist-to="],
  ])("refuses a --persist-to value that smuggles another flag: %j", (...argv) => {
    expect(() => parseArguments(argv)).toThrow(/local-only/);
  });

  it("normalises an accepted --persist-to value to an absolute path", () => {
    const options = parseArguments(["apply", "--persist-to", "scratch/state"]);
    expect(options.persistTo).toBe(resolve(process.cwd(), "scratch/state"));
    expect(options.persistTo.startsWith("/")).toBe(true);
  });

  it("refuses a malformed --anchor before any subprocess could be spawned", () => {
    // Currently accepted by parseArguments verbatim: a trailing ` --remote` never reaches wrangler
    // (only `emit.ts`, over argv, not a shell) but it is not a real calendar date either, and should
    // be refused here rather than surfacing as an opaque failure out of a spawned subprocess.
    expect(() => parseArguments(["apply", "--anchor=2026-09-21 --remote"])).toThrow(/valid YYYY-MM-DD/);
    expect(() => parseArguments(["apply", "--anchor=2026-13-40"])).toThrow(/valid YYYY-MM-DD/);
    expect(() => parseArguments(["apply", "--anchor=2026-02-30"])).toThrow(/valid YYYY-MM-DD/);
    expect(() => parseArguments(["apply", "--anchor=not-a-date"])).toThrow(/valid YYYY-MM-DD/);
  });

  it("accepts a real calendar-date --anchor", () => {
    expect(() => parseArguments(["apply", "--anchor=2026-09-21"])).not.toThrow();
  });

  it("refuses an unknown --tier", () => {
    expect(() => parseArguments(["apply", "--tier=core,nonsense"])).toThrow(/Unknown tier/);
    expect(() => parseArguments(["apply", "--tier=nonsense"])).toThrow(/Unknown tier/);
    expect(() => parseArguments(["verify", "--tier=nonsense"])).toThrow(/Unknown tier/);
  });

  it("accepts known --tier values", () => {
    expect(() => parseArguments(["apply", "--tier=core,density"])).not.toThrow();
    expect(() => parseArguments(["verify", "--tier=core,density"])).not.toThrow();
  });

  // Property assertion: whatever a caller manages to get *accepted*, nothing beyond the fixed,
  // known flags this file itself pins should ever start with `-` in the resulting wrangler argv —
  // that is the shape a smuggled flag would need to reach wrangler.
  const KNOWN_FIXED_FLAGS = new Set(["--local", "--config", "--persist-to", "--json", "--command", "--file"]);
  const ACCEPTED_ARGV_TABLE = [
    ["teardown"],
    ["apply", "--persist-to", "/tmp/scratch"],
    ["apply", "--persist-to", "scratch/state"],
    ["apply", "--persist-to=scratch/state"],
    ["apply", "--tier=core,density", "--anchor=2026-09-21"],
    ["verify", "--anchor=2026-09-21"],
    ["verify", "--tier=core,density", "--anchor=2026-09-21"],
  ];
  it.each(ACCEPTED_ARGV_TABLE)("keeps every non-fixed argv element flag-shape-free: %j", (...argv) => {
    const options = parseArguments(argv);
    for (const subcommand of SUBCOMMANDS) {
      const args = wranglerArguments(subcommand, options);
      for (const element of args) {
        if (KNOWN_FIXED_FLAGS.has(element)) continue;
        expect(element.startsWith("-")).toBe(false);
      }
    }
  });
});

describe("guard: no committed SQL artifact, no CI wiring", () => {
  it("has no .sql file anywhere under qa-seed/", () => {
    const entries = readdirSync(qaSeedDir);
    const sqlFiles = entries.filter((name) => name.endsWith(".sql"));
    expect(sqlFiles).toEqual([]);
  });

  const CI_WIRING_FORBIDDEN_RE = /qa:apply|qa:teardown|qa:verify|qa-seed\/cli\.mjs/;

  it("the detector itself actually fires on a fixture string — this test cannot pass vacuously", () => {
    // Proves the regex isn't dead weight before trusting it against the real workflow directory
    // below (item 3): a realistic snippet that WOULD wire the fixture into CI must be caught.
    const fixtureWorkflowSnippet = "jobs:\n  qa:\n    steps:\n      - run: npm run db:qa:apply\n";
    expect(fixtureWorkflowSnippet).toMatch(CI_WIRING_FORBIDDEN_RE);
    expect("npm run qa:teardown -w @quincy/db").toMatch(CI_WIRING_FORBIDDEN_RE);
    expect("node ./packages/db/qa-seed/cli.mjs apply").toMatch(CI_WIRING_FORBIDDEN_RE);
    expect("npm run build -w @quincy/web").not.toMatch(CI_WIRING_FORBIDDEN_RE);
  });

  it("is not referenced by any GitHub Actions workflow", () => {
    // The old three-`..`-segment path resolved to `portal/.github/workflows/` (does not exist);
    // `readdirSync` threw ENOENT, the old code caught it into an empty list, and the loop below
    // ran zero times — vacuous pass no matter what the real workflow contained. A guard must not
    // pass on "nothing found": if the directory is missing, or exists but holds no workflow files,
    // that is itself a failure, not silently skipped work.
    expect(statSync(workflowsDir).isDirectory()).toBe(true);
    const workflowFiles = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const file of workflowFiles) {
      const contents = readFileSync(join(workflowsDir, file), "utf8");
      expect(contents).not.toMatch(CI_WIRING_FORBIDDEN_RE);
    }
  });

  it("keeps the reserved capability identifiers and fixture markers out of migrations", () => {
    const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const contents = readFileSync(new URL(file, `file://${migrationsDir}`), "utf8");
      expect(contents).not.toContain("__quincy_local_");
      expect(contents).not.toContain("QA-FIXTURE-v1");
      expect(contents).not.toContain("QA FIXTURE");
    }
  });

  it("keeps the reserved capability identifiers and fixture markers out of the all-environments seed", () => {
    expect(sharedSeed).not.toContain("__quincy_local_");
    expect(sharedSeed).not.toContain("QA-FIXTURE-v1");
    expect(sharedSeed).not.toContain("QA FIXTURE");
  });

  it("only setup-local.mjs (never a migration or the shared seed) creates the capability tables", () => {
    expect(QA_FIXTURE_CAPABILITY_SQL).toContain("__quincy_local_capability");
    expect(QA_FIXTURE_CAPABILITY_SQL).toContain("__quincy_local_fixture_runs");
    expect(QA_FIXTURE_CAPABILITY_SQL).toContain("__quincy_local_fixture_entities");
    expect(QA_FIXTURE_CAPABILITY_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${FIXTURE_RUN_RECORDS_TABLE} (`);
    expect(QA_FIXTURE_CAPABILITY_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${FIXTURE_BOARD_POSITIONS_TABLE} (`);
    expect(QA_FIXTURE_CAPABILITY_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${FIXTURE_CLOSURE_TABLE} (`);
  });

  // Extends the check above beyond "migrations + seed": the reserved `__quincy_local_` identifiers
  // must never appear ANYWHERE under `packages/db` except `setup-local.mjs` itself (which creates
  // the tables), `qa-seed/*` (which the capability fence requires reference them), and this guard
  // test's own two files (which necessarily quote them to test them).
  const RESERVED_IDENTIFIER_ALLOWLIST = new Set([
    "setup-local.mjs",
    join("test", "qa-seed-wiring.guard.test.ts"),
    join("test", "qa-seed-teardown.test.ts"),
  ]);
  const SCANNABLE_EXTENSIONS = [".ts", ".mjs", ".js"];
  const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git", "migrations", "seed"]); // covered by their own dedicated checks above

  function walkFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        out.push(...walkFiles(join(dir, entry.name)));
      } else {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  it("schema.ts never declares the reserved capability tables (they must stay out of Drizzle entirely)", () => {
    const schemaSource = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");
    expect(schemaSource).not.toContain("__quincy_local_");
  });

  it("no script under packages/db outside the allowlist (setup-local.mjs, qa-seed/*, this guard's own test files) references the reserved identifiers", () => {
    const allFiles = walkFiles(dbPackageDir).filter((file) => SCANNABLE_EXTENSIONS.includes(file.slice(file.lastIndexOf("."))));
    const checked: string[] = [];
    for (const file of allFiles) {
      const rel = relative(dbPackageDir, file);
      if (rel.startsWith(`qa-seed${sep}`) || rel === "qa-seed") continue; // qa-seed/* OWNS these identifiers
      if (RESERVED_IDENTIFIER_ALLOWLIST.has(rel)) continue;
      checked.push(rel);
      const contents = readFileSync(file, "utf8");
      expect(contents, `${rel} should not reference the reserved __quincy_local_ identifiers`).not.toContain("__quincy_local_");
    }
    // So this test cannot pass vacuously if the walk itself turned up nothing.
    expect(checked.length).toBeGreaterThan(10);
  });
});

describe("guard: the default-editor role predicate cannot drift from the shared source", () => {
  it("matches PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor exactly", () => {
    expect([...DEFAULT_EDITOR_ELIGIBLE_ROLES].sort()).toEqual([...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor].sort());
  });
});

describe("guard: cli.mjs's id check cannot drift from sql.ts's", () => {
  it("cli.mjs's UUID_RE is the same canonical-UUID pattern sql.ts inlines ids under", () => {
    expect(CLI_UUID_RE.source).toBe(UUID_RE.source);
    expect(CLI_UUID_RE.flags).toBe(UUID_RE.flags);
  });

  it("cli.mjs's SAFE_IDENTIFIER_RE is the same pattern teardown-graph.ts validates introspected identifiers under", () => {
    expect(CLI_SAFE_IDENTIFIER_RE.source).toBe(SAFE_IDENTIFIER_RE.source);
    expect(CLI_SAFE_IDENTIFIER_RE.flags).toBe(SAFE_IDENTIFIER_RE.flags);
  });
});

describe("guard: every generated mutator statement carries the capability predicate", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"], appliedAtMs: APPLIED_AT_MS, defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });
  const plan = buildApplyPlan(dataset, { runId: "11111111-1111-5111-8111-111111111111", appliedAtMs: 1_700_000_000_000, createdBy: "6b851dc8-14cf-4f90-bd29-ce6c27f86385", defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });

  it("produces at least one statement per row kind, so this test cannot pass vacuously", () => {
    expect(plan.statements.length).toBeGreaterThan(dataset.projects.length + dataset.subtasks.length);
  });

  it("guards every apply statement (inserts and registrations)", () => {
    for (const statement of plan.statements) expect(statement).toContain(CAPABILITY_PREDICATE);
  });

  // The teardown plan is derived from the live FK graph (`teardown-graph.ts`); built here exactly as
  // cli.mjs builds it — its own introspection SQL against a database made from the real migrations.
  const liveDb = freshFixtureDatabase();
  const teardownPlan = liveTeardownPlan(liveDb, [plan.runId]).plan;
  liveDb.close();
  const teardownMutators = [...teardownPlan.captureRootStatements, ...teardownPlan.captureRoundStatements, ...teardownPlan.deleteStatements, ...teardownPlan.registryStatements];

  it("guards every teardown statement", () => {
    expect(teardownMutators.length).toBeGreaterThan(0);
    for (const statement of teardownMutators) expect(statement).toContain(CAPABILITY_PREDICATE);
  });

  it("never touches project_board_order_0037_rollback", () => {
    for (const statement of plan.statements) expect(statement).not.toContain("project_board_order_0037_rollback");
    for (const statement of teardownMutators) expect(statement).not.toContain("project_board_order_0037_rollback");
  });

  it("never emits a bare wrangler invocation string (no `wrangler d1 execute --remote`) anywhere in generated SQL", () => {
    for (const statement of [...plan.statements, ...teardownMutators, ...teardownPlan.sweepQueries, ...teardownPlan.remainingQueries]) {
      expect(statement).not.toContain("--remote");
    }
  });
});
