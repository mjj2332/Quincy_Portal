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
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ASSIGNMENT_ELIGIBLE_ROLES } from "@quincy/shared";
import { parseArguments, wranglerArguments, DEFAULT_EDITOR_ELIGIBLE_ROLES } from "../qa-seed/cli.mjs";
import { QA_FIXTURE_CAPABILITY_SQL } from "../setup-local.mjs";
import { buildQaFixtureDataset } from "../qa-seed/dataset";
import { buildApplyPlan, buildTeardownStatements, CAPABILITY_PREDICATE, type FixtureEntity } from "../qa-seed/sql";

const qaSeedDir = fileURLToPath(new URL("../qa-seed/", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
const workflowsDir = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const sharedSeed = readFileSync(new URL("../seed/0001_seed.sql", import.meta.url), "utf8");

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

  it("rejects --tier on teardown/verify and --anchor on teardown", () => {
    expect(() => parseArguments(["teardown", "--tier=core"])).toThrow(/--tier. only applies to .apply/);
    expect(() => parseArguments(["teardown", "--anchor=2026-09-21"])).toThrow(/--anchor. does not apply to .teardown/);
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
  });

  it("accepts known --tier values", () => {
    expect(() => parseArguments(["apply", "--tier=core,density"])).not.toThrow();
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

  it("is not referenced by any GitHub Actions workflow", () => {
    let workflowFiles: string[] = [];
    try {
      workflowFiles = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    } catch {
      workflowFiles = [];
    }
    for (const file of workflowFiles) {
      const contents = readFileSync(new URL(file, `file://${workflowsDir}`), "utf8");
      expect(contents).not.toMatch(/qa:apply|qa:teardown|qa:verify|qa-seed\/cli\.mjs/);
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
  });
});

describe("guard: the default-editor role predicate cannot drift from the shared source", () => {
  it("matches PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor exactly", () => {
    expect([...DEFAULT_EDITOR_ELIGIBLE_ROLES].sort()).toEqual([...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor].sort());
  });
});

describe("guard: every generated mutator statement carries the capability predicate", () => {
  const dataset = buildQaFixtureDataset({ anchor: "2026-09-21", tiers: ["core", "density"], defaultEditorIds: ["6b851dc8-14cf-4f90-bd29-ce6c27f86385"] });
  const plan = buildApplyPlan(dataset, { runId: "11111111-1111-5111-8111-111111111111", appliedAtMs: 1_700_000_000_000, createdBy: "6b851dc8-14cf-4f90-bd29-ce6c27f86385" });

  it("produces at least one statement per row kind, so this test cannot pass vacuously", () => {
    expect(plan.statements.length).toBeGreaterThan(dataset.projects.length + dataset.subtasks.length);
  });

  it("guards every apply statement (inserts and registrations)", () => {
    for (const statement of plan.statements) expect(statement).toContain(CAPABILITY_PREDICATE);
  });

  it("guards every teardown statement", () => {
    const entities: FixtureEntity[] = plan.entities;
    const teardown = buildTeardownStatements(entities, [plan.runId]);
    expect(teardown.length).toBeGreaterThan(0);
    for (const statement of teardown) expect(statement).toContain(CAPABILITY_PREDICATE);
  });

  it("never touches project_board_order_0037_rollback", () => {
    for (const statement of plan.statements) expect(statement).not.toContain("project_board_order_0037_rollback");
    const teardown = buildTeardownStatements(plan.entities, [plan.runId]);
    for (const statement of teardown) expect(statement).not.toContain("project_board_order_0037_rollback");
  });

  it("never emits a bare wrangler invocation string (no `wrangler d1 execute --remote`) anywhere in generated SQL", () => {
    for (const statement of [...plan.statements, ...buildTeardownStatements(plan.entities, [plan.runId])]) {
      expect(statement).not.toContain("--remote");
    }
  });
});
