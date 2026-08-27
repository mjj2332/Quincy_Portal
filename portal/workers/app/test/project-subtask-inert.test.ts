import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { Env, SessionUser } from "../src/env";

vi.mock("@quincy/shared", async () => ({
  ...(await vi.importActual<typeof import("@quincy/shared")>("@quincy/shared")),
  CHECKLIST_SCHEDULE_RANGES_ENABLED: false,
}));

const { saveProjectSubtask, serializeProjectSubtask } = await import("../src/lib/project-subtasks");
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const projectId = "8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "81111111-1111-4111-8111-111111111111";
const principal: SessionUser = { id: userId, email: `${userId}@example.test`, name: "Inert Editor", role: "editor", active: true, impersonatedBy: null };
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Inert Editor', ?, 1, 'editor', 1, ?, ?)").bind(userId, principal.email, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Inert schedule', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now).run();
});

type Operation = Parameters<typeof saveProjectSubtask>[0]["operation"];
function command(operation: Operation) { return saveProjectSubtask({ env: baseEnv, projectId, principal, operation }); }
function rangeSchedule(start = "2027-02-01", end = "2027-02-02") { return { state: "range" as const, start: { kind: "date" as const, localCivil: start }, end: { kind: "date" as const, localCivil: end } }; }
async function footprint() {
  const [subtasks, audit, activity, outbox, ledger] = await Promise.all([
    database.DB.prepare("SELECT count(*) AS count FROM project_subtasks WHERE project_id = ?").bind(projectId).first<{ count: number }>(),
    database.DB.prepare("SELECT count(*) AS count FROM audit_log").first<{ count: number }>(),
    database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(projectId).first<{ count: number }>(),
    database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(projectId).first<{ count: number }>(),
    database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(projectId).first<{ count: number }>(),
  ]);
  return { subtasks: subtasks?.count ?? 0, audit: audit?.count ?? 0, activity: activity?.count ?? 0, outbox: outbox?.count ?? 0, ledger: ledger?.count ?? 0 };
}

