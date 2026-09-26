/**
 * QA scheduling fixture — `verify` exactness (Sol round 2, findings 4-6). Driven through `cli.mjs`'s
 * own exported `apply`/`verify` against a `node:sqlite` database built from the real migrations
 * (`qa-seed-sqlite-executor.ts`), so every case below is the production comparison code, not a copy.
 *
 *  - Finding 4: values are compared exactly. NULL is not `''`, and a number is not its string form.
 *  - Finding 5: `board_position` is compared against the value apply actually wrote (recorded at
 *    apply time), not excluded because apply computes it live.
 *  - Finding 6: memberships are checked against the default-editor set apply RECORDED, never today's.
 *    A default editor disabled after apply must not make `verify` skip the membership check, nor
 *    make a still-present membership look unexpected.
 */
import { describe, expect, it } from "vitest";
import { apply, fingerprintValuesEqual, verify } from "../qa-seed/cli.mjs";
import { FIXTURE_BOARD_POSITIONS_TABLE, FIXTURE_RUN_RECORDS_TABLE, FIXTURE_RUNS_TABLE } from "../qa-seed/sql";
import { freshFixtureDatabase, sqliteExecutor, type SqliteDatabase } from "./qa-seed-sqlite-executor";

const ANCHOR = "2026-09-21";
const EDITOR_A = "0f3c9a4e-7b1d-4c2e-9a5f-1d2e3f4a5b6c";
const EDITOR_B = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const VERIFY_OPTIONS = { command: "verify", tier: undefined, anchor: undefined, persistTo: undefined };

function addDefaultEditor(db: SqliteDatabase, id: string, email: string): void {
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, default_editor, created_at, updated_at) VALUES (?, ?, ?, 0, 'editor', 1, 1, 0, 0)").run(id, `Editor ${email}`, email);
}

function appliedDatabase(editors: string[]): { db: SqliteDatabase; executor: ReturnType<typeof sqliteExecutor> } {
  const db = freshFixtureDatabase();
  editors.forEach((id, index) => addDefaultEditor(db, id, `editor-${index}@example.test`));
  const executor = sqliteExecutor(db);
  apply(executor, { command: "apply", tier: undefined, anchor: ANCHOR, persistTo: undefined });
  expect(() => verify(executor, VERIFY_OPTIONS)).not.toThrow();
  return { db, executor };
}

function firstFixtureProjectId(db: SqliteDatabase): string {
  const row = db.prepare("SELECT id FROM projects WHERE notes LIKE 'QA-FIXTURE-v1%' ORDER BY id LIMIT 1;").get();
  return String(row?.id);
}

function verifyError(executor: ReturnType<typeof sqliteExecutor>): string {
  try {
    verify(executor, VERIFY_OPTIONS);
  } catch (error) {
    return (error as Error).message;
  }
  return "verify did not throw";
}

describe("finding 4: verify compares values exactly", () => {
  it("fingerprintValuesEqual distinguishes NULL from '', a number from its string form, and a missing column from NULL", () => {
    expect(fingerprintValuesEqual(null, "")).toBe(false);
    expect(fingerprintValuesEqual("", null)).toBe(false);
    expect(fingerprintValuesEqual(1, "1")).toBe(false);
    expect(fingerprintValuesEqual("1", 1)).toBe(false);
    expect(fingerprintValuesEqual(0, null)).toBe(false);
    expect(fingerprintValuesEqual(null, undefined)).toBe(false);
    expect(fingerprintValuesEqual(null, null)).toBe(true);
    expect(fingerprintValuesEqual(1024, 1024)).toBe(true);
    expect(fingerprintValuesEqual("x", "x")).toBe(true);
  });

  it("a fixture project whose NULL postcode became '' fails verify, naming projects and postcode", () => {
    const { db, executor } = appliedDatabase([]);
    db.prepare("UPDATE projects SET postcode = '' WHERE id = ?;").run(firstFixtureProjectId(db));
    expect(verifyError(executor)).toMatch(/projects: 1 row\(s\) differ[^\n]*\(postcode\)/);
    db.close();
  });
});

describe("finding 5: verify compares board_position against the value apply recorded", () => {
  it("a moved fixture project fails verify, naming projects and board_position", () => {
    const { db, executor } = appliedDatabase([]);
    db.prepare("UPDATE projects SET board_position = board_position + 1 WHERE id = ?;").run(firstFixtureProjectId(db));
    expect(verifyError(executor)).toMatch(/projects: 1 row\(s\) differ[^\n]*\(board_position\)/);
    db.close();
  });
});

describe("finding 6: memberships are verified against the default-editor set apply recorded", () => {
  it("disabling one of two default editors after apply leaves verify clean — their memberships are still exactly present", () => {
    const { db, executor } = appliedDatabase([EDITOR_A, EDITOR_B]);
    db.prepare("UPDATE user SET active = 0 WHERE id = ?;").run(EDITOR_B);
    expect(() => verify(executor, VERIFY_OPTIONS)).not.toThrow();
    db.close();
  });

  it("a disabled sole default editor does not make verify skip memberships: a removed membership still fails, naming project_members", () => {
    const { db, executor } = appliedDatabase([EDITOR_A]);
    db.prepare("UPDATE user SET active = 0 WHERE id = ?;").run(EDITOR_A);
    const removed = db.prepare("SELECT id FROM project_members WHERE user_id = ? ORDER BY id LIMIT 1;").get(EDITOR_A);
    db.prepare("DELETE FROM project_members WHERE id = ?;").run(String(removed?.id));
    expect(verifyError(executor)).toMatch(/project_members: 1 expected id\(s\) missing/);
    db.close();
  });

  it("a membership the app added to a fixture project after apply fails verify, naming project_members", () => {
    const { db, executor } = appliedDatabase([EDITOR_A]);
    addDefaultEditor(db, EDITOR_B, "late-editor@example.test");
    db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e', ?, ?, 'editor', 0);").run(firstFixtureProjectId(db), EDITOR_B);
    expect(verifyError(executor)).toMatch(/project_members: 1 unexpected/);
    db.close();
  });

  it("a run with no recorded default-editor set fails loudly instead of falling back to today's editors", () => {
    const { db, executor } = appliedDatabase([EDITOR_A]);
    const runId = String(db.prepare(`SELECT id FROM ${FIXTURE_RUNS_TABLE};`).get()?.id);
    // Simulates a run applied before apply started recording what it used.
    for (const table of [FIXTURE_RUN_RECORDS_TABLE, FIXTURE_BOARD_POSITIONS_TABLE]) {
      db.prepare(`DELETE FROM ${table} WHERE run_id = ?;`).run(runId);
    }
    expect(verifyError(executor)).toMatch(/re-apply/i);
    db.close();
  });
});
