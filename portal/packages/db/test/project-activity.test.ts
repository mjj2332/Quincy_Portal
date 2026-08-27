import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProjectActivityStatements } from "../src/project-activity";
import { EMAIL_ENABLED_EVENTS } from "../src/notifications";
import { projectActivityDeepLink, type ProjectActivityIntent } from "@quincy/shared";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyMigrations(db: SqliteDatabase): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

class LocalD1Statement {
  constructor(private readonly db: SqliteDatabase, private readonly sql: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const statement = this.db.prepare(this.sql);
    return {
      run: async () => statement.run(...values),
      all: async <T>() => ({ results: statement.all(...values) as T[] }),
    } as unknown as D1PreparedStatement;
  }
}

function localD1(db: SqliteDatabase): D1Database {
  return { prepare: (sql: string) => new LocalD1Statement(db, sql) } as unknown as D1Database;
}

async function runBundle(bundle: ReturnType<typeof buildProjectActivityStatements>): Promise<void> {
  for (const statement of bundle.statements) await statement.run();
}

function intent(type: "project.priority.changed" | "project.comment.edited", id: string, occurredAt: number, auditId: string): ProjectActivityIntent {
  const projectId = "tb4c-project";
  const comment = type === "project.comment.edited";
  const sourceId = comment ? "comment-1" : projectId;
  return {
    schemaVersion: 1,
    activity: {
      id,
      type,
      projectId,
      actorId: "tb4c-editor",
      actorKind: "user",
      occurredAt,
      source: {
        kind: comment ? "project_comment" : "project_priority",
        id: sourceId,
        key: comment ? `project-comment:${sourceId}:edited:${id}` : `project-priority:${projectId}:change:${id}`,
      },
      safePayload: comment ? { commentId: sourceId } : { priority: 3 },
      deepLink: projectActivityDeepLink(type, projectId),
    },
    broadDelivery: {
      registryKey: type,
      sourceActivityId: id,
      coalesce: comment ? { strategy: "leading_edge", key: `project-comment-edit:${projectId}:${sourceId}:tb4c-editor`, windowSeconds: 300 } : null,
    },
  };
}

function addAudit(db: SqliteDatabase, id: string, createdAt: number): void {
  db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'project.test', 'projects', ?, '{}', ?)").run(id, "tb4c-editor", "tb4c-project", createdAt);
}

