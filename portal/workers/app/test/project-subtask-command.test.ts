import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChecklistScheduleStorageError } from "@quincy/shared";
import type { Env, SessionUser } from "../src/env";
import { saveProjectSubtask, finalizeProjectSubtaskCommandResult, type ProjectSubtaskCommandResult, type ProjectSubtaskDto } from "../src/lib/project-subtasks";

const notifySubtaskAssigneeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/lib/notifications", () => ({ notifySubtaskAssignee: notifySubtaskAssigneeMock }));

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const commandProjectId = "9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const commandUserId = "91111111-1111-4111-8111-111111111111";
const commandAdminId = "92222222-2222-4222-8222-222222222222";
const commandPrincipal: SessionUser = { id: commandUserId, email: `${commandUserId}@example.test`, name: "Command Editor", role: "editor", active: true, impersonatedBy: null };
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

async function seedProject(projectId: string, memberId = crypto.randomUUID()) {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(projectId, `Command ${projectId}`, now, now).run();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(memberId, projectId, commandUserId, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Command Editor', ?, 1, 'editor', 1, ?, ?), (?, 'Command Admin', ?, 1, 'admin', 1, ?, ?)").bind(commandUserId, commandPrincipal.email, now, now, commandAdminId, `${commandAdminId}@example.test`, now, now).run();
  await seedProject(commandProjectId);
});

function commandInput(projectId: string, operation: Parameters<typeof saveProjectSubtask>[0]["operation"], overrides: Partial<Parameters<typeof saveProjectSubtask>[0]> = {}) {
  return { env: baseEnv, projectId, principal: commandPrincipal, operation, ...overrides } satisfies Parameters<typeof saveProjectSubtask>[0];
}

async function createDueItem(projectId = commandProjectId, title = `Command item ${crypto.randomUUID()}`) {
  const result = await saveProjectSubtask(commandInput(projectId, { kind: "create", item: { title }, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-01" } } }));
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("Fixture creation failed");
  return result;
}

async function createTimedItem(title: string) {
  const result = await saveProjectSubtask(commandInput(commandProjectId, { kind: "create", item: { title }, schedule: { state: "range", start: { kind: "timed", localCivil: "2027-01-01T08:00" }, end: { kind: "timed", localCivil: "2027-01-01T09:30" } } }));
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("Fixture creation failed");
  return result;
}

function faultDb(fault: (db: D1Database) => Promise<void>, calls: { count: number }) {
  let injected = false;
  return new Proxy(baseEnv.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          calls.count += 1;
          if (!injected) { injected = true; await fault(database.DB); }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as D1Database;
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return { pending, executionCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } };
}

const item = {} as ProjectSubtaskDto;

describe("saveProjectSubtask finalizer boundary", () => {
  it("does nothing for every non-success result arm", async () => {
    const results: ProjectSubtaskCommandResult[] = [
      { outcome: "invalid_request", status: 400, code: "bad", message: "bad" },
      { outcome: "forbidden" },
      { outcome: "not_found", target: "project" },
      { outcome: "schedule_conflict", current: {} as never },
      { outcome: "item_conflict", current: {} as never, currentSubtask: item },
      { outcome: "storage_invalid", current: { state: "invalid" } as never },
    ];
    for (const result of results) {
      const { pending, executionCtx } = executionContext();
      await finalizeProjectSubtaskCommandResult({ env: {} as never, executionCtx, result });
      expect(pending).toHaveLength(0);
    }
    expect(notifySubtaskAssigneeMock).not.toHaveBeenCalled();
  });

  it("publishes each committed broad id once and sends the targeted notice once", async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue(undefined) })) })) };
    const env = { NOTIFICATION_QUEUE: queue, DB: db } as never;
    const { pending, executionCtx } = executionContext();
    await finalizeProjectSubtaskCommandResult({
      env,
      executionCtx,
      result: {
        outcome: "updated",
        item,
        broadPublicationIds: ["outbox-1", "outbox-2"],
        assignmentNotices: [{ projectId: "project", actorId: "actor", assigneeId: "assignee", subtaskId: "item", assignmentVersion: 2 }],
      },
    });
    expect(pending).toHaveLength(1);
    expect(notifySubtaskAssigneeMock).toHaveBeenCalledTimes(1);
    await pending[0];
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenNthCalledWith(1, { type: "notification_outbox", outboxId: "outbox-1" });
    expect(queue.send).toHaveBeenNthCalledWith(2, { type: "notification_outbox", outboxId: "outbox-2" });
  });
});

