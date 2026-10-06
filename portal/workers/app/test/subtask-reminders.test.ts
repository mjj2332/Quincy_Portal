import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env, SessionUser } from "../src/env";
import { saveProjectSubtask, type ProjectSubtaskCommandResult } from "../src/lib/project-subtasks";

const notifySubtaskAssigneeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/lib/notifications", () => ({ notifySubtaskAssignee: notifySubtaskAssigneeMock }));

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "81111111-1111-4111-8111-111111111111";
const editorId = "82222222-2222-4222-8222-222222222222";
const otherId = "83333333-3333-4333-8333-333333333333";
const projectId = "8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principal: SessionUser = { id: editorId, email: `${editorId}@example.test`, name: "Reminder Editor", role: "editor", active: true, impersonatedBy: null };
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Every range sits in 2099, so no real clock matters: the command takes its own `now`. */
const START = "2099-06-10T09:00";
const END = "2099-06-12T17:00";
const END_AT = Date.parse("2099-06-12T17:00:00+10:00");
const NOW = Date.parse("2099-06-01T00:00:00Z");

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) { const headers = new Headers({ cookie: await cookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN); return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run(); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [otherId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('reminders-admin', ?, 'reminders-admin-token', ?, ?, ?)").bind(now + 3_600_000, adminId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Reminder Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
  for (const userId of [editorId, otherId]) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now).run();
});

type Occurrence = { id: string; schedule_version: number; kind: string; reminder_offset_minutes: number; fire_at: number; due_at: number; due_local_civil: string; status: string; terminal_reason: string | null; fired_at: number | null; created_by: string | null };
async function occurrencesOf(subtaskId: string): Promise<Occurrence[]> {
  return (await database.DB.prepare("SELECT id, schedule_version, kind, reminder_offset_minutes, fire_at, due_at, due_local_civil, status, terminal_reason, fired_at, created_by FROM project_subtask_reminder_occurrences WHERE subtask_id = ? ORDER BY schedule_version, reminder_offset_minutes DESC, status DESC").bind(subtaskId).all<Occurrence>()).results;
}
const shape = (rows: Occurrence[]) => rows.map((row) => `v${row.schedule_version} ${row.kind}${row.reminder_offset_minutes || ""} ${row.status}${row.terminal_reason ? `:${row.terminal_reason}` : ""}`);

async function create(title: string, options: { start?: string; end?: string; now?: number; assigneeIds?: string[]; offsets?: number[] } = {}): Promise<{ id: string; version: number }> {
  const result = await saveProjectSubtask({ env: baseEnv, projectId, principal, now: options.now ?? NOW, operation: { kind: "create", item: { title, assigneeIds: options.assigneeIds ?? [], ...(options.offsets ? { reminderOffsetsMinutes: options.offsets } : {}) }, schedule: { state: "range", start: { localCivil: options.start ?? START }, end: { localCivil: options.end ?? END } } } });
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("fixture");
  return { id: result.item.id, version: result.item.schedule.version };
}

async function update(subtaskId: string, operation: { itemPatch?: Record<string, unknown>; scheduleRequest?: { expectedVersion: number; end: string; start?: string; reminderOffsetsMinutes?: number[] } }, now = NOW, db: D1Database = baseEnv.DB): Promise<ProjectSubtaskCommandResult> {
  const { scheduleRequest, itemPatch } = operation;
  return saveProjectSubtask({
    env: { ...baseEnv, DB: db }, projectId, principal, now,
    operation: { kind: "update", subtaskId, ...(itemPatch ? { itemPatch } : {}), ...(scheduleRequest ? { scheduleRequest: { expectedVersion: scheduleRequest.expectedVersion, schedule: { state: "range", start: { localCivil: scheduleRequest.start ?? START }, end: { localCivil: scheduleRequest.end } }, ...(scheduleRequest.reminderOffsetsMinutes ? { reminderOffsetsMinutes: scheduleRequest.reminderOffsetsMinutes } : {}) } } : {}) },
  });
}