describe("TB4C activity marker and exact-cycle fan-out", () => {
  it("keeps broad projections out of the email admission allowlist", () => {
    expect(EMAIL_ENABLED_EVENTS).not.toContain("project_activity");
    expect(EMAIL_ENABLED_EVENTS).not.toContain("project_collaboration_activity");
  });

  it("writes no activity without the winning audit marker, then fans out once and remains replay-idempotent", async () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const now = 1_787_000_000_000;
    for (const [id, role, active] of [["tb4c-editor", "editor", 1], ["tb4c-admin", "admin", 1], ["tb4c-unassigned", "admin", 1], ["tb4c-inactive", "editor", 0], ["tb4c-photographer", "photographer", 1]] as const) {
      db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)").run(id, id, `${id}@example.test`, role, active, now, now);
    }
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(now, now);
    for (const [id, userId, createdAt] of [["cycle-editor", "tb4c-editor", now - 1000], ["cycle-admin", "tb4c-admin", now - 1000], ["cycle-inactive", "tb4c-inactive", now - 1000], ["cycle-photographer", "tb4c-photographer", now - 1000]] as const) {
      db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, 'tb4c-project', ?, 'editor', ?)").run(id, userId, createdAt);
    }
    const d1 = localD1(db);
    const first = buildProjectActivityStatements({ db: d1, intent: intent("project.priority.changed", "priority-activity", now, "winning-audit") , winnerAuditId: "winning-audit", createdAt: now });
    await runBundle(first);
    expect(db.prepare("SELECT count(*) AS count FROM project_activity_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM notification_outbox").get()).toEqual({ count: 0 });

    addAudit(db, "winning-audit", now);
    await runBundle(first);
    expect(db.prepare("SELECT count(*) AS count FROM project_activity_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT recipient_id AS recipientId, recipient_membership_cycle_id AS cycle FROM notification_outbox WHERE event_type = 'project.activity.broad' ORDER BY recipient_id").all()).toEqual([
      { recipientId: "tb4c-admin", cycle: "cycle-admin" },
      { recipientId: "tb4c-editor", cycle: "cycle-editor" },
    ]);
    expect(db.prepare("SELECT channel, count(*) AS count FROM notification_delivery_ledger GROUP BY channel").all()).toEqual([{ channel: "in_app", count: 2 }]);

    await runBundle(first);
    expect(db.prepare("SELECT count(*) AS count FROM project_activity_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM notification_outbox").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM notification_delivery_ledger").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT payload_json FROM notification_outbox WHERE event_type = 'project.activity.broad'").all()).not.toContainEqual(expect.objectContaining({ payload_json: expect.stringContaining("body") }));
    db.close();
  });

  it("keeps coalescing scoped to the exact membership cycle across remove and re-add", async () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const start = 1_787_000_000_000;
    for (const id of ["tb4c-editor", "tb4c-admin"]) db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").run(id, id, `${id}@example.test`, start, start);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(start, start);
    db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('old-cycle', 'tb4c-project', 'tb4c-editor', 'editor', ?)").run(start - 1000);
    db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('admin-cycle', 'tb4c-project', 'tb4c-admin', 'editor', ?)").run(start - 1000);
    const d1 = localD1(db);

    addAudit(db, "comment-audit-1", start);
    await runBundle(buildProjectActivityStatements({ db: d1, intent: intent("project.comment.edited", "comment-activity-1", start, "comment-audit-1"), winnerAuditId: "comment-audit-1", createdAt: start }));
    expect(db.prepare("SELECT recipient_id AS recipientId, recipient_membership_cycle_id AS cycle FROM notification_outbox WHERE event_type = 'project.activity.broad' AND coalesce_key IS NOT NULL ORDER BY recipient_id").all()).toEqual([
      { recipientId: "tb4c-admin", cycle: "admin-cycle" },
      { recipientId: "tb4c-editor", cycle: "old-cycle" },
    ]);

    db.prepare("DELETE FROM project_members WHERE id = 'old-cycle'").run();
    db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('new-cycle', 'tb4c-project', 'tb4c-editor', 'editor', ?)").run(start + 1000);
    addAudit(db, "comment-audit-2", start + 2000);
    await runBundle(buildProjectActivityStatements({ db: d1, intent: intent("project.comment.edited", "comment-activity-2", start + 2000, "comment-audit-2"), winnerAuditId: "comment-audit-2", createdAt: start + 2000 }));

    expect(db.prepare("SELECT recipient_id AS recipientId, recipient_membership_cycle_id AS cycle FROM notification_outbox WHERE event_type = 'project.activity.broad' AND coalesce_key IS NOT NULL ORDER BY recipient_id, cycle").all()).toEqual([
      { recipientId: "tb4c-admin", cycle: "admin-cycle" },
      { recipientId: "tb4c-editor", cycle: "new-cycle" },
      { recipientId: "tb4c-editor", cycle: "old-cycle" },
    ]);
    expect(db.prepare("SELECT count(*) AS count FROM notification_outbox WHERE event_type = 'project.activity.broad' AND recipient_id = 'tb4c-admin'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE channel = 'email'").get()).toEqual({ count: 0 });
    db.close();
  });

  it("keeps the leading-edge window open before, and starts a new one at, the exact boundary", async () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const start = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb4c-editor', 'TB4C Editor', 'tb4c-editor@example.test', 1, 'editor', 1, ?, ?)").run(start, start);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(start, start);
    db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('cycle-editor', 'tb4c-project', 'tb4c-editor', 'editor', ?)").run(start - 1000);
    const d1 = localD1(db);

    addAudit(db, "comment-audit-first", start);
    await runBundle(buildProjectActivityStatements({ db: d1, intent: intent("project.comment.edited", "comment-activity-first", start, "comment-audit-first"), winnerAuditId: "comment-audit-first", createdAt: start }));
    addAudit(db, "comment-audit-before-boundary", start + 299_999);
    await runBundle(buildProjectActivityStatements({ db: d1, intent: intent("project.comment.edited", "comment-activity-before-boundary", start + 299_999, "comment-audit-before-boundary"), winnerAuditId: "comment-audit-before-boundary", createdAt: start + 299_999 }));
    expect(db.prepare("SELECT count(*) AS count FROM notification_outbox WHERE event_type = 'project.activity.broad'").get()).toEqual({ count: 1 });

    addAudit(db, "comment-audit-at-boundary", start + 300_000);
    await runBundle(buildProjectActivityStatements({ db: d1, intent: intent("project.comment.edited", "comment-activity-at-boundary", start + 300_000, "comment-audit-at-boundary"), winnerAuditId: "comment-audit-at-boundary", createdAt: start + 300_000 }));
    expect(db.prepare("SELECT count(*) AS count FROM notification_outbox WHERE event_type = 'project.activity.broad'").get()).toEqual({ count: 2 });
    db.close();
  });
});
