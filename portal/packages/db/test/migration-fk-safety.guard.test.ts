/**
 * Migration FK-safety guard — no migration may reintroduce the D1-fatal table-rebuild.
 *
 * `PRAGMA foreign_keys=OFF` does not reliably persist across statements in D1's remote
 * migration execution, even though it works fine against local Miniflare/node:sqlite — a
 * real production migration attempt (0020) failed on `DROP TABLE projects` with
 * `FOREIGN KEY constraint failed`, and on local D1 the same shape reports SUCCESS while
 * silently cascade-deleting every child row instead (docs/lessons.md:27-62). `drizzle-kit
 * generate`'s default table-rebuild form for a schema change requiring a `CHECK` — open
 * with `PRAGMA foreign_keys=OFF`, `CREATE TABLE __new_<table>`, copy rows, `DROP TABLE
 * <table>`, `ALTER TABLE __new_<table> RENAME TO <table>`, `PRAGMA foreign_keys=ON` — is
 * exactly that pattern, and `legacy_alter_table` is the equivalent SQLite pragma some
 * hand-written rebuilds use instead. Neither is honoured by D1.
 *
 * This guard reads every migration file as text and asserts both patterns are absent, with
 * no baseline and no exception list. Currently zero occurrences across 0001-0039, and zero
 * once 0040 was replaced with the FK-safe column swap (`ALTER TABLE ... ADD COLUMN ...
 * CHECK(...)` / `DROP COLUMN` / `RENAME COLUMN`) documented in
 * docs/adr/0001-project-priority-1-to-5.md. **Never add a baseline or exception entry to
 * make this pass.** If it fires, the migration is wrong, not the guard — replace the
 * table-rebuild with the column-swap pattern instead.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

function readMigration(name: string): string {
  return readFileSync(join(migrationsDir, name), "utf8");
}

const FIX_HINT =
  "Use an `ALTER TABLE ... ADD COLUMN ... CHECK(...)` / `DROP COLUMN` / `RENAME COLUMN` " +
  "swap instead of a table rebuild — see docs/lessons.md:27-62.";

describe("guard: no migration disables foreign-key enforcement", () => {
  it("contains no `PRAGMA ... foreign_keys` or `legacy_alter_table` statement, case-insensitively", () => {
    const offenders = migrationFiles()
      .filter((name) => /pragma\s+[^;]*foreign_keys/i.test(readMigration(name)) || /legacy_alter_table/i.test(readMigration(name)))
      .map((name) => name);

    expect(
      offenders,
      [
        "The following migrations toggle foreign-key enforcement, which D1 does not honour",
        "in remote migration execution:",
        ...offenders.map((name) => `  - ${name}`),
        FIX_HINT,
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("guard: no migration uses the drizzle table-rebuild pattern", () => {
  it("contains no `CREATE TABLE __new_<x>` and no `ALTER TABLE __new_<x> RENAME TO` statement", () => {
    const offenders = migrationFiles()
      .filter((name) => /create\s+table\s+`?__new_\w+`?/i.test(readMigration(name)) || /alter\s+table\s+`?__new_\w+`?\s+rename\s+to/i.test(readMigration(name)))
      .map((name) => name);

    expect(
      offenders,
      [
        "The following migrations use the drizzle-generated table-rebuild pattern",
        "(CREATE TABLE __new_<x> / ALTER TABLE __new_<x> RENAME TO), which D1 does not",
        "safely support against tables with real foreign-key-referencing rows:",
        ...offenders.map((name) => `  - ${name}`),
        FIX_HINT,
      ].join("\n"),
    ).toEqual([]);
  });
});
