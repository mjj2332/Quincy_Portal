/**
 * Local-setup wiring guard — `db:migrate:local` must stay the one command that brings a local
 * database to the state production is in, and must stay incapable of reaching production (#160).
 *
 * **Be clear about what this can and cannot prove.** Nothing in CI can assert that *your*
 * `.wrangler/state` has the Board flag enabled — that state is per-worktree, on your disk, and no
 * test runs against it. What is falsifiable is the wiring: that the command still performs the
 * enable, that it targets the flag the application actually reads, that it refuses to report
 * success when the flag did not land, and that every wrangler invocation it can construct is
 * pinned to `--local`. Delete the enable step or drop `--local` and these fail; wipe your own D1
 * and they do not. The end-to-end claim in #160 — drag handles rendering `data-disabled="false"`
 * — is closed by a browser pass, not by this file.
 *
 * It also covers the shared-seed step (#252): the real `setupLocal` sequence is run against an
 * in-memory SQLite built from the real migrations, so a missing or skipped seed fails here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_CONTRACT_FLAG } from "../src/board-schema-variant";
import { DEFAULT_STAGES } from "@quincy/shared";
import {
  assertFlagEnabled,
  assertSchemaMarkerPresent,
  assertSeedApplied,
  BOOTSTRAP_ADMIN_ID,
  LOCAL_FLAG_SQL,
  main,
  parseArguments,
  SEED_PATH,
  SEED_STAGE_KEYS,
  seedWarnings,
  setupLocal,
  wranglerArguments,
} from "../setup-local.mjs";
import { BOOTSTRAP_ADMIN_ID as DATASET_BOOTSTRAP_ADMIN_ID } from "../qa-seed/dataset";
import { fakeWranglerSpawn, openMemoryDatabase, sqliteSetupExecutor } from "./qa-seed-sqlite-executor";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const setupSource = readFileSync(new URL("../setup-local.mjs", import.meta.url), "utf8");
const sharedSeed = readFileSync(new URL("../seed/0001_seed.sql", import.meta.url), "utf8");

const SUBCOMMANDS = [["migrations", "apply"], ["execute"]] as const;

describe("guard: db:migrate:local is wired to the local setup runner", () => {
  it("runs setup-local.mjs rather than wrangler directly", () => {
    // A bare `wrangler d1 migrations apply` leaves the Board disabled — that is the #160 bug.
    expect(packageJson.scripts["migrate:local"]).toBe("node ./setup-local.mjs");
  });

  it("enables the same flag key the application reads", () => {
    // Not a string literal in the assertion: if the constant is renamed, this follows it.
    expect(LOCAL_FLAG_SQL).toContain(BOARD_CONTRACT_FLAG);
    expect(LOCAL_FLAG_SQL).toMatch(/enabled\s*=\s*1/);
  });

  it("uses a plain UPDATE, not the upsert shape the migration guard forbids", () => {
    expect(LOCAL_FLAG_SQL).toMatch(/^\s*UPDATE\s+feature_flags/i);
    expect(LOCAL_FLAG_SQL).not.toMatch(/on\s+conflict/i);
  });

  // `d1 execute --file` would have printed a row and exited 0 whatever the row said. These assert
  // the postcondition behaves, rather than matching the source text that implements it.
  it.each([
    ["the flag still disabled", { enabled: 0 }],
    ["the row missing entirely", undefined],
    ["a non-numeric value", { enabled: "yes" }],
  ])("refuses to report success on %s", (_label, row) => {
    expect(() => assertFlagEnabled(row)).toThrow(/not 1/);
  });

  it("accepts an enabled flag, however D1 spells the boolean", () => {
    expect(() => assertFlagEnabled({ enabled: 1 })).not.toThrow();
    expect(() => assertFlagEnabled({ enabled: true })).not.toThrow();
  });

  it("refuses to enable a flag on a database migration 0037 never reached", () => {
    expect(() => assertSchemaMarkerPresent({ present: 0 })).toThrow(/0037/);
    expect(() => assertSchemaMarkerPresent({ present: 1 })).not.toThrow();
  });

  it("exits non-zero when a postcondition fails", () => {
    expect(setupSource).toMatch(/process\.exit\(1\)/);
  });
});

describe("guard: the local setup runner cannot be pointed at production", () => {
  it.each(SUBCOMMANDS)("passes --local for `d1 %s`", (...subcommand) => {
    expect(wranglerArguments(subcommand, {})).toContain("--local");
  });

  it.each(SUBCOMMANDS)("pins the database name and config for `d1 %s`", (...subcommand) => {
    const args = wranglerArguments(subcommand, {});
    expect(args).toContain("quincy-portal");
    expect(args).toContain("../../workers/app/wrangler.jsonc");
  });

  it("keeps --local when isolated persistence is requested", () => {
    expect(wranglerArguments(["execute"], parseArguments(["--persist-to", "/tmp/scratch"]))).toContain("--local");
  });

  it.each(["--remote", "--env", "--config", "--database", "--preview"])("refuses %s", (flag) => {
    expect(() => parseArguments([flag, "production"])).toThrow(/local-only/);
    expect(() => parseArguments([`${flag}=production`])).toThrow(/local-only/);
  });

  it("refuses arguments it does not recognise rather than passing them through", () => {
    // Passthrough is how a `--remote` reaches wrangler without ever being named here.
    expect(() => parseArguments(["--json"])).toThrow(/Unknown argument/);
  });

  it("accepts only --persist-to", () => {
    expect(parseArguments(["--persist-to", "/tmp/scratch"])).toEqual({ persistTo: "/tmp/scratch" });
    expect(parseArguments([])).toEqual({ persistTo: undefined });
  });

  // A `--persist-to` value is never checked against FORBIDDEN_ARGUMENTS — it is consumed whole as
  // the *value* of the flag before it, so a caller can smuggle `--remote` (or any other flag) past
  // that check and into wrangler's argv, right after `--local`. These prove the smuggle is refused.
  it.each([
    ["--persist-to", "--remote"],
    ["--persist-to=--remote"],
    ["--persist-to", "--env=production"],
    ["--persist-to="],
  ])("refuses a --persist-to value that smuggles another flag: %j", (...argv) => {
    expect(() => parseArguments(argv)).toThrow(/local-only/);
  });

  it("normalises an accepted --persist-to value to an absolute path", () => {
    const options = parseArguments(["--persist-to", "scratch/state"]);
    expect(options.persistTo).toBe(resolve(process.cwd(), "scratch/state"));
    expect(options.persistTo.startsWith("/")).toBe(true);
  });

  // Property assertion: whatever a caller manages to get *accepted*, nothing beyond the fixed,
  // known flags this file itself pins should ever start with `-` in the resulting wrangler argv —
  // that is the shape a smuggled flag would need to reach wrangler.
  const KNOWN_FIXED_FLAGS = new Set(["--local", "--config", "--persist-to", "--json", "--command", "--file"]);
  const ACCEPTED_ARGV_TABLE = [
    [],
    ["--persist-to", "/tmp/scratch"],
    ["--persist-to", "scratch/state"],
    ["--persist-to=scratch/state"],
  ];
  it.each(ACCEPTED_ARGV_TABLE)("keeps every non-fixed argv element flag-shaped-free: %j", (...argv) => {
    const db = openMemoryDatabase();
    const fake = fakeWranglerSpawn(db);
    main(argv, { spawn: fake.spawn, log: () => {} });
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const args of fake.calls) {
      for (const element of args) {
        if (KNOWN_FIXED_FLAGS.has(element)) continue;
        expect(element.startsWith("-")).toBe(false);
      }
    }
    db.close();
  });
});

describe("guard: the local flag stays out of the all-environments seed", () => {
  it("does not enable the board contract flag in 0001_seed.sql", () => {
    // That seed is headed "all envs" and uses INSERT OR IGNORE — wrong reach, and it would not
    // update the row 0037 already created at 0 anyway.
    expect(sharedSeed).not.toContain(BOARD_CONTRACT_FLAG);
  });
});

describe("guard: db:migrate:local applies the shared seed", () => {
  function freshSetup() {
    const db = openMemoryDatabase();
    const lines: string[] = [];
    setupLocal(sqliteSetupExecutor(db), (line: string) => lines.push(line));
    return { db, lines };
  }

  it("setupLocal on an empty database leaves the five seeded stage keys and the bootstrap admin", () => {
    const { db } = freshSetup();
    const stages = db.prepare("SELECT key, active FROM pipeline_stages ORDER BY key;").all();
    expect(stages.map((row) => row.key)).toEqual(DEFAULT_STAGES.map((stage) => stage.key).sort());
    expect(stages.every((row) => Number(row.active) === 1)).toBe(true);
    const admin = db.prepare("SELECT role, active FROM user WHERE id = ?;").get(BOOTSTRAP_ADMIN_ID);
    expect(admin?.role).toBe("admin");
    expect(Number(admin?.active)).toBe(1);
    db.close();
  });

  it("re-running setupLocal keeps a renamed or deactivated stage and an edited admin", () => {
    const { db } = freshSetup();
    db.prepare("UPDATE pipeline_stages SET label = 'Renamed locally', active = 0 WHERE key = 'raw_review';").run();
    db.prepare("UPDATE user SET name = 'Edited Admin' WHERE id = ?;").run(BOOTSTRAP_ADMIN_ID);
    const lines: string[] = [];
    setupLocal(sqliteSetupExecutor(db), (line: string) => lines.push(line));
    const stage = db.prepare("SELECT label, active FROM pipeline_stages WHERE key = 'raw_review';").get();
    expect(stage?.label).toBe("Renamed locally");
    expect(Number(stage?.active)).toBe(0);
    expect(db.prepare("SELECT name FROM user WHERE id = ?;").get(BOOTSTRAP_ADMIN_ID)?.name).toBe("Edited Admin");
    expect(lines.some((line) => line.startsWith("  ! ") && /stages are inactive/.test(line))).toBe(true);
    db.close();
  });

  it("main() on a fresh database seeds it, through --local wrangler calls only", () => {
    const db = openMemoryDatabase();
    const fake = fakeWranglerSpawn(db);
    main(["--persist-to", "/tmp/scratch"], { spawn: fake.spawn, log: () => {} });

    const stages = db.prepare("SELECT key, active FROM pipeline_stages ORDER BY key;").all();
    expect(stages.map((row) => row.key)).toEqual(DEFAULT_STAGES.map((stage) => stage.key).sort());
    expect(stages.every((row) => Number(row.active) === 1)).toBe(true);
    const admin = db.prepare("SELECT role, active FROM user WHERE id = ?;").get(BOOTSTRAP_ADMIN_ID);
    expect(admin?.role).toBe("admin");
    expect(Number(admin?.active)).toBe(1);

    const isSeedCall = (args: string[]) => args.some((element, index) => element === "--file" && args[index + 1] === SEED_PATH);
    expect(fake.calls.filter(isSeedCall)).toHaveLength(1);
    const seedIndex = fake.calls.findIndex(isSeedCall);
    expect(fake.calls[0].slice(0, 4)).toEqual(["wrangler", "d1", "migrations", "apply"]);
    const laterNonQuery = fake.calls
      .map((args, index) => ({ args, index }))
      .filter(({ args, index }) => index !== 0 && index !== seedIndex && !args.includes("--json"));
    expect(laterNonQuery.length).toBeGreaterThan(0);
    for (const { index } of laterNonQuery) expect(index).toBeGreaterThan(seedIndex);

    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    for (const spawned of fake.processes) expect(spawned).toEqual({ command: "npx", cwd: packageDirectory });

    for (const args of fake.calls) {
      expect(args).toContain("--local");
      expect(args).toContain("quincy-portal");
      expect(args).toContain("../../workers/app/wrangler.jsonc");
      const persist = args.indexOf("--persist-to");
      expect(persist).toBeGreaterThan(-1);
      expect(args[persist + 1]).toBe("/tmp/scratch");
    }
    db.close();
  });

  it("setupLocal fails loudly when another user row already holds the bootstrap admin's email", () => {
    const seeded = openMemoryDatabase();
    setupLocal(sqliteSetupExecutor(seeded), () => {});
    const adminEmail = seeded.prepare("SELECT email FROM user WHERE id = ?;").get(BOOTSTRAP_ADMIN_ID)?.email;
    seeded.close();
    expect(adminEmail).toMatch(/@/);
    const db = openMemoryDatabase();
    const real = sqliteSetupExecutor(db);
    const executor = {
      ...real,
      migrate: () => {
        real.migrate();
        db.prepare(
          "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Someone Else', ?, 0, 'admin', 1, 0, 0);",
        ).run(adminEmail);
      },
    };
    expect(() => setupLocal(executor, () => {})).toThrow(/email/);
    // The sequence stopped at the seed: the Board flag step never ran.
    expect(Number(db.prepare("SELECT enabled FROM feature_flags WHERE key = ?;").get(BOARD_CONTRACT_FLAG)?.enabled)).toBe(0);
    db.close();
  });

  it("assertSeedApplied fails on missing rows and seedWarnings reports inactive ones", () => {
    expect(() => assertSeedApplied({ stages: 4, active_stages: 4, admin_active: 1 })).toThrow(/4 of 5/);
    expect(() => assertSeedApplied({ stages: 5, active_stages: 5, admin_active: null })).toThrow(/email/);
    expect(() => assertSeedApplied(undefined)).toThrow();

    const inactiveStage = { stages: 5, active_stages: 4, admin_active: 1 };
    expect(() => assertSeedApplied(inactiveStage)).not.toThrow();
    expect(seedWarnings(inactiveStage)).toHaveLength(1);

    const inactiveAdmin = { stages: 5, active_stages: 5, admin_active: 0 };
    expect(() => assertSeedApplied(inactiveAdmin)).not.toThrow();
    expect(seedWarnings(inactiveAdmin)).toHaveLength(1);

    const allGood = { stages: 5, active_stages: 5, admin_active: 1 };
    expect(() => assertSeedApplied(allGood)).not.toThrow();
    expect(seedWarnings(allGood)).toEqual([]);
  });

  it("the seed constants match the shared stages, the fixture dataset and the seed file", () => {
    expect(SEED_STAGE_KEYS).toEqual(DEFAULT_STAGES.map((stage) => stage.key));
    expect(BOOTSTRAP_ADMIN_ID).toBe(DATASET_BOOTSTRAP_ADMIN_ID);
    expect(sharedSeed).toContain(BOOTSTRAP_ADMIN_ID);
    for (const key of SEED_STAGE_KEYS) expect(sharedSeed).toContain(`'${key}'`);
    expect(readFileSync(SEED_PATH, "utf8")).toBe(sharedSeed);
  });

  it("the seed is re-runnable: every INSERT in it is INSERT OR IGNORE", () => {
    const inserts = sharedSeed.match(/\bINSERT\b/gi) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(sharedSeed).not.toMatch(/\bINSERT\b(?!\s+OR\s+IGNORE\b)/i);
    expect(sharedSeed).not.toMatch(/\b(UPDATE|DELETE)\b/i);
  });
});
