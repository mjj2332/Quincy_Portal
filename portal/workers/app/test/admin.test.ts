import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
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

async function cookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie: await cookie(token), origin: baseEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

type FixtureOptions = {
  outboxStatus?: "pending" | "queued" | "completed" | "processing" | "dlq" | "discarded";
  inAppStatus?: "pending" | "processing" | "sent" | "failed" | "discarded";
  emailStatus?: "pending" | "processing" | "sent" | "failed" | "unknown" | "discarded";
  leaseAgeMs?: number;
  updatedAt?: number;
  errorCode?: string;
  errorMessage?: string;
};

async function seedFixture(options: FixtureOptions = {}) {
  const now = Date.now();
  const outboxId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const sourceKey = crypto.randomUUID();
  const outboxStatus = options.outboxStatus ?? "pending";
  const updatedAt = options.updatedAt ?? now;
  const leaseExpiresAt = outboxStatus === "processing" ? now + (options.leaseAgeMs ?? 60_000) : null;
  const payload = JSON.stringify({ body: "SECRET COMMENT CONTENT", recipientEmail: "secret@example.test", providerQueueMessageId: "secret-queue-id" });
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB4 Admin Recipient', ?, 1, 'editor', 1, ?, ?)").bind(recipientId, `secret-${recipientId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'TB4 Admin Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, queue_published_at, lease_token, lease_expires_at, publish_attempts, delivery_attempts, last_error_code, last_error, created_at, updated_at) VALUES (?, 1, 'project.comment.mentioned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)").bind(outboxId, sourceKey, projectId, recipientId, recipientId, payload, outboxStatus, now - 1_000, outboxStatus === "queued" ? now - 31 * 60_000 : null, outboxStatus === "processing" ? "tb4-live-lease" : null, leaseExpiresAt, options.emailStatus === "processing" || options.inAppStatus === "processing" ? 1 : 0, options.errorCode ?? null, options.errorMessage ?? null, now, updatedAt),
    database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, last_error_code, last_error, created_at, updated_at) VALUES (?, ?, 'project.comment.mentioned', ?, ?, 'in_app', ?, ?, ?, ?, ?, ?), (?, ?, 'project.comment.mentioned', ?, ?, 'email', ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), outboxId, sourceKey, recipientId, options.inAppStatus ?? "pending", options.inAppStatus === "processing" ? 1 : 0, options.inAppStatus === "failed" ? options.errorCode ?? "raw-provider-code" : null, options.inAppStatus === "failed" ? options.errorMessage ?? "RAW PROVIDER ERROR" : null, now, updatedAt, crypto.randomUUID(), outboxId, sourceKey, recipientId, options.emailStatus ?? "pending", options.emailStatus === "processing" || options.emailStatus === "sent" || options.emailStatus === "unknown" ? 1 : 0, options.emailStatus === "failed" ? options.errorCode ?? "raw-provider-code" : options.emailStatus === "unknown" ? "email_acceptance_unknown" : null, options.emailStatus === "failed" ? options.errorMessage ?? "RAW PROVIDER ERROR" : options.emailStatus === "unknown" ? "Email outcome requires duplicate acknowledgement." : null, now, updatedAt),
  ]);
  return { outboxId, projectId, recipientId, sourceKey, now };
}