describe("saveProjectSubtask command boundary", () => {
  it("checks direct-call principal and project authorization before mutation", async () => {
    const inactive = await saveProjectSubtask(commandInput(commandProjectId, { kind: "create", item: { title: "Inactive" } }, { principal: { ...commandPrincipal, active: false } }));
    expect(inactive).toEqual({ outcome: "forbidden" });
    const removedProjectId = crypto.randomUUID(); await seedProject(removedProjectId);
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(removedProjectId, commandUserId).run();
    const removed = await saveProjectSubtask(commandInput(removedProjectId, { kind: "create", item: { title: "Removed" } }));
    expect(removed).toEqual({ outcome: "forbidden" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_subtasks WHERE project_id IN (?, ?)").bind(commandProjectId, removedProjectId).first()).toEqual({ count: 0 });
  });

  it("returns the command's not-found and both deterministic fence-loss arms without retrying", async () => {
    const missingProject = await saveProjectSubtask(commandInput(crypto.randomUUID(), { kind: "create", item: { title: "Missing project" } }, { principal: { ...commandPrincipal, id: commandAdminId, email: `${commandAdminId}@example.test`, name: "Command Admin", role: "admin" } }));
    expect(missingProject).toEqual({ outcome: "not_found", target: "project" });
    const missingSubtask = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: crypto.randomUUID(), scheduleRequest: { expectedVersion: 0, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-01" } } } }));
    expect(missingSubtask).toEqual({ outcome: "not_found", target: "subtask" });

    const deleted = await createDueItem();
    const beforeDeletedAudit = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(deleted.item.id).first<{ count: number }>())!.count;
    const beforeDeletedActivity = (await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
    const beforeDeletedOutbox = (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
    const deletionCalls = { count: 0 };
    const deletionDb = faultDb(async (db) => { await db.prepare("DELETE FROM project_subtasks WHERE id = ?").bind(deleted.item.id).run(); }, deletionCalls);
    const deletedRace = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: deleted.item.id, itemPatch: { title: "Deleted during save" } }, { env: { ...baseEnv, DB: deletionDb } }));
    expect(deletedRace).toEqual({ outcome: "not_found", target: "subtask" });
    expect(deletionCalls.count).toBe(1);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(deleted.item.id).first<{ count: number }>())!.count).toBe(beforeDeletedAudit);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count).toBe(beforeDeletedActivity);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count).toBe(beforeDeletedOutbox);

    const scheduled = await createDueItem();
    const scheduleCalls = { count: 0 };
    const scheduleDb = faultDb(async (db) => { await db.prepare("UPDATE project_subtasks SET due_date = '2027-01-02' WHERE id = ?").bind(scheduled.item.id).run(); }, scheduleCalls);
    const scheduleLost = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: scheduled.item.id, itemPatch: { title: "Losing title" }, scheduleRequest: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-03" } } } }, { env: { ...baseEnv, DB: scheduleDb } }));
    expect(scheduleLost.outcome).toBe("schedule_conflict"); expect(scheduleCalls.count).toBe(1);
    const auditAfterScheduleLoss = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.update'").bind(scheduled.item.id).first();
    expect(auditAfterScheduleLoss).toEqual({ count: 0 });

    const item = await createDueItem();
    const itemCalls = { count: 0 };
    const itemDb = faultDb(async (db) => { await db.prepare("UPDATE project_subtasks SET title = 'Authoritative title' WHERE id = ?").bind(item.item.id).run(); }, itemCalls);
    const itemLost = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: item.item.id, itemPatch: { title: "Losing title" }, scheduleRequest: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-01" } } } }, { env: { ...baseEnv, DB: itemDb } }));
    expect(itemLost.outcome).toBe("item_conflict"); if (itemLost.outcome === "item_conflict") expect(itemLost.currentSubtask.title).toBe("Authoritative title"); expect(itemCalls.count).toBe(1);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.update'").bind(item.item.id).first()).toEqual({ count: 0 });
  });

  // A concurrent writer can only leave the row a valid range now: the database refuses anything else (#343, ADR 0011).
  // Every axis is a whole valid move (a partial timed edit would not resolve), so together they touch every schedule
  // column except `schedule_zone`, which has one legal value and so cannot change to another valid one. The corrupting
  // axes are pinned by migration-0047.test.ts.
  const utc = (y: number, m: number, d: number, h: number, min: number) => Date.UTC(y, m - 1, d, h, min);
  const setTimed = (startCivil: string, startAt: number, startOff: number, startFold: number, endCivil: string, endAt: number, endOff: number, endFold: number) =>
    `schedule_start_kind = 'timed', schedule_start_civil = '${startCivil}', schedule_start_at = ${startAt}, schedule_start_utc_offset_minutes = ${startOff}, schedule_start_fold = ${startFold}, schedule_end_kind = 'timed', due_date = '${endCivil}', schedule_end_at = ${endAt}, schedule_end_utc_offset_minutes = ${endOff}, schedule_end_fold = ${endFold}`;
  const setDate = (start: string, end: string) =>
    `schedule_start_kind = 'date', schedule_start_civil = '${start}', schedule_start_at = NULL, schedule_start_utc_offset_minutes = NULL, schedule_start_fold = NULL, schedule_end_kind = 'date', due_date = '${end}', schedule_end_at = NULL, schedule_end_utc_offset_minutes = NULL, schedule_end_fold = NULL`;
  it("fences every schedule column and leaves the losing writer footprint empty", async () => {
    const axes: Array<[string, "date" | "timed", string]> = [
      ["date: due_date", "date", "due_date = '2027-01-02'"],
      ["date: schedule_start_civil", "date", "schedule_start_civil = '2027-01-01'"],
      ["date: schedule_version", "date", "schedule_version = 2"],
      ["date to timed: kinds, instants, offsets, folds", "date", setTimed("2027-01-05T08:00", utc(2027, 1, 4, 21, 0), 660, 0, "2027-01-05T09:30", utc(2027, 1, 4, 22, 30), 660, 0)],
      ["timed: start civil and start instant", "timed", "schedule_start_civil = '2027-01-01T07:00', schedule_start_at = " + utc(2026, 12, 31, 20, 0)],
      ["timed: end civil (due_date) and end instant", "timed", "due_date = '2027-01-01T10:00', schedule_end_at = " + utc(2026, 12, 31, 23, 0)],
      ["timed: start and end offsets (Sydney DST ends)", "timed", setTimed("2027-04-10T08:00", utc(2027, 4, 9, 22, 0), 600, 0, "2027-04-10T09:30", utc(2027, 4, 9, 23, 30), 600, 0)],
      ["timed: start and end folds (the repeated hour)", "timed", setTimed("2027-04-04T02:30", utc(2027, 4, 3, 16, 30), 600, 1, "2027-04-04T02:45", utc(2027, 4, 3, 16, 45), 600, 1)],
      ["timed to date: kinds and cleared instants, offsets, folds", "timed", setDate("2027-01-05", "2027-01-06")],
    ];
    for (const [column, baseKind, assignment] of axes) {
      const created = baseKind === "timed" ? await createTimedItem(`Fence ${column}`) : await createDueItem(commandProjectId, `Fence ${column}`);
      const beforeAudit = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(created.item.id).first<{ count: number }>())!.count;
      const beforeActivity = (await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
      const beforeOutbox = (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
      const calls = { count: 0 };
      const db = faultDb(async (databaseForFault) => { await databaseForFault.prepare(`UPDATE project_subtasks SET ${assignment} WHERE id = ?`).bind(created.item.id).run(); }, calls);
      // The concurrent writer moved the range (it cannot corrupt it: the database refuses that, #343), so the
      // fenced UPDATE loses with a conflict and the footprint is empty.
      const outcome = await (async () => { try { return (await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, scheduleRequest: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-03" } } } }, { env: { ...baseEnv, DB: db } }))).outcome; } catch (error) { return error instanceof ChecklistScheduleStorageError ? "storage_error" : Promise.reject(error); } })();
      expect(outcome, column).toBe("schedule_conflict"); expect(calls.count, column).toBe(1);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(created.item.id).first<{ count: number }>())!.count).toBe(beforeAudit);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count).toBe(beforeActivity);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count).toBe(beforeOutbox);
    }
  });

  it("returns zero, one, or two committed publication IDs from the corresponding bundles", async () => {
    const created = await createDueItem();
    const noop = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, scheduleRequest: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-01" } } } }));
    expect(noop.outcome).toBe("noop"); if (noop.outcome === "noop") expect(noop.broadPublicationIds).toEqual([]);
    const one = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, itemPatch: { title: "Item bundle" } }));
    expect(one.outcome).toBe("updated"); if (one.outcome === "updated") { expect(one.broadPublicationIds).toHaveLength(1); for (const id of one.broadPublicationIds) expect(await database.DB.prepare("SELECT id FROM notification_outbox WHERE id = ?").bind(id).first()).toEqual({ id }); }
    const two = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, itemPatch: { done: true }, scheduleRequest: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-02" } } } }));
    expect(two.outcome).toBe("updated"); if (two.outcome === "updated") { expect(two.broadPublicationIds).toHaveLength(2); for (const id of two.broadPublicationIds) expect(await database.DB.prepare("SELECT id FROM notification_outbox WHERE id = ?").bind(id).first()).toEqual({ id }); }
  });

  it("rejects a non-range schedule from a direct caller and writes nothing (the route schema is not the only fence)", async () => {
    const rows = async () => (await database.DB.prepare("SELECT count(*) AS count FROM project_subtasks WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
    const audits = async () => (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action LIKE 'project_subtask.%'").first<{ count: number }>())!.count;
    const rowsBefore = await rows(); const auditsBefore = await audits();
    const dueOnly = { state: "due_only", end: { kind: "date", localCivil: "2027-01-01" } } as const;
    for (const schedule of [dueOnly, { state: "unscheduled" } as const]) {
      const created = await saveProjectSubtask(commandInput(commandProjectId, { kind: "create", item: { title: "Direct legacy create" }, schedule }));
      expect(created).toMatchObject({ outcome: "invalid_request", status: 400, code: "subtask_schedule_range_required" });
    }
    expect(await rows()).toBe(rowsBefore);
    const target = await createDueItem();
    const beforeRow = await database.DB.prepare("SELECT due_date, schedule_version, updated_at FROM project_subtasks WHERE id = ?").bind(target.item.id).first();
    const auditsWithTarget = await audits();
    for (const schedule of [dueOnly, { state: "unscheduled" } as const]) {
      const updated = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: target.item.id, scheduleRequest: { expectedVersion: 1, schedule } }));
      expect(updated).toMatchObject({ outcome: "invalid_request", status: 400, code: "subtask_schedule_range_required" });
    }
    expect(await database.DB.prepare("SELECT due_date, schedule_version, updated_at FROM project_subtasks WHERE id = ?").bind(target.item.id).first()).toEqual(beforeRow);
    expect(await audits()).toBe(auditsWithTarget);
    expect(auditsBefore).toBeLessThanOrEqual(auditsWithTarget);
  });
});

