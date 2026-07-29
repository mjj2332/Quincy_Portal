import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { notifyProject, processStalledAutoHdrCandidate, scanStalledAutoHdr } from "../src/notifications";
import { emitNotifications } from "@quincy/db";
import { dbFor } from "../src/lib/db";

const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));

async function withActiveAdminsSuppressed<T>(action: () => Promise<T>): Promise<T> {
  const admins = await database.DB.prepare("SELECT id FROM user WHERE role = 'admin' AND active = 1").all<{ id: string }>();
  try {
    if (admins.results.length) {
      await database.DB.prepare(`UPDATE user SET active = 0 WHERE id IN (${admins.results.map(() => "?").join(", ")})`)
        .bind(...admins.results.map((admin) => admin.id)).run();
    }
    return await action();
  } finally {
    if (admins.results.length) {
      await database.DB.prepare(`UPDATE user SET active = 1 WHERE id IN (${admins.results.map(() => "?").join(", ")})`)
        .bind(...admins.results.map((admin) => admin.id)).run();
    }
  }
}

async function seedStalledHandoff(now: number, options: { withMember?: boolean } = {}) {
  const projectId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const handoffId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Guard Fixture Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, ?, ?)").bind(jobId, projectId, now, now),
    database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'guard-fixture', '[]', '[]', '/raw', 'started', ?, ?, ?, ?, ?, ?)").bind(handoffId, projectId, connectionId, `workflow-${handoffId}`, jobId, now + 86_400_000, now - 4 * 60 * 60 * 1000, now, now),
    database.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'pending_discovery', ?, ?)").bind(crypto.randomUUID(), projectId, handoffId, connectionId, now, now),
  ]);
  if (options.withMember !== false) {
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Guard recipient', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now),
    ]);
  }
  return { projectId, userId, handoffId };
}

