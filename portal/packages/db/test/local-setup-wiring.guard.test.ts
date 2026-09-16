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
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOARD_CONTRACT_FLAG } from "../src/board-schema-variant";
import { assertFlagEnabled, assertSchemaMarkerPresent, LOCAL_FLAG_SQL, parseArguments, wranglerArguments } from "../setup-local.mjs";

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
});

describe("guard: the local flag stays out of the all-environments seed", () => {
  it("does not enable the board contract flag in 0001_seed.sql", () => {
    // That seed is headed "all envs" and uses INSERT OR IGNORE — wrong reach, and it would not
    // update the row 0037 already created at 0 anyway.
    expect(sharedSeed).not.toContain(BOARD_CONTRACT_FLAG);
  });
});
