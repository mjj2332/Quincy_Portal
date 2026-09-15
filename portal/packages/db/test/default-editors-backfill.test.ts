import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_ASSIGNMENT_ELIGIBLE_ROLES } from "@quincy/shared";
import { BACKFILL_EDITOR_ROLES, buildBackfillSql, extractManifestRows } from "../../../scripts/default-editors-backfill.mjs";

type Statement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => Statement };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyMigrations(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

const DRYRUN_SQL = readFileSync(new URL("../../../scripts/default-editors-backfill-dryrun.sql", import.meta.url), "utf8");

const NOW = 1_700_000_000_000;

// Fixed, readable UUID-v4-shaped ids so seed data passes buildBackfillSql's own UUID validation.
const USER = {
  flaggedEditor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  flaggedAdmin: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  unflaggedEditor: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  flaggedInactive: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  flaggedPhotographer: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};
const PROJECT = {
  alpha: "11111111-1111-4111-8111-111111111111", // active; flaggedAdmin already a member here
  bravo: "22222222-2222-4222-8222-222222222222", // active; flaggedEditor was manually removed here
  charlie: "33333333-3333-4333-8333-333333333333", // active; clean
  delta: "44444444-4444-4444-8444-444444444444", // archived
};

function seedUsersAndProjects(db: SqliteDatabase): void {
  const insertUser = db.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, active, default_editor, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
  );
  insertUser.run(USER.flaggedEditor, "Flagged Editor", "flagged-editor@example.test", "editor", 1, 1, NOW, NOW);
  insertUser.run(USER.flaggedAdmin, "Flagged Admin", "flagged-admin@example.test", "admin", 1, 1, NOW, NOW);
  insertUser.run(USER.unflaggedEditor, "Unflagged Editor", "unflagged-editor@example.test", "editor", 1, 0, NOW, NOW);
  insertUser.run(USER.flaggedInactive, "Flagged Inactive", "flagged-inactive@example.test", "editor", 0, 1, NOW, NOW);
  insertUser.run(USER.flaggedPhotographer, "Flagged Photographer", "flagged-photographer@example.test", "photographer", 1, 1, NOW, NOW);

  const insertProject = db.prepare(
    "INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?)",
  );
  insertProject.run(PROJECT.alpha, "Alpha Street", null, NOW, NOW);
  insertProject.run(PROJECT.bravo, "Bravo Street", null, NOW, NOW);
  insertProject.run(PROJECT.charlie, "Charlie Street", null, NOW, NOW);
  insertProject.run(PROJECT.delta, "Delta Street", NOW, NOW, NOW); // archived

  // flaggedAdmin is already a member of Alpha — the dry-run must exclude that pair, and the
  // apply.sql must leave this exact row untouched.
  db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
    .run("existing-membership-alpha-admin", PROJECT.alpha, USER.flaggedAdmin, NOW);

  // flaggedEditor was manually removed from Bravo as an editor — the dry-run must exclude that
  // pair permanently.
  db.prepare(
    "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'project.member.remove', 'project', ?, ?, ?)",
  ).run(
    "removal-audit-bravo-editor",
    PROJECT.bravo,
    JSON.stringify({ projectId: PROJECT.bravo, userId: USER.flaggedEditor, roleOnProject: "editor" }),
    NOW,
  );
}

function runDryrun(db: SqliteDatabase): Array<{ project_id: string; street: string; user_id: string; user_email: string }> {
  const rows = db.prepare(DRYRUN_SQL).all() as Array<{ project_id: string; street: string; user_id: string; user_email: string }>;
  // The guide sends the file through `--command "$(grep -v '^--' …)"`; that form must mean the same query.
  const stripped = DRYRUN_SQL.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  expect(db.prepare(stripped).all()).toEqual(rows);
  return rows;
}

