import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  const result = await saveProjectSubtask(commandInput(projectId, { kind: "create", item: { title }, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-01" } } }));
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
      { outcome: "invalid_request", status: 503, code: "subtask_schedule_ranges_disabled", message: "disabled" },
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
        assignmentNotice: { projectId: "project", actorId: "actor", assigneeId: "assignee", subtaskId: "item", assignmentVersion: 2 },
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
    const missingSubtask = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: crypto.randomUUID(), scheduleRequest: { expectedVersion: 0, schedule: { state: "unscheduled" } } }));
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
    const scheduleLost = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: scheduled.item.id, itemPatch: { title: "Losing title" }, scheduleRequest: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-03" } } } }, { env: { ...baseEnv, DB: scheduleDb } }));
    expect(scheduleLost.outcome).toBe("schedule_conflict"); expect(scheduleCalls.count).toBe(1);
    const auditAfterScheduleLoss = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.update'").bind(scheduled.item.id).first();
    expect(auditAfterScheduleLoss).toEqual({ count: 0 });

    const item = await createDueItem();
    const itemCalls = { count: 0 };
    const itemDb = faultDb(async (db) => { await db.prepare("UPDATE project_subtasks SET title = 'Authoritative title' WHERE id = ?").bind(item.item.id).run(); }, itemCalls);
    const itemLost = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: item.item.id, itemPatch: { title: "Losing title" }, scheduleRequest: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-01" } } } }, { env: { ...baseEnv, DB: itemDb } }));
    expect(itemLost.outcome).toBe("item_conflict"); if (itemLost.outcome === "item_conflict") expect(itemLost.currentSubtask.title).toBe("Authoritative title"); expect(itemCalls.count).toBe(1);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.update'").bind(item.item.id).first()).toEqual({ count: 0 });
  });

  it("fences every schedule column and leaves the losing writer footprint empty", async () => {
    const axes: Array<[string, string]> = [
      ["due_date", "'2027-01-02'"], ["schedule_start_kind", "'date'"], ["schedule_start_civil", "'2027-01-01'"],
      ["schedule_start_at", "1"], ["schedule_start_utc_offset_minutes", "601"], ["schedule_start_fold", "1"],
      ["schedule_end_kind", "'timed'"], ["schedule_end_at", "1"], ["schedule_end_utc_offset_minutes", "601"],
      ["schedule_end_fold", "1"], ["schedule_zone", "NULL"],
    ];
    for (const [column, value] of axes) {
      const created = await createDueItem(commandProjectId, `Fence ${column}`);
      const beforeAudit = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(created.item.id).first<{ count: number }>())!.count;
      const beforeActivity = (await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
      const beforeOutbox = (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count;
      const calls = { count: 0 };
      const db = faultDb(async (databaseForFault) => { await databaseForFault.prepare(`UPDATE project_subtasks SET ${column} = ${value} WHERE id = ?`).bind(created.item.id).run(); }, calls);
      const result = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, scheduleRequest: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-03" } } } }, { env: { ...baseEnv, DB: db } }));
      expect(result.outcome, column).toBe("schedule_conflict"); expect(calls.count, column).toBe(1);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(created.item.id).first<{ count: number }>())!.count).toBe(beforeAudit);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count).toBe(beforeActivity);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(commandProjectId).first<{ count: number }>())!.count).toBe(beforeOutbox);
    }
  });

  it("returns zero, one, or two committed publication IDs from the corresponding bundles", async () => {
    const created = await createDueItem();
    const noop = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, scheduleRequest: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-01" } } } }));
    expect(noop.outcome).toBe("noop"); if (noop.outcome === "noop") expect(noop.broadPublicationIds).toEqual([]);
    const one = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, itemPatch: { title: "Item bundle" } }));
    expect(one.outcome).toBe("updated"); if (one.outcome === "updated") { expect(one.broadPublicationIds).toHaveLength(1); for (const id of one.broadPublicationIds) expect(await database.DB.prepare("SELECT id FROM notification_outbox WHERE id = ?").bind(id).first()).toEqual({ id }); }
    const two = await saveProjectSubtask(commandInput(commandProjectId, { kind: "update", subtaskId: created.item.id, itemPatch: { done: true }, scheduleRequest: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-02" } } } }));
    expect(two.outcome).toBe("updated"); if (two.outcome === "updated") { expect(two.broadPublicationIds).toHaveLength(2); for (const id of two.broadPublicationIds) expect(await database.DB.prepare("SELECT id FROM notification_outbox WHERE id = ?").bind(id).first()).toEqual({ id }); }
  });
});
