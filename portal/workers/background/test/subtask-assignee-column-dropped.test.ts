import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { presetSubtaskInsertValues, type NotificationOutboxMessage } from "@quincy/shared";
import { emitExternalSubtaskNotification, emitStaffSubtaskAssignedNotification } from "@quincy/db";
import type { Env } from "../src/env";
import { processNotificationMessage } from "../src/notification-delivery";

/**
 * #373 part 1: the background worker reads and writes no `project_subtasks.assignee_id`. Migration 0050 drops the column
 * and its index (applied by the migration loader), Subtasks are seeded through
 * the relation only, and the delivery path (resolver + channel admission) must still work. The reminder scan reads the relation only: see subtask-reminders.integration.test.ts.
 */
const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
}, 60_000);

function deliveryEnv(send?: ReturnType<typeof vi.fn>): Env {
  return {
    DB: database.DB,
    APP_ENV: "test",
    APP_ORIGIN: "https://portal.test",
    NOTIFICATION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    EMAIL: send ? { send } : undefined,
    NOTIFICATIONS_FROM_ADDRESS: send ? "studio@example.test" : undefined,
  } as unknown as Env;
}

function message(outboxId: string) {
  return { body: { type: "notification_outbox", outboxId } as NotificationOutboxMessage, attempts: 0, ack: vi.fn(), retry: vi.fn() } as never;
}

async function seed(dueDate: string) {
  const now = Date.now();
  const projectId = crypto.randomUUID(); const actorId = crypto.randomUUID(); const staffId = crypto.randomUUID(); const externalId = crypto.randomUUID(); const subtaskId = crypto.randomUUID();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Actor', ?, 1, 'editor', 1, ?, ?), (?, 'Staff', ?, 1, 'editor', 1, ?, ?), (?, 'External', ?, 1, 'external_editor', 1, ?, ?)").bind(actorId, `${actorId}@example.test`, now, now, staffId, `${staffId}@example.test`, now, now, externalId, `${externalId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Dropped Column Street', 'editing', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?), (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, staffId, now, crypto.randomUUID(), projectId, externalId, now),
    database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Relation only', 0, 0, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(subtaskId, projectId, ...presetSubtaskInsertValues(dueDate.slice(0, 10)), actorId, now, now),
    database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?), (?, ?, 2, ?)").bind(subtaskId, staffId, now, subtaskId, externalId, now + 1),
  ]);
  return { projectId, actorId, staffId, externalId, subtaskId };
}

const notices = async (sourceKey: string, userId: string) => (await database.DB.prepare("SELECT type FROM notifications WHERE source_key = ? AND user_id = ?").bind(sourceKey, userId).all<{ type: string }>()).results;
const outboxStatus = async (sourceKey: string, recipientId: string) => (await database.DB.prepare("SELECT status, last_error AS lastError FROM notification_outbox WHERE source_key = ? AND recipient_id = ?").bind(sourceKey, recipientId).first<{ status: string; lastError: string | null }>());

describe("with project_subtasks.assignee_id dropped", () => {
  it("the column is really gone", async () => {
    const columns = (await database.DB.prepare("SELECT name FROM pragma_table_info('project_subtasks')").all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).not.toContain("assignee_id");
    expect((await database.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'project_subtasks_assignee_idx'").all()).results).toEqual([]);
  });

  it("delivers a staff subtask_assigned notice (resolver and staff channel admission)", async () => {
    const fixture = await seed("2099-12-31");
    // #489: staff default to a digest; this test is about the immediate channel, so opt the assignee into Immediately.
    await database.DB.prepare("INSERT INTO notification_preferences (user_id, email_digest_cadence, updated_at) VALUES (?, 'immediate', ?)").bind(fixture.staffId, Date.now()).run();
    const sourceKey = `subtask-assignment:${fixture.subtaskId}:1`;
    const [outboxId] = await emitStaffSubtaskAssignedNotification(database.DB, { projectId: fixture.projectId, actorId: fixture.actorId, assigneeId: fixture.staffId, subtaskId: fixture.subtaskId, assignmentVersion: 1, sourceKey });
    const send = vi.fn().mockResolvedValue({ messageId: "dropped-staff" });
    await processNotificationMessage(deliveryEnv(send), message(outboxId!));
    expect(await outboxStatus(sourceKey, fixture.staffId)).toEqual({ status: "completed", lastError: null });
    expect(await notices(sourceKey, fixture.staffId)).toEqual([{ type: "subtask_assigned" }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("delivers an external subtask_assigned notice (external resolver and channel admission)", async () => {
    const fixture = await seed("2099-12-31");
    const sourceKey = `subtask-assignment:${fixture.subtaskId}:2`;
    const [outboxId] = await emitExternalSubtaskNotification(database.DB, { projectId: fixture.projectId, actorId: fixture.actorId, assigneeId: fixture.externalId, subtaskId: fixture.subtaskId, assignmentVersion: 2, sourceKey, kind: "assigned" });
    const send = vi.fn().mockResolvedValue({ messageId: "dropped-external" });
    await processNotificationMessage(deliveryEnv(send), message(outboxId!));
    expect(await outboxStatus(sourceKey, fixture.externalId)).toEqual({ status: "completed", lastError: null });
    expect(await notices(sourceKey, fixture.externalId)).toEqual([{ type: "subtask_assigned" }]);
  });
});