/** A written reminder delivery as the scan writes it, for the suppression assertions. */
async function insertDelivery(subtaskId: string, occurrenceId: string, version: number, outboxStatus: string, ledgerStatuses: Array<[string, string]>, recipientId = otherId, inProject = projectId): Promise<string> {
  const outboxId = crypto.randomUUID(); const now = Date.now();
  const payload = JSON.stringify({ schemaVersion: 1, reminder: { occurrenceId, projectId: inProject, subtaskId, scheduleVersion: version } });
  await database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at" + (outboxStatus === "processing" ? ", lease_token, lease_expires_at" : "") + ") VALUES (?, 1, 'project.subtask.reminder', ?, ?, 'system', ?, ?, ?, ?, ?, ?" + (outboxStatus === "processing" ? ", 'lease', ?" : "") + ")")
    .bind(outboxId, `subtask-reminder:${subtaskId}:${occurrenceId}`, inProject, recipientId, payload, outboxStatus, now, now, now, ...(outboxStatus === "processing" ? [now + 600_000] : [])).run();
  for (const [channel, status] of ledgerStatuses) await database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, 'project.subtask.reminder', ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), outboxId, `subtask-reminder:${subtaskId}:${occurrenceId}`, recipientId, channel, status, now, now).run();
  return outboxId;
}
const outboxStatus = async (id: string) => (await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(id).first<{ status: string }>())!.status;
const ledgerStatuses = async (id: string) => (await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(id).all<{ channel: string; status: string }>()).results.map((row) => `${row.channel}:${row.status}`);