function counts(db: SqliteDatabase) {
  return {
    members: (db.prepare("SELECT COUNT(*) AS n FROM project_members").get() as { n: number }).n,
    audits: (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.default_editors.backfilled'").get() as { n: number }).n,
    outbox: (db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get() as { n: number }).n,
    ledger: (db.prepare("SELECT COUNT(*) AS n FROM notification_delivery_ledger").get() as { n: number }).n,
    activity: (db.prepare("SELECT COUNT(*) AS n FROM project_activity_events").get() as { n: number }).n,
  };
}

describe("default editors backfill (#135)", () => {
  it("dry-run finds exactly the eligible, not-yet-member, not-removed, not-already-backfilled pairs", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 44);
    seedUsersAndProjects(db);

    const rows = runDryrun(db);

    expect(rows).toEqual([
      { project_id: PROJECT.alpha, street: "Alpha Street", user_id: USER.flaggedEditor, user_email: "flagged-editor@example.test" },
      { project_id: PROJECT.bravo, street: "Bravo Street", user_id: USER.flaggedAdmin, user_email: "flagged-admin@example.test" },
      { project_id: PROJECT.charlie, street: "Charlie Street", user_id: USER.flaggedAdmin, user_email: "flagged-admin@example.test" },
      { project_id: PROJECT.charlie, street: "Charlie Street", user_id: USER.flaggedEditor, user_email: "flagged-editor@example.test" },
    ]);

    db.close();
  });

  it("applies exactly the expected pairs, leaves existing membership and the removed pair alone, writes one audit per touched project, and touches no other table", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 44);
    seedUsersAndProjects(db);

    const projectsBefore = db.prepare("SELECT id, updated_at FROM projects ORDER BY id").all();
    const rows = runDryrun(db);
    // Generated long before it is applied (owner review): rows must carry the time the file ran, not the time it was generated.
    const generatedAt = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const applySql = buildBackfillSql(rows);
    generatedAt.mockRestore();
    const appliedAfter = Date.now();

    db.exec(applySql);
    const appliedBefore = Date.now();

    const stamped = db.prepare("SELECT created_at FROM project_members WHERE id <> 'existing-membership-alpha-admin' UNION ALL SELECT created_at FROM audit_log WHERE action = 'project.default_editors.backfilled'").all() as Array<{ created_at: number }>;
    expect(stamped).toHaveLength(7);
    for (const row of stamped) {
      expect(Number.isInteger(row.created_at)).toBe(true);
      expect(row.created_at).toBeGreaterThanOrEqual(appliedAfter - 1000);
      expect(row.created_at).toBeLessThanOrEqual(appliedBefore + 1000);
    }

    const members = db.prepare("SELECT id, project_id, user_id FROM project_members ORDER BY project_id, user_id").all() as Array<{ id: string; project_id: string; user_id: string }>;
    expect(members.map(({ project_id, user_id }) => ({ project_id, user_id }))).toEqual([
      { project_id: PROJECT.alpha, user_id: USER.flaggedEditor }, // newly backfilled
      { project_id: PROJECT.alpha, user_id: USER.flaggedAdmin }, // pre-existing, untouched
      { project_id: PROJECT.bravo, user_id: USER.flaggedAdmin }, // newly backfilled
      // Bravo/flaggedEditor stays removed; Delta (archived) and the ineligible users never appear.
      { project_id: PROJECT.charlie, user_id: USER.flaggedEditor },
      { project_id: PROJECT.charlie, user_id: USER.flaggedAdmin },
    ].sort((a, b) => (a.project_id === b.project_id ? a.user_id.localeCompare(b.user_id) : a.project_id.localeCompare(b.project_id))));

    // The pre-existing Alpha/admin row was not replaced — its id is unchanged.
    expect(members.find((row) => row.project_id === PROJECT.alpha && row.user_id === USER.flaggedAdmin)?.id).toBe("existing-membership-alpha-admin");

    // Every freshly inserted row has a fresh UUID v4 id.
    const freshIds = members.filter((row) => row.id !== "existing-membership-alpha-admin").map((row) => row.id);
    expect(freshIds).toHaveLength(4);
    expect(new Set(freshIds).size).toBe(4);
    for (const id of freshIds) expect(id).toMatch(UUID_V4_RE);

    const audits = db.prepare("SELECT actor_id, target_id, meta_json FROM audit_log WHERE action = 'project.default_editors.backfilled' ORDER BY target_id").all() as Array<{ actor_id: string | null; target_id: string; meta_json: string }>;
    expect(audits.map((row) => row.target_id)).toEqual([PROJECT.alpha, PROJECT.bravo, PROJECT.charlie]);
    for (const audit of audits) {
      expect(audit.actor_id).toBeNull();
      const meta = JSON.parse(audit.meta_json) as { actor: string; source: string; userIds: string[] };
      expect(meta.actor).toBe("operator_backfill");
      expect(meta.source).toBe("default_editor_backfill");
      expect(meta.userIds).toEqual([...meta.userIds].sort());
    }
    expect(JSON.parse(audits.find((row) => row.target_id === PROJECT.alpha)!.meta_json).userIds).toEqual([USER.flaggedEditor]);
    expect(JSON.parse(audits.find((row) => row.target_id === PROJECT.bravo)!.meta_json).userIds).toEqual([USER.flaggedAdmin]);
    expect(JSON.parse(audits.find((row) => row.target_id === PROJECT.charlie)!.meta_json).userIds).toEqual([USER.flaggedEditor, USER.flaggedAdmin].sort());

    const zero = counts(db);
    expect(zero.outbox).toBe(0);
    expect(zero.ledger).toBe(0);
    expect(zero.activity).toBe(0);

    expect(db.prepare("SELECT id, updated_at FROM projects ORDER BY id").all()).toEqual(projectsBefore);

    // Running the same apply.sql again is a no-op.
    const before = counts(db);
    const membersBefore = members;
    db.exec(applySql);
    expect(counts(db)).toEqual(before);
    expect(db.prepare("SELECT id, project_id, user_id FROM project_members ORDER BY project_id, user_id").all()).toEqual(membersBefore);

    // The dry-run now returns nothing: every eligible pair is either a member or backfill-audited.
    expect(runDryrun(db)).toEqual([]);

    db.close();
  });

  it("survives an interruption: executing only the first project's statements then the full file matches a single full run", () => {
    const rows = [
      { project_id: PROJECT.alpha, street: "Alpha Street", user_id: USER.flaggedEditor, user_email: "flagged-editor@example.test" },
      { project_id: PROJECT.bravo, street: "Bravo Street", user_id: USER.flaggedAdmin, user_email: "flagged-admin@example.test" },
      { project_id: PROJECT.charlie, street: "Charlie Street", user_id: USER.flaggedAdmin, user_email: "flagged-admin@example.test" },
      { project_id: PROJECT.charlie, street: "Charlie Street", user_id: USER.flaggedEditor, user_email: "flagged-editor@example.test" },
    ];

    // Deterministic id generators, both starting at 0: since Alpha is processed first by both
    // calls, the ids generated for Alpha's statements are identical between the "first project
    // only" text and the "full" text — so the first project's statements truly are a prefix of
    // the full apply.sql, letting the second exec of the full file be exercised as a genuine
    // resume rather than a coincidentally-compatible re-generation.
    const makeSeq = () => { let n = 0; return () => { n += 1; return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`; }; };

    const fullSql = buildBackfillSql(rows, { newId: makeSeq() });
    const firstProjectOnlySql = buildBackfillSql(rows.filter((row) => row.project_id === PROJECT.alpha), { newId: makeSeq() });

    const interrupted = localSqlite();
    interrupted.exec("PRAGMA foreign_keys = ON");
    applyMigrations(interrupted, 44);
    seedUsersAndProjects(interrupted);
    interrupted.exec(firstProjectOnlySql);
    interrupted.exec(fullSql); // resume: re-running the SAME full file after the interruption

    const full = localSqlite();
    full.exec("PRAGMA foreign_keys = ON");
    applyMigrations(full, 44);
    seedUsersAndProjects(full);
    full.exec(fullSql);

    const membersOf = (db: SqliteDatabase) => db.prepare("SELECT project_id, user_id FROM project_members ORDER BY project_id, user_id").all();
    const auditsOf = (db: SqliteDatabase) => db.prepare("SELECT target_id, meta_json FROM audit_log WHERE action = 'project.default_editors.backfilled' ORDER BY target_id").all();

    expect(membersOf(interrupted)).toEqual(membersOf(full));
    expect(auditsOf(interrupted)).toEqual(auditsOf(full));
    expect((interrupted.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.default_editors.backfilled'").get() as { n: number }).n).toBe(3);

    interrupted.close();
    full.close();
  });

  it("does not re-add a pair that was manually removed after the backfill applied", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 44);
    seedUsersAndProjects(db);

    const rows = runDryrun(db);
    const applySql = buildBackfillSql(rows);
    db.exec(applySql);

    // Simulate a manual post-apply removal of Charlie/flaggedAdmin as an editor: the app would
    // both delete the project_members row and write a removal audit.
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").run(PROJECT.charlie, USER.flaggedAdmin);
    db.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'project.member.remove', 'project', ?, ?, ?)",
    ).run(
      "removal-audit-charlie-admin",
      PROJECT.charlie,
      JSON.stringify({ projectId: PROJECT.charlie, userId: USER.flaggedAdmin, roleOnProject: "editor" }),
      NOW,
    );

    db.exec(applySql); // re-running the SAME apply.sql

    const stillMember = db.prepare("SELECT 1 AS found FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").get(PROJECT.charlie, USER.flaggedAdmin);
    expect(stillMember).toBeUndefined();

    // Charlie/flaggedEditor is untouched by the removal and stays a member.
    const editorStillMember = db.prepare("SELECT 1 AS found FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").get(PROJECT.charlie, USER.flaggedEditor);
    expect(editorStillMember).toBeTruthy();

    // Still exactly one backfill audit for Charlie — the re-run did not add a second one.
    const charlieAudits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.default_editors.backfilled' AND target_id = ?").get(PROJECT.charlie) as { n: number };
    expect(charlieAudits.n).toBe(1);

    db.close();
  });
});

describe("default editors backfill manifest and later runs", () => {
  it("keeps the generated role list in step with PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor and the dry run", () => {
    expect([...BACKFILL_EDITOR_ROLES].sort()).toEqual([...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor].sort());
    expect(DRYRUN_SQL).toContain(`u.role IN (${BACKFILL_EDITOR_ROLES.map((role: string) => `'${role}'`).join(", ")})`);
  });

  it("reads `wrangler d1 execute --command --json` output and refuses a `--file` import summary", () => {
    const row = { project_id: PROJECT.alpha, street: "Alpha Street", user_id: USER.flaggedEditor, user_email: "flagged-editor@example.test" };
    expect(extractManifestRows([{ results: [row], success: true, meta: {} }])).toEqual([row]);
    expect(extractManifestRows([row])).toEqual([row]);
    // Shape of a remote `--file` run: the import endpoint reports counts, not SELECT rows.
    expect(() => extractManifestRows([{ results: [{ "Total queries executed": 1, "Rows read": 12, "Rows written": 0 }], success: true }]))
      .toThrow(/--command/);
  });

  it("audits a later run for a newly flagged user even though an earlier run already audited that project", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 44);
    seedUsersAndProjects(db);
    db.exec(buildBackfillSql(runDryrun(db)));

    db.prepare("UPDATE user SET default_editor = 1 WHERE id = ?").run(USER.unflaggedEditor);
    const laterRows = runDryrun(db);
    expect(laterRows.map((row) => row.user_id)).toEqual([USER.unflaggedEditor, USER.unflaggedEditor, USER.unflaggedEditor]);
    const laterSql = buildBackfillSql(laterRows);
    db.exec(laterSql);
    db.exec(laterSql);

    const audits = db.prepare("SELECT target_id, meta_json FROM audit_log WHERE action = 'project.default_editors.backfilled' ORDER BY target_id, created_at").all() as Array<{ target_id: string; meta_json: string }>;
    expect(audits).toHaveLength(6);
    for (const projectId of [PROJECT.alpha, PROJECT.bravo, PROJECT.charlie]) {
      const later = audits.filter((row) => row.target_id === projectId).map((row) => JSON.parse(row.meta_json) as { userIds: string[]; runId: string });
      expect(later).toHaveLength(2);
      expect(later.some((meta) => meta.userIds.length === 1 && meta.userIds[0] === USER.unflaggedEditor)).toBe(true);
      expect(new Set(later.map((meta) => meta.runId)).size).toBe(2);
    }
    expect(runDryrun(db)).toEqual([]);
    db.close();
  });
});
