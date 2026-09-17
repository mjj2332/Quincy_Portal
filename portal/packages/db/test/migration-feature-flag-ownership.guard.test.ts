/**
 * Feature-flag ownership guard — a migration may seed a flag, never re-assert it.
 *
 * A feature-flag row is operator-owned the moment it exists. `0037_project_board_order_contract`
 * shipped `tb5a_board_contract_enabled` disabled for a staged rollout and closed with
 * `ON CONFLICT(key) DO UPDATE SET enabled = 0, updated_by = NULL, ...`, so re-running that
 * statement against a database where an operator had since enabled the Board switched it back
 * off for every user *and* erased the record of who had turned it on — no schema change, no
 * error, nothing to explain the outage (#160). Seeding a default is right; restamping a live
 * value is not.
 *
 * The guard is per-statement rather than per-file: migrations routinely touch `feature_flags`
 * and use `ON CONFLICT` on unrelated tables in the same file, and only a single statement doing
 * both is an offence. It matches on effect rather than syntax — a restamping upsert, a bare
 * `UPDATE` and a `REPLACE INTO` all revoke a live flag, so all three are caught.
 *
 * **Out of scope, deliberately:** `workers/background/src/external-role-cache-purge.ts` also
 * re-asserts on conflict (`DO UPDATE SET enabled = 1`) and is *correct as written* — it is a
 * latch asserting a freeze after the bounded zone purge exhausts, not a default being restamped.
 * Converting it to `DO NOTHING` would break the freeze. This guard reads migrations only, so
 * that file is excluded structurally rather than by an allowlist. (Its release is the audited admin
 * PATCH /api/users/external-provisioning-freeze, #161.)
 *
 * There is no baseline and no exception list, and there must never be one: at the time of
 * writing every migration passes. **If this fires, the migration is wrong, not the guard.**
 * Seed with `ON CONFLICT(key) DO NOTHING`, or touch `updated_at` alone and leave `enabled` and
 * `updated_by` to whoever set them.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
const BREAKPOINT = "--> statement-breakpoint";

/** Columns that record an operator's decision and who made it. */
const OWNED_COLUMNS = ["enabled", "updated_by"] as const;

const FIX_HINT =
  "Seed the row with `ON CONFLICT(key) DO NOTHING` and let the operator own it from there. If a " +
  "touched timestamp is wanted, update `updated_at` alone — never `enabled` or `updated_by`. " +
  "See docs/lessons.md (#160).";

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

/**
 * Comments are stripped first, so a commented-out offender does not read as a live one. The
 * breakpoint marker is itself a `--` comment, so the split happens before the strip.
 */
function statements(name: string): string[] {
  return readFileSync(join(migrationsDir, name), "utf8")
    .split(BREAKPOINT)
    .map((segment) => withoutComments(segment).trim())
    .filter(Boolean);
}

function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * True when one statement both targets `feature_flags` and overwrites an operator-owned column.
 *
 * Three shapes, because the rule is about the effect and not the syntax: an upsert that restamps
 * on conflict, a bare `UPDATE` that revokes outright, and `REPLACE INTO`, which is a
 * delete-and-reinsert and so discards `updated_by` just as surely. The assignment is matched
 * wherever it sits in the SET list, so reordering the columns does not slip past.
 */
function reassertsOwnedColumn(statement: string): boolean {
  if (!/feature_flags/i.test(statement)) return false;
  if (/\breplace\s+into\b/i.test(statement)) return true;

  const onConflictSet = /\bon\s+conflict\b[\s\S]*?\bdo\s+update\s+set\b([\s\S]*)$/i.exec(statement)?.[1];
  const bareUpdateSet = /\bupdate\s+`?feature_flags`?\s+set\b([\s\S]*)$/i.exec(statement)?.[1];
  return [onConflictSet, bareUpdateSet].some((setClause) => setClause !== undefined && assignsOwnedColumn(setClause));
}

function assignsOwnedColumn(setClause: string): boolean {
  return OWNED_COLUMNS.some((column) => new RegExp(`(^|[\\s,(])\`?${column}\`?\\s*=`, "i").test(setClause));
}

describe("guard: no migration re-asserts an operator-owned feature flag", () => {
  it("has no `feature_flags` statement overwriting `enabled` or `updated_by`", () => {
    const offenders = migrationFiles().filter((name) => statements(name).some(reassertsOwnedColumn));

    expect(
      offenders,
      [
        "The following migrations overwrite an operator-owned feature-flag column.",
        "A replay would revoke a deliberate flip and erase who made it:",
        ...offenders.map((name) => `  - ${name}`),
        FIX_HINT,
      ].join("\n"),
    ).toEqual([]);
  });

  // Negative controls. A scanner that cannot detect the thing it scans for is worse than none:
  // it reports clean forever and reads as protection. These pin the detector itself.
  it.each([
    ["the exact clause 0037 shipped", "INSERT INTO feature_flags (key) VALUES ('x')\nON CONFLICT(key) DO UPDATE SET\n  enabled = 0,\n  updated_by = NULL,\n  updated_at = excluded.updated_at;"],
    ["a lowercase clause", "insert into feature_flags (key) values ('x') on conflict(key) do update set enabled = 0;"],
    ["`enabled` last in the SET list", "INSERT INTO feature_flags (key) VALUES ('x') ON CONFLICT(key) DO UPDATE SET updated_at = 1, enabled = 0;"],
    ["only `updated_by` erased", "INSERT INTO feature_flags (key) VALUES ('x') ON CONFLICT(key) DO UPDATE SET updated_by = NULL;"],
    ["backquoted identifiers", "INSERT INTO `feature_flags` (`key`) VALUES ('x') ON CONFLICT(`key`) DO UPDATE SET `enabled` = 0;"],
    ["a REPLACE INTO", "REPLACE INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('x', 0, NULL, 0);"],
    ["a bare UPDATE revoking the flag", "UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled';"],
    ["a bare UPDATE erasing the audit trail", "UPDATE `feature_flags` SET `updated_by` = NULL;"],
  ])("detects %s", (_label, statement) => {
    expect(reassertsOwnedColumn(statement)).toBe(true);
  });

  it.each([
    ["a plain seeding insert, as 0032 uses", "INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('user_impersonation', 0, NULL, unixepoch('now') * 1000);"],
    ["the yielding clause 0037 now uses", "INSERT INTO feature_flags (key, enabled) VALUES ('x', 0)\nON CONFLICT(key) DO NOTHING;"],
    ["touching only the timestamp", "INSERT INTO feature_flags (key, enabled) VALUES ('x', 0) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at;"],
    ["an upsert on an unrelated table", "INSERT INTO projects (id, enabled) VALUES ('p', 1) ON CONFLICT(id) DO UPDATE SET enabled = 1;"],
    ["a column merely ending in `enabled`", "INSERT INTO feature_flags (key) VALUES ('x') ON CONFLICT(key) DO UPDATE SET auto_enabled = 1;"],
    ["a bare UPDATE touching only the timestamp", "UPDATE feature_flags SET updated_at = 0 WHERE key = 'x';"],
    ["an UPDATE on an unrelated table", "UPDATE projects SET enabled = 0;"],
  ])("does not fire on %s", (_label, statement) => {
    expect(reassertsOwnedColumn(statement)).toBe(false);
  });
});