describe("Subtask reminder occurrences follow the Subtask (#424)", () => {
  it("creating a Subtask materialises the default set from its due, stamped with the creating user", async () => {
    const { id, version } = await create("Default set");
    const rows = await occurrencesOf(id);
    expect(shape(rows)).toEqual(["v1 advance1440 pending", "v1 due_now pending"]);
    expect(version).toBe(1);
    expect(rows[0]).toMatchObject({ fire_at: END_AT - DAY, due_at: END_AT, due_local_civil: END, created_by: editorId, fired_at: null });
    expect(rows[1]).toMatchObject({ fire_at: END_AT, due_at: END_AT });
    expect(await database.DB.prepare("SELECT reminder_offsets_json AS offsets FROM project_subtasks WHERE id = ?").bind(id).first()).toEqual({ offsets: "[1440]" });
  });

  it("stores only the fire times still ahead: inside the last day only Due now, and nothing once the due has passed", async () => {
    const soon = await create("Within a day", { now: END_AT - 2 * HOUR });
    expect(shape(await occurrencesOf(soon.id))).toEqual(["v1 due_now pending"]);
    const late = await create("Already due", { now: END_AT + HOUR });
    expect(await occurrencesOf(late.id)).toEqual([]);
  });

  it("changing the range supersedes the pending set as schedule_replaced and schedules the new version", async () => {
    const { id } = await create("Reschedule");
    const result = await update(id, { scheduleRequest: { expectedVersion: 1, end: "2099-06-14T17:00" } });
    expect(result.outcome).toBe("updated");
    const rows = await occurrencesOf(id);
    expect(shape(rows)).toEqual(["v1 advance1440 superseded:schedule_replaced", "v1 due_now superseded:schedule_replaced", "v2 advance1440 pending", "v2 due_now pending"]);
    const newEnd = Date.parse("2099-06-14T17:00:00+10:00");
    expect(rows.filter((row) => row.schedule_version === 2).map((row) => [row.kind, row.fire_at, row.due_at, row.due_local_civil])).toEqual([["advance", newEnd - DAY, newEnd, "2099-06-14T17:00"], ["due_now", newEnd, newEnd, "2099-06-14T17:00"]]);
  });

  it("moving the due into the past leaves no pending occurrence", async () => {
    const { id } = await create("Moved to the past");
    const result = await update(id, { scheduleRequest: { expectedVersion: 1, end: "2099-06-11T17:00" } }, Date.parse("2099-06-20T00:00:00Z"));
    expect(result.outcome).toBe("updated");
    expect((await occurrencesOf(id)).filter((row) => row.status === "pending")).toEqual([]);
  });

  it("completing supersedes pending occurrences and suppresses a written but unsent delivery, leaving in-flight and fired work alone", async () => {
    const { id } = await create("Complete me");
    const pending = await occurrencesOf(id);
    const advance = pending.find((row) => row.kind === "advance")!;
    // The advance one already fired and wrote deliveries: one still waiting (suppressed), one leased (left to the delivery re-check).
    await database.DB.prepare("UPDATE project_subtask_reminder_occurrences SET status = 'fired', fired_at = ? WHERE id = ?").bind(advance.fire_at, advance.id).run();
    const waiting = await insertDelivery(id, advance.id, 1, "queued", [["in_app", "pending"], ["email", "pending"]]);
    const leased = await insertDelivery(id, advance.id, 1, "processing", [["in_app", "processing"]], editorId);
    const result = await update(id, { itemPatch: { done: true } });
    expect(result.outcome).toBe("updated");
    expect(shape(await occurrencesOf(id))).toEqual(["v1 advance1440 fired", "v1 due_now superseded:subtask_completed"]);
    expect(await outboxStatus(waiting)).toBe("suppressed");
    expect(await ledgerStatuses(waiting)).toEqual(["email:suppressed", "in_app:suppressed"]);
    expect(await outboxStatus(leased)).toBe("processing");
    expect(await ledgerStatuses(leased)).toEqual(["in_app:processing"]);
  });

  it("un-completing recomputes only the future unfired occurrences: a fired one of the same version is not repeated", async () => {
    const { id } = await create("Complete then undo");
    const advance = (await occurrencesOf(id)).find((row) => row.kind === "advance")!;
    await database.DB.prepare("UPDATE project_subtask_reminder_occurrences SET status = 'fired', fired_at = ? WHERE id = ?").bind(advance.fire_at, advance.id).run();
    expect((await update(id, { itemPatch: { done: true } })).outcome).toBe("updated");
    expect((await update(id, { itemPatch: { done: false } }, advance.fire_at + HOUR)).outcome).toBe("updated");
    expect(shape(await occurrencesOf(id))).toEqual(["v1 advance1440 fired", "v1 due_now superseded:subtask_completed", "v1 due_now pending"]);
    // Completing and un-completing again does not stack a second live row.
    expect((await update(id, { itemPatch: { done: true } })).outcome).toBe("updated");
    expect((await update(id, { itemPatch: { done: false } }, advance.fire_at + HOUR)).outcome).toBe("updated");
    expect((await occurrencesOf(id)).filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("un-completing after the due has passed writes nothing", async () => {
    const { id } = await create("Undo too late");
    expect((await update(id, { itemPatch: { done: true } })).outcome).toBe("updated");
    expect((await update(id, { itemPatch: { done: false } }, END_AT + DAY)).outcome).toBe("updated");
    expect((await occurrencesOf(id)).filter((row) => row.status === "pending")).toEqual([]);
  });

  it("a combined completion and reschedule leaves nothing pending, and a combined un-completion and reschedule schedules the new version", async () => {
    const { id } = await create("Combined");
    expect((await update(id, { itemPatch: { done: true }, scheduleRequest: { expectedVersion: 1, end: "2099-06-15T17:00" } })).outcome).toBe("updated");
    expect((await occurrencesOf(id)).filter((row) => row.status === "pending")).toEqual([]);
    expect((await update(id, { itemPatch: { done: false }, scheduleRequest: { expectedVersion: 2, end: "2099-06-16T17:00" } })).outcome).toBe("updated");
    expect(shape((await occurrencesOf(id)).filter((row) => row.status === "pending"))).toEqual(["v3 advance1440 pending", "v3 due_now pending"]);
  });

  it("assignee-only and title-only edits leave every occurrence exactly as it was", async () => {
    const { id } = await create("Untouched");
    const before = await occurrencesOf(id);
    const subtask = await database.DB.prepare("SELECT assignment_version AS v FROM project_subtasks WHERE id = ?").bind(id).first<{ v: number }>();
    expect((await update(id, { itemPatch: { assignees: { expectedVersion: subtask!.v, add: [otherId], remove: [] } } })).outcome).toBe("updated");
    expect((await update(id, { itemPatch: { title: "Renamed" } })).outcome).toBe("updated");
    expect(await occurrencesOf(id)).toEqual(before);
  });

  it("a save that loses the compare-and-swap writes no occurrence", async () => {
    const { id } = await create("Lost race");
    const before = await occurrencesOf(id);
    let injected = false;
    const racing = new Proxy(baseEnv.DB, {
      get(target, property, receiver) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!injected) { injected = true; await database.DB.prepare("UPDATE project_subtasks SET title = 'Someone else' WHERE id = ?").bind(id).run(); } return target.batch(statements); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as D1Database;
    const lost = await update(id, { scheduleRequest: { expectedVersion: 1, end: "2099-06-20T17:00" } }, NOW, racing);
    expect(lost.outcome).not.toBe("updated");
    expect(await occurrencesOf(id)).toEqual(before);
    const done = await update(id, { itemPatch: { done: true } }, NOW, new Proxy(baseEnv.DB, {
      get(target, property, receiver) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => { await database.DB.prepare("UPDATE project_subtasks SET title = 'Again' WHERE id = ?").bind(id).run(); return target.batch(statements); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as D1Database);
    expect(done.outcome).not.toBe("updated");
    expect(await occurrencesOf(id)).toEqual(before);
  });

  it("archiving the Project supersedes pending occurrences and suppresses unsent deliveries, and restoring recomputes only the future ones", async () => {
    const project = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Archive Street', 'editing_autohdr', ?, ?)").bind(project, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), project, editorId, now).run();
    // Far-future due (2099) so the real clock the restore route reads still sees both fire times ahead.
    const created = await saveProjectSubtask({ env: baseEnv, projectId: project, principal, now: NOW, operation: { kind: "create", item: { title: "Archive me", assigneeIds: [] }, schedule: { state: "range", start: { localCivil: START }, end: { localCivil: END } } } });
    if (created.outcome !== "created") throw new Error("fixture");
    const id = created.item.id;
    const advance = (await occurrencesOf(id)).find((row) => row.kind === "advance")!;
    await database.DB.prepare("UPDATE project_subtask_reminder_occurrences SET status = 'fired', fired_at = ? WHERE id = ?").bind(advance.fire_at, advance.id).run();
    const waiting = await insertDelivery(id, advance.id, 1, "pending", [["in_app", "pending"], ["email", "pending"]], otherId, project);
    expect((await request(`/api/projects/${project}/archive`, "reminders-admin-token", "POST", {})).status).toBe(200);
    expect(shape(await occurrencesOf(id))).toEqual(["v1 advance1440 fired", "v1 due_now superseded:project_archived"]);
    expect(await outboxStatus(waiting)).toBe("suppressed");
    expect(await ledgerStatuses(waiting)).toEqual(["email:suppressed", "in_app:suppressed"]);
    // While archived nothing is materialised for it.
    expect((await update(id, { itemPatch: { title: "Edited while archived" } })).outcome).toBeDefined();
    expect((await request(`/api/projects/${project}/restore`, "reminders-admin-token", "POST", {})).status).toBe(200);
    expect(shape(await occurrencesOf(id))).toEqual(["v1 advance1440 fired", "v1 due_now superseded:project_archived", "v1 due_now pending"]);
  });

  it("deleting a Subtask removes its occurrences and suppresses a written but unsent delivery", async () => {
    const { id } = await create("Delete me");
    const advance = (await occurrencesOf(id)).find((row) => row.kind === "advance")!;
    const waiting = await insertDelivery(id, advance.id, 1, "queued", [["in_app", "pending"]]);
    const leased = await insertDelivery(id, advance.id, 1, "processing", [["in_app", "processing"]], editorId);
    expect((await request(`/api/projects/${projectId}/subtasks/${id}`, "reminders-admin-token", "DELETE")).status).toBe(200);
    expect(await occurrencesOf(id)).toEqual([]);
    expect(await outboxStatus(waiting)).toBe("suppressed");
    expect(await ledgerStatuses(waiting)).toEqual(["in_app:suppressed"]);
    expect(await outboxStatus(leased)).toBe("processing");
  });
});

describe("Editing a Subtask's reminders reschedules its pending occurrences (#425)", () => {
  const pending = async (id: string) => shape((await occurrencesOf(id)).filter((row) => row.status === "pending"));
  const edit = (id: string, expectedVersion: number, offsets: number[], now = NOW, end = END) => update(id, { scheduleRequest: { expectedVersion, end, reminderOffsetsMinutes: offsets } }, now);

  it("adding an offset supersedes the old version as reminders_changed and fires the new set at the new version", async () => {
    const { id } = await create("Add an offset");
    expect((await edit(id, 1, [1440, 60])).outcome).toBe("updated");
    const rows = await occurrencesOf(id);
    expect(shape(rows)).toEqual(["v1 advance1440 superseded:reminders_changed", "v1 due_now superseded:reminders_changed", "v2 advance1440 pending", "v2 advance60 pending", "v2 due_now pending"]);
    expect(rows.filter((row) => row.schedule_version === 2).map((row) => row.fire_at)).toEqual([END_AT - DAY, END_AT - HOUR, END_AT]);
  });

  it("a removed offset ends superseded and never fires: Due now is always kept", async () => {
    const { id } = await create("Remove an offset", { offsets: [1440, 60] });
    expect((await edit(id, 1, [])).outcome).toBe("updated");
    expect(await pending(id)).toEqual(["v2 due_now pending"]);
    expect((await occurrencesOf(id)).filter((row) => row.schedule_version === 1).every((row) => row.status === "superseded" && row.terminal_reason === "reminders_changed")).toBe(true);
  });

  it("an offset that already fired does not fire again at the new version, and its unsent delivery is suppressed", async () => {
    const { id } = await create("Fired already");
    const advance = (await occurrencesOf(id)).find((row) => row.kind === "advance")!;
    await database.DB.prepare("UPDATE project_subtask_reminder_occurrences SET status = 'fired', fired_at = ? WHERE id = ?").bind(advance.fire_at, advance.id).run();
    const waiting = await insertDelivery(id, advance.id, 1, "queued", [["in_app", "pending"], ["email", "pending"]]);
    const leased = await insertDelivery(id, advance.id, 1, "processing", [["in_app", "processing"]], editorId);
    expect((await edit(id, 1, [1440, 60], advance.fire_at + HOUR)).outcome).toBe("updated");
    // The fired 1-day row stays as history; the new version carries only what is still ahead.
    expect(shape(await occurrencesOf(id))).toEqual(["v1 advance1440 fired", "v1 due_now superseded:reminders_changed", "v2 advance60 pending", "v2 due_now pending"]);
    // Matches the Deadline: a fired but undelivered old-version reminder is dropped, an in-flight one is left to the delivery re-check.
    expect(await outboxStatus(waiting)).toBe("suppressed");
    expect(await ledgerStatuses(waiting)).toEqual(["email:suppressed", "in_app:suppressed"]);
    expect(await outboxStatus(leased)).toBe("processing");
  });

  it("a pending occurrence the scan has not claimed yet is lost when the edit lands after its fire time (as for the Deadline)", async () => {
    const { id } = await create("Overdue pending");
    expect((await edit(id, 1, [1440, 60], END_AT - DAY + HOUR)).outcome).toBe("updated");
    expect(shape(await occurrencesOf(id))).toEqual(["v1 advance1440 superseded:reminders_changed", "v1 due_now superseded:reminders_changed", "v2 advance60 pending", "v2 due_now pending"]);
  });

  it("a range change together with the reminders is one schedule_replaced bump to a single new version", async () => {
    const { id } = await create("Both at once");
    expect((await edit(id, 1, [60], NOW, "2099-06-14T17:00")).outcome).toBe("updated");
    const rows = await occurrencesOf(id);
    expect(shape(rows)).toEqual(["v1 advance1440 superseded:schedule_replaced", "v1 due_now superseded:schedule_replaced", "v2 advance60 pending", "v2 due_now pending"]);
    expect(rows.find((row) => row.schedule_version === 2 && row.kind === "advance")!.fire_at).toBe(Date.parse("2099-06-14T17:00:00+10:00") - HOUR);
  });

  it("the same offsets, or none sent, leave every occurrence exactly as it was", async () => {
    const { id } = await create("Unchanged", { offsets: [1440, 60] });
    const before = await occurrencesOf(id);
    expect((await edit(id, 1, [60, 1440])).outcome).toBe("noop");
    expect((await update(id, { scheduleRequest: { expectedVersion: 1, end: END } })).outcome).toBe("noop");
    expect(await occurrencesOf(id)).toEqual(before);
  });

  it("a reminders edit on a done Subtask schedules nothing, and un-completing uses the new set", async () => {
    const { id } = await create("Done then edited");
    expect((await update(id, { itemPatch: { done: true } })).outcome).toBe("updated");
    expect((await edit(id, 1, [60])).outcome).toBe("updated");
    expect(await pending(id)).toEqual([]);
    expect((await update(id, { itemPatch: { done: false } })).outcome).toBe("updated");
    expect(await pending(id)).toEqual(["v2 advance60 pending", "v2 due_now pending"]);
  });

  it("completing and editing the reminders in one save leaves nothing pending", async () => {
    const { id } = await create("Complete and edit");
    expect((await update(id, { itemPatch: { done: true }, scheduleRequest: { expectedVersion: 1, end: END, reminderOffsetsMinutes: [60] } })).outcome).toBe("updated");
    expect(await pending(id)).toEqual([]);
  });

  it("a reminders edit that loses the compare-and-swap writes no occurrence and leaves the stored set alone", async () => {
    const { id } = await create("Lost reminders race");
    const before = await occurrencesOf(id);
    const racing = new Proxy(baseEnv.DB, {
      get(target, property, receiver) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => { await database.DB.prepare("UPDATE project_subtasks SET title = 'Someone else' WHERE id = ?").bind(id).run(); return target.batch(statements); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as D1Database;
    const lost = await update(id, { scheduleRequest: { expectedVersion: 1, end: END, reminderOffsetsMinutes: [60] } }, NOW, racing);
    expect(lost.outcome).not.toBe("updated");
    expect(await occurrencesOf(id)).toEqual(before);
    expect(await database.DB.prepare("SELECT reminder_offsets_json AS offsets, schedule_version AS v FROM project_subtasks WHERE id = ?").bind(id).first()).toEqual({ offsets: "[1440]", v: 1 });
  });

  it("an assignee-only or title-only edit after a reminders edit touches nothing", async () => {
    const { id } = await create("Stable after edit");
    expect((await edit(id, 1, [60])).outcome).toBe("updated");
    const before = await occurrencesOf(id);
    expect((await update(id, { itemPatch: { title: "Renamed after" } })).outcome).toBe("updated");
    expect(await occurrencesOf(id)).toEqual(before);
  });
});
