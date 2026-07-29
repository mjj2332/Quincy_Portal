import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { notifyProject, scanStalledAutoHdr } from "../src/notifications";
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
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Stalled editor', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Stalled Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now),
      database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, ?, ?)").bind(jobId, projectId, now, now),
      database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'test', '[]', '[]', '/raw', 'started', ?, ?, ?, ?, ?, ?)").bind(handoffId, projectId, connectionId, `workflow-${handoffId}`, jobId, now + 86_400_000, now - 4 * 60 * 60 * 1000, now, now),
      database.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'pending_discovery', ?, ?)").bind(crypto.randomUUID(), projectId, handoffId, connectionId, now, now),
    ]);
    const localEnv = { DB: database.DB } as unknown as Env;
    expect(await scanStalledAutoHdr(localEnv, now)).toBe(1);
    expect(await scanStalledAutoHdr(localEnv, now + 60 * 60 * 1000)).toBe(0);
    const rows = await database.DB.prepare("SELECT id FROM notifications WHERE source_key = ?").bind(handoffId).all();
    expect(rows.results).toHaveLength(1);
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
});