describe("TB4 Admin delivery operations", () => {
  const adminToken = `tb4-admin-${crypto.randomUUID()}`;
  const editorToken = `tb4-editor-${crypto.randomUUID()}`;
  const adminId = crypto.randomUUID();
  const editorId = crypto.randomUUID();

  beforeAll(async () => {
    await executeSql(__PORTAL_MIGRATION_SQL__);
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB4 Admin Operator', ?, 1, 'admin', 1, ?, ?), (?, 'TB4 Editor Operator', ?, 1, 'editor', 1, ?, ?)").bind(adminId, `${adminId}@example.test`, now, now, editorId, `${editorId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, adminToken, adminId, now, now, crypto.randomUUID(), now + 3_600_000, editorToken, editorId, now, now),
    ]);
  });

  it("requires adminBackend, paginates and filters all four views, and serializes no sensitive delivery data", async () => {
    const pendingA = await seedFixture({ outboxStatus: "pending", updatedAt: Date.now() - 2_000 });
    const pendingB = await seedFixture({ outboxStatus: "pending", updatedAt: Date.now() - 1_000 });
    const dlq = await seedFixture({ outboxStatus: "dlq" });
    const failed = await seedFixture({ outboxStatus: "completed", emailStatus: "failed", errorCode: "E_INVALID_TO", errorMessage: "RAW PROVIDER ERROR" });
    const unknown = await seedFixture({ outboxStatus: "completed", emailStatus: "unknown" });

    expect((await request("/api/admin/notification-deliveries?view=pending_stuck&limit=1", editorToken)).status).toBe(403);
    const pending = await request("/api/admin/notification-deliveries?view=pending_stuck&limit=1", adminToken);
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json() as { view: string; items: Array<{ outboxId: string }>; nextCursor: string | null; counts: Record<string, number> };
    expect(pendingBody.view).toBe("pending_stuck");
    expect(pendingBody.items).toHaveLength(1);
    expect([pendingA.outboxId, pendingB.outboxId]).toContain(pendingBody.items[0]?.outboxId);
    expect(pendingBody.nextCursor).toEqual(expect.any(String));
    expect(pendingBody.counts.pending_stuck).toBeGreaterThanOrEqual(2);

    for (const [view, expected] of [["dlq", dlq], ["failed", failed], ["unknown", unknown]] as const) {
      const response = await request(`/api/admin/notification-deliveries?view=${view}&limit=10`, adminToken);
      expect(response.status).toBe(200);
      const body = await response.json() as { view: string; items: Array<{ outboxId: string; safeErrorCode: string | null; recipientName: string | null }> };
      expect(body.view).toBe(view);
      expect(body.items.map((item) => item.outboxId)).toContain(expected.outboxId);
      expect(JSON.stringify(body)).not.toContain("SECRET COMMENT CONTENT");
      expect(JSON.stringify(body)).not.toContain("secret@example.test");
      expect(JSON.stringify(body)).not.toContain("RAW PROVIDER ERROR");
      expect(JSON.stringify(body)).not.toContain("secret-queue-id");
      expect(body.items.every((item) => !item.safeErrorCode || item.safeErrorCode !== "raw-provider-code")).toBe(true);
    }
  });

  it("guards live discard, converts expired email processing to unknown, and preserves the duplicate warning", async () => {
    const fixture = await seedFixture({ outboxStatus: "processing", inAppStatus: "sent", emailStatus: "processing", leaseAgeMs: 60_000 });
    const live = await request(`/api/admin/notification-deliveries/${fixture.outboxId}/discard`, adminToken, "POST");
    expect(live.status).toBe(409);
    expect((await live.json() as { code: string }).code).toBe("delivery_active");

    await database.DB.prepare("UPDATE notification_outbox SET lease_expires_at = ?, updated_at = ? WHERE id = ?").bind(Date.now() - 1, Date.now(), fixture.outboxId).run();
    const expired = await request(`/api/admin/notification-deliveries/${fixture.outboxId}/discard`, adminToken, "POST");
    expect(expired.status).toBe(200);
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(fixture.outboxId).first()).toEqual({ status: "unknown" });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "discarded" });
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email' AND attempts > 0").bind(fixture.outboxId).first()).toEqual({ status: "unknown" });

    const replay = await request(`/api/admin/notification-deliveries/${fixture.outboxId}/replay`, adminToken, "POST", { channels: ["email"] });
    expect(replay.status).toBe(409);
    expect((await replay.json() as { code: string }).code).toBe("duplicate_email_possible");
  });

  it("lets exactly one concurrent operator replay win and requires an exact acknowledgement for unknown email", async () => {
    const failed = await seedFixture({ outboxStatus: "completed", inAppStatus: "failed", emailStatus: "sent", errorCode: "E_INVALID_TO", errorMessage: "invalid recipient" });
    const replayResponses = await Promise.all([
      request(`/api/admin/notification-deliveries/${failed.outboxId}/replay`, adminToken, "POST", { channels: ["in_app"] }),
      request(`/api/admin/notification-deliveries/${failed.outboxId}/replay`, adminToken, "POST", { channels: ["in_app"] }),
    ]);
    expect(replayResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.replay' AND target_id = ?").bind(failed.outboxId).first()).toEqual({ count: 1 });

    const unknown = await seedFixture({ outboxStatus: "completed", inAppStatus: "sent", emailStatus: "unknown" });
    const refused = await request(`/api/admin/notification-deliveries/${unknown.outboxId}/replay`, adminToken, "POST", { channels: ["email"] });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { code: string }).code).toBe("duplicate_email_possible");
    const acknowledged = await request(`/api/admin/notification-deliveries/${unknown.outboxId}/replay`, adminToken, "POST", { channels: ["email"], acknowledgeDuplicateEmail: true });
    expect(acknowledged.status).toBe(200);
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(unknown.outboxId).first()).toEqual({ status: "pending" });
  });

  it("lets exactly one concurrent operator discard win", async () => {
    const fixture = await seedFixture({ outboxStatus: "processing", inAppStatus: "pending", emailStatus: "pending", leaseAgeMs: -60_000 });
    const responses = await Promise.all([
      request(`/api/admin/notification-deliveries/${fixture.outboxId}/discard`, adminToken, "POST"),
      request(`/api/admin/notification-deliveries/${fixture.outboxId}/discard`, adminToken, "POST"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.discard' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "discarded" });
  });
});
