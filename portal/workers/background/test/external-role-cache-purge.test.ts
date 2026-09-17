import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { EXTERNAL_PROVISIONING_FROZEN_FLAG, processExternalRoleCachePurges } from "../src/external-role-cache-purge";

const database = env as unknown as { DB: D1Database };
// No zone credentials: every purge attempt fails without touching the network.
const purgeEnv = { ...(env as unknown as Env), CLOUDFLARE_ZONE_ID: undefined, CLOUDFLARE_CACHE_PURGE_TOKEN: undefined } as Env;
const adminId = "b1611111-1111-4111-8111-111111111111";
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

async function queueExhaustedPurge(now: number): Promise<string> {
  const id = crypto.randomUUID();
  const payload = { userId: "u", roleChangeAuditId: "a", authorizationEpoch: 1, attempts: 4, deadlineAt: now + 60_000 };
  await database.DB.prepare("INSERT INTO jobs (id, kind, status, retries, payload_json, created_at, updated_at) VALUES (?, 'external_role_conversion_cache_purge', 'queued', 4, ?, ?, ?)")
    .bind(id, JSON.stringify(payload), now, now).run();
  return id;
}

function flagRow() {
  return database.DB.prepare("SELECT enabled, updated_by AS updatedBy, updated_at AS updatedAt FROM feature_flags WHERE key = ?")
    .bind(EXTERNAL_PROVISIONING_FROZEN_FLAG).first<{ enabled: number; updatedBy: string | null; updatedAt: number }>();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB161 Admin', 'tb161-admin@example.test', 1, 'admin', 1, ?, ?)")
    .bind(adminId, now, now).run();
});

beforeEach(async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(EXTERNAL_PROVISIONING_FROZEN_FLAG),
    database.DB.prepare("DELETE FROM jobs WHERE kind = 'external_role_conversion_cache_purge'"),
  ]);
});

describe("external role cache purge freeze (#161)", () => {
  it("freezes provisioning with no actor when the bounded purge exhausts", async () => {
    const now = Date.now();
    const jobId = await queueExhaustedPurge(now);
    expect(await processExternalRoleCachePurges(purgeEnv, now)).toBe(1);
    expect(await flagRow()).toEqual({ enabled: 1, updatedBy: null, updatedAt: now });
    const audit = await database.DB.prepare("SELECT actor_id AS actorId, meta_json AS meta FROM audit_log WHERE action = 'external.provisioning.frozen' AND meta_json LIKE ?")
      .bind(`%${jobId}%`).first<{ actorId: string | null; meta: string }>();
    expect(audit?.actorId).toBeNull();
    expect(JSON.parse(audit!.meta)).toEqual({ attempts: 5, deadlineAt: now + 60_000, jobId });
  });

  it("clears the releasing admin from the row when a later exhaustion re-freezes it", async () => {
    const releasedAt = Date.now() - 60_000;
    await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, 0, ?, ?)")
      .bind(EXTERNAL_PROVISIONING_FROZEN_FLAG, adminId, releasedAt).run();
    const now = Date.now();
    await queueExhaustedPurge(now);
    await processExternalRoleCachePurges(purgeEnv, now);
    expect(await flagRow()).toEqual({ enabled: 1, updatedBy: null, updatedAt: now });
  });
});