function notificationEnv(send: ReturnType<typeof vi.fn>): Env {
  return { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
}

describe("notification fanout and stalled scan", () => {
  it("deduplicates a user with two project-member roles and records email success", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Both roles', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Both Roles Street', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?), (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now, crypto.randomUUID(), projectId, userId, now),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "message-1" });
    await notifyProject({ DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env, projectId, "raw_ready");
    const row = await database.DB.prepare("SELECT user_id, email_sent_at, email_message_id FROM notifications WHERE project_id = ? AND type = 'raw_ready'").bind(projectId).all();
    expect(row.results).toHaveLength(1);
    expect(row.results[0]).toMatchObject({ user_id: userId, email_message_id: "message-1" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("finds stalled handoffs and makes a second scan a true no-op", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const handoffId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const activeAdmin = crypto.randomUUID();
    const inactiveAdmin = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Stalled editor', ?, 1, 'editor', 1, ?, ?), (?, 'Active admin', ?, 1, 'admin', 1, ?, ?), (?, 'Inactive admin', ?, 1, 'admin', 0, ?, ?)").bind(userId, `${userId}@example.test`, now, now, activeAdmin, `${activeAdmin}@example.test`, now, now, inactiveAdmin, `${inactiveAdmin}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Stalled Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now),
      database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, ?, ?)").bind(jobId, projectId, now, now),
      database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'test', '[]', '[]', '/raw', 'started', ?, ?, ?, ?, ?, ?)").bind(handoffId, projectId, connectionId, `workflow-${handoffId}`, jobId, now + 86_400_000, now - 4 * 60 * 60 * 1000, now, now),
      database.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'pending_discovery', ?, ?)").bind(crypto.randomUUID(), projectId, handoffId, connectionId, now, now),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "test-message" });
    const localEnv = { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    expect(await scanStalledAutoHdr(localEnv, now)).toBe(2);
    expect(await scanStalledAutoHdr(localEnv, now + 60 * 60 * 1000)).toBe(0);
    const rows = await database.DB.prepare("SELECT user_id FROM notifications WHERE source_key = ?").bind(handoffId).all<{ user_id: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map((row) => row.user_id)).toContain(activeAdmin);
    expect(rows.results.map((row) => row.user_id)).not.toContain(inactiveAdmin);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips both the duplicate row and the duplicate email on a repeated sourceKey", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const sourceKey = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'SourceKey editor', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Source Key Street', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now),
    ]);
    const db = dbFor({ DB: database.DB } as unknown as Env);
    const recipients = [{ userId, email: `${userId}@example.test`, name: "SourceKey editor" }];

    const firstSend = vi.fn().mockResolvedValue({ messageId: "message-1" });
    const firstCount = await emitNotifications(db, {
      projectId, type: "autohdr_stalled", recipients, sourceKey,
      email: { send: firstSend }, fromAddress: "studio@example.test",
    });
    expect(firstCount).toBe(1);
    expect(firstSend).toHaveBeenCalledTimes(1);

    const secondSend = vi.fn().mockResolvedValue({ messageId: "message-2" });
    const secondCount = await emitNotifications(db, {
      projectId, type: "autohdr_stalled", recipients, sourceKey,
      email: { send: secondSend }, fromAddress: "studio@example.test",
    });
    expect(secondCount).toBe(0);
    expect(secondSend).not.toHaveBeenCalled();

    const rows = await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(sourceKey).all();
    expect(rows.results).toHaveLength(1);
  });

  it("does not re-notify a stalled handoff after its emitted notification is deleted", async () => {
    await withActiveAdminsSuppressed(async () => {
      const now = Date.now();
      const fixture = await seedStalledHandoff(now);
      const send = vi.fn().mockResolvedValue({ messageId: "dismiss-guard" });
      const localEnv = notificationEnv(send);

      expect(await scanStalledAutoHdr(localEnv, now)).toBe(1);
      const notification = await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(fixture.handoffId).first<{ id: string }>();
      expect(notification).toBeDefined();
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(fixture.handoffId).first()).toEqual({ stalled_notified_at: now });
      await database.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(notification!.id).run();
      expect(await database.DB.prepare("SELECT id FROM notifications WHERE id = ?").bind(notification!.id).first()).toBeNull();

      expect(await scanStalledAutoHdr(localEnv, now + 60 * 60 * 1000)).toBe(0);
      expect(await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(fixture.handoffId).all()).toMatchObject({ results: [] });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(fixture.handoffId).first()).toEqual({ stalled_notified_at: now });
    });
  });

  it("rejects a stale concurrent candidate even when its first notification was deleted", async () => {
    await withActiveAdminsSuppressed(async () => {
      const now = Date.now();
      const fixture = await seedStalledHandoff(now);
      const send = vi.fn().mockResolvedValue({ messageId: "concurrent-guard" });
      const localEnv = notificationEnv(send);
      const candidate = { handoffId: fixture.handoffId, projectId: fixture.projectId };
      const cutoff = now - 3 * 60 * 60 * 1000;

      const first = await processStalledAutoHdrCandidate(localEnv, candidate, now, cutoff);
      expect(first).toEqual({ claimed: true, emitted: 1 });
      const notification = await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(fixture.handoffId).first<{ id: string }>();
      await database.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(notification!.id).run();
      const second = await processStalledAutoHdrCandidate(localEnv, candidate, now, cutoff);

      expect(second).toEqual({ claimed: false, emitted: 0 });
      expect(await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(fixture.handoffId).all()).toMatchObject({ results: [] });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("takes a terminal recipient snapshot when a stalled handoff has no active recipients", async () => {
    await withActiveAdminsSuppressed(async () => {
      const now = Date.now();
      const fixture = await seedStalledHandoff(now, { withMember: false });
      const send = vi.fn().mockResolvedValue({ messageId: "snapshot" });
      const localEnv = notificationEnv(send);
      expect(await scanStalledAutoHdr(localEnv, now)).toBe(0);
      await database.DB.batch([
        database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Late member', ?, 1, 'editor', 1, ?, ?)").bind(fixture.userId, `${fixture.userId}@example.test`, now, now),
        database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, fixture.userId, now),
      ]);
      expect(await scanStalledAutoHdr(localEnv, now + 60 * 60 * 1000)).toBe(0);
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(fixture.handoffId).first()).toEqual({ stalled_notified_at: now });
      expect(await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(fixture.handoffId).all()).toMatchObject({ results: [] });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("closes claim-time TOCTOU gaps for archived projects and changed handoff state", async () => {
    await withActiveAdminsSuppressed(async () => {
      const now = Date.now();
      const send = vi.fn().mockResolvedValue({ messageId: "toctou" });
      const localEnv = notificationEnv(send);
      const archived = await seedStalledHandoff(now);
      await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(now, archived.projectId).run();
      expect(await processStalledAutoHdrCandidate(localEnv, { handoffId: archived.handoffId, projectId: archived.projectId }, now, now - 3 * 60 * 60 * 1000)).toEqual({ claimed: false, emitted: 0 });
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(archived.handoffId).first()).toEqual({ stalled_notified_at: null });

      const changed = await seedStalledHandoff(now + 1);
      await database.DB.prepare("UPDATE autohdr_handoffs SET state = 'failed' WHERE id = ?").bind(changed.handoffId).run();
      expect(await processStalledAutoHdrCandidate(localEnv, { handoffId: changed.handoffId, projectId: changed.projectId }, now + 1, now - 3 * 60 * 60 * 1000)).toEqual({ claimed: false, emitted: 0 });
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(changed.handoffId).first()).toEqual({ stalled_notified_at: null });
      expect(await database.DB.prepare("SELECT id FROM notifications WHERE source_key IN (?, ?)").bind(archived.handoffId, changed.handoffId).all()).toMatchObject({ results: [] });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("rolls back a genuine emission failure, continues later candidates, and retries later", async () => {
    await withActiveAdminsSuppressed(async () => {
      const now = Date.now();
      const failed = await seedStalledHandoff(now);
      const later = await seedStalledHandoff(now + 1);
      const send = vi.fn().mockResolvedValue({ messageId: "retry" });
      const localEnv = notificationEnv(send);
      await database.DB.exec(`CREATE TRIGGER fail_stalled_notification BEFORE INSERT ON notifications WHEN NEW.source_key = '${failed.handoffId}' BEGIN SELECT RAISE(ABORT, 'forced notification insert failure'); END`);
      expect(await scanStalledAutoHdr(localEnv, now + 2)).toBe(1);
      await database.DB.exec("DROP TRIGGER fail_stalled_notification");
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(failed.handoffId).first()).toEqual({ stalled_notified_at: null });
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(later.handoffId).first()).toEqual({ stalled_notified_at: now + 2 });
      expect(send).toHaveBeenCalledTimes(1);

      expect(await scanStalledAutoHdr(localEnv, now + 3)).toBe(1);
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(failed.handoffId).first()).toEqual({ stalled_notified_at: now + 3 });
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps a successful claim when only email delivery fails", async () => {
    await withActiveAdminsSuppressed(async () => {
      const now = Date.now();
      const fixture = await seedStalledHandoff(now);
      const send = vi.fn().mockRejectedValue(new Error("mail unavailable"));
      expect(await scanStalledAutoHdr(notificationEnv(send), now)).toBe(1);
      expect(await database.DB.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = ?").bind(fixture.handoffId).first()).toEqual({ stalled_notified_at: now });
      expect(await database.DB.prepare("SELECT email_error FROM notifications WHERE source_key = ?").bind(fixture.handoffId).first()).toEqual({ email_error: "mail unavailable" });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