describe("native assignee delta racing a concurrent edit (#368)", () => {
  it("a delta that loses the compare-and-swap to a title edit is an item conflict, never a silent 200 no-op, and writes nothing", async () => {
    const created = await createDueItem(commandProjectId, `Race ${crypto.randomUUID()}`);
    const subtaskId = created.item.id;
    const readState = async () => ({
      relation: (await database.DB.prepare("SELECT user_id, assignment_version FROM project_subtask_assignees WHERE subtask_id = ?").bind(subtaskId).all()).results,
      row: await database.DB.prepare("SELECT title, assignment_version FROM project_subtasks WHERE id = ?").bind(subtaskId).first<{ title: string; assignment_version: number }>(),
    });
    const before = await readState();
    expect(before.relation).toEqual([]);
    // Both saves read the same initial state; neither may write until both have reached the guarded batch.
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const gatedDb = {
      prepare: database.DB.prepare.bind(database.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothArrived;
        return database.DB.batch(statements);
      },
    } as unknown as D1Database;
    const gatedEnv = { ...baseEnv, DB: gatedDb } as Env;
    const titleEdit = saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId, itemPatch: { title: "Renamed in the race" } }, { env: gatedEnv }));
    const assign = saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId, itemPatch: { assignees: { expectedVersion: 0, add: [commandAdminId], remove: [] } } }, { env: gatedEnv }));
    // Batch order is call order: the title edit reaches its batch first and wins; the assignee delta loses.
    const [titleResult, assignResult] = await Promise.all([titleEdit, assign]);
    expect(titleResult.outcome).toBe("updated");
    expect(assignResult.outcome).toBe("item_conflict");
    if (assignResult.outcome === "item_conflict") expect(assignResult.currentSubtask).toMatchObject({ id: subtaskId, title: "Renamed in the race", assignees: [] });
    expect(await readState()).toEqual({ relation: [], row: { title: "Renamed in the race", assignment_version: before.row!.assignment_version } });
  });
});