describe("TB4D inert schedule artifact", () => {
  it("permits a due-only transition but forces activity-only delivery", async () => {
    const created = await saveProjectSubtask({ env: baseEnv, projectId, principal, operation: { kind: "create", item: { title: "Inert due" }, schedule: { state: "unscheduled" } } });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("Fixture creation failed");
    const updated = await saveProjectSubtask({ env: baseEnv, projectId, principal, operation: { kind: "update", subtaskId: created.item.id, scheduleRequest: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-01" } } } } });
    expect(updated.outcome).toBe("updated");
    if (updated.outcome !== "updated") throw new Error("Inert due-only update failed");
    expect(updated.broadPublicationIds).toEqual([]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox o JOIN project_activity_events a ON a.id = o.source_key WHERE o.project_id = ? AND o.event_type = 'project.activity.broad' AND a.event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id JOIN project_activity_events a ON a.id = o.source_key WHERE o.project_id = ? AND a.event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual({ count: 0 });
  });

  it("rejects range creation and both unscheduled-to-range and due-to-range updates before any write", async () => {
    const beforeCreate = await footprint();
    const rejectedCreate = await command({ kind: "create", item: { title: "Inert range create" }, schedule: rangeSchedule() });
    expect(rejectedCreate).toEqual({ outcome: "invalid_request", status: 503, code: "subtask_schedule_ranges_disabled", message: "Range scheduling is not enabled in this app version." });
    expect(await footprint()).toEqual(beforeCreate);

    const unscheduled = await command({ kind: "create", item: { title: "Inert unscheduled" }, schedule: { state: "unscheduled" } });
    expect(unscheduled.outcome).toBe("created");
    if (unscheduled.outcome !== "created") throw new Error("Unscheduled fixture creation failed");
    const beforeUnscheduledRange = await footprint();
    const rejectedUnscheduledRange = await command({ kind: "update", subtaskId: unscheduled.item.id, scheduleRequest: { expectedVersion: 0, schedule: rangeSchedule() } });
    expect(rejectedUnscheduledRange).toMatchObject({ outcome: "invalid_request", status: 503, code: "subtask_schedule_ranges_disabled" });
    expect(await footprint()).toEqual(beforeUnscheduledRange);

    const due = await command({ kind: "create", item: { title: "Inert due for range" }, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-15" } } });
    expect(due.outcome).toBe("created");
    if (due.outcome !== "created") throw new Error("Due-only fixture creation failed");
    const beforeDueRange = await footprint();
    const rejectedDueRange = await command({ kind: "update", subtaskId: due.item.id, scheduleRequest: { expectedVersion: 1, schedule: rangeSchedule("2027-01-15", "2027-01-16") } });
    expect(rejectedDueRange).toMatchObject({ outcome: "invalid_request", status: 503, code: "subtask_schedule_ranges_disabled" });
    expect(await footprint()).toEqual(beforeDueRange);
  });

  it("keeps legacy dueDate passthroughs, clear, and pre-existing range reads available", async () => {
    const beforeLegacyScheduleEvents = await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.checklist.schedule_changed'").bind(projectId).first<{ count: number }>();
    const legacy = await command({ kind: "create", item: { title: "Inert legacy timed" }, legacyDueDate: "2027-03-01T09:15" });
    expect(legacy.outcome).toBe("created");
    if (legacy.outcome !== "created") throw new Error("Legacy fixture creation failed");
    expect(legacy.item.schedule).toMatchObject({ state: "due_only", version: 0, due: "2027-03-01T09:15" });
    expect(await database.DB.prepare("SELECT due_date AS dueDate, schedule_start_kind AS startKind, schedule_end_kind AS endKind, schedule_zone AS zone, schedule_version AS version FROM project_subtasks WHERE id = ?").bind(legacy.item.id).first()).toEqual({ dueDate: "2027-03-01T09:15", startKind: null, endKind: null, zone: null, version: 0 });
    const legacyPatch = await command({ kind: "update", subtaskId: legacy.item.id, legacyDueDatePatch: "2027-03-02T10:15" });
    expect(legacyPatch.outcome).toBe("updated");
    if (legacyPatch.outcome !== "updated") throw new Error("Legacy patch failed");
    expect(legacyPatch.item.schedule).toMatchObject({ state: "due_only", version: 0, due: "2027-03-02T10:15" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual(beforeLegacyScheduleEvents);

    const due = await command({ kind: "create", item: { title: "Inert clearable due" }, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-04-01" } } });
    expect(due.outcome).toBe("created");
    if (due.outcome !== "created") throw new Error("Clear fixture creation failed");
    const cleared = await command({ kind: "update", subtaskId: due.item.id, scheduleRequest: { expectedVersion: 1, schedule: { state: "unscheduled" } } });
    expect(cleared.outcome).toBe("updated");
    if (cleared.outcome !== "updated") throw new Error("Inert clear failed");
    expect(cleared.item.schedule).toMatchObject({ state: "unscheduled", version: 2, start: null, end: null, due: null });
    expect(await database.DB.prepare("SELECT due_date AS dueDate, schedule_start_kind AS startKind, schedule_end_kind AS endKind, schedule_zone AS zone, schedule_version AS version FROM project_subtasks WHERE id = ?").bind(due.item.id).first()).toEqual({ dueDate: null, startKind: null, endKind: null, zone: null, version: 2 });

    const rangeId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Pre-existing range', 0, 999999, NULL, 0, ?, 'date', ?, NULL, NULL, NULL, 'date', NULL, NULL, NULL, 'Australia/Sydney', 1, ?, ?, ?)").bind(rangeId, projectId, "2027-05-02", "2027-05-01", userId, now, now).run();
    const rangeRow = await createDb(database.DB).select({ subtask: schema.projectSubtasks, assigneeId: schema.user.id, assigneeName: schema.user.name }).from(schema.projectSubtasks).leftJoin(schema.user, eq(schema.projectSubtasks.assigneeId, schema.user.id)).where(eq(schema.projectSubtasks.id, rangeId)).get();
    if (!rangeRow) throw new Error("Pre-existing range fixture could not be read");
    expect(serializeProjectSubtask(rangeRow).schedule).toMatchObject({ state: "range", version: 1, zone: "Australia/Sydney", start: { localCivil: "2027-05-01" }, end: { localCivil: "2027-05-02" }, due: "2027-05-02" });
  });
});
