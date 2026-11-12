import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// The purge runs on the 30-minute tier: one attempt per tick, a 30-minute retry delay, a 3-hour deadline (docs/plans/cron-cadence-30m-hourly.md, F1).
const MINUTE = 60_000;
const withZone = { ...purgeEnv, CLOUDFLARE_ZONE_ID: "zone", CLOUDFLARE_CACHE_PURGE_TOKEN: "token" } as Env;

function jobRow(id: string) {
  return database.DB.prepare("SELECT status, retries, error, payload_json AS payload FROM jobs WHERE id = ?").bind(id)
    .first<{ status: string; retries: number; error: string | null; payload: string }>().then((row) => ({ ...row!, payload: JSON.parse(row!.payload) as Record<string, unknown> }));
}

async function queuePurge(now: number, payload: Record<string, unknown>, retries = 0): Promise<string> {
  const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO jobs (id, kind, status, retries, payload_json, created_at, updated_at) VALUES (?, 'external_role_conversion_cache_purge', 'queued', ?, ?, ?, ?)")
    .bind(id, retries, JSON.stringify({ userId: "u", roleChangeAuditId: "a", authorizationEpoch: 1, ...payload }), now, now).run();
  return id;
}

describe("external role cache purge on the 30-minute tier (F1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits 30 minutes between attempts under a 3-hour deadline, and freezes on the fifth failed attempt", async () => {
    const t0 = Date.now();
    const id = await queuePurge(t0, {});
    expect(await processExternalRoleCachePurges(purgeEnv, t0)).toBe(1);
    const first = await jobRow(id);
    expect(first).toMatchObject({ status: "queued", retries: 1 });
    expect(first.payload).toMatchObject({ attempts: 1, deadlineAt: t0 + 180 * MINUTE, nextAttemptAt: t0 + 30 * MINUTE });
    // Nothing is due before the 30-minute retry delay has passed.
    expect(await processExternalRoleCachePurges(purgeEnv, t0 + 29 * MINUTE)).toBe(0);
    for (const attempt of [2, 3, 4]) {
      expect(await processExternalRoleCachePurges(purgeEnv, t0 + (attempt - 1) * 30 * MINUTE)).toBe(1);
      expect(await jobRow(id)).toMatchObject({ status: "queued", retries: attempt });
    }
    expect(await flagRow()).toBeNull();
    // The fifth attempt lands at +2h, inside the 3-hour deadline, so the existing 5-attempt cap is what ends it.
    expect(await processExternalRoleCachePurges(purgeEnv, t0 + 120 * MINUTE)).toBe(1);
    expect(await jobRow(id)).toMatchObject({ status: "failed", retries: 5 });
    expect(await flagRow()).toMatchObject({ enabled: 1, updatedBy: null });
  });

  it("keeps an in-flight job's persisted 30-minute deadline, then freezes it as before", async () => {
    const t0 = Date.now();
    // Written by the old code: attempt 2 of 5, a 30-minute deadline already persisted, a 1-minute retry.
    const id = await queuePurge(t0, { attempts: 1, deadlineAt: t0 + 30 * MINUTE, nextAttemptAt: t0 + MINUTE }, 1);
    expect(await processExternalRoleCachePurges(purgeEnv, t0 + 2 * MINUTE)).toBe(1);
    const retried = await jobRow(id);
    expect(retried.status).toBe("queued");
    expect(retried.payload).toMatchObject({ attempts: 2, deadlineAt: t0 + 30 * MINUTE, nextAttemptAt: t0 + 32 * MINUTE });
    // The retry now comes 30 minutes on, past the legacy deadline: the next failure freezes at attempt 3 rather than running on to the cap.
    expect(await processExternalRoleCachePurges(purgeEnv, t0 + 32 * MINUTE)).toBe(1);
    expect(await jobRow(id)).toMatchObject({ status: "failed", retries: 3 });
    expect(await flagRow()).toMatchObject({ enabled: 1 });
    const audit = await database.DB.prepare("SELECT meta_json AS meta FROM audit_log WHERE action = 'external.provisioning.frozen' AND meta_json LIKE ?").bind(`%${id}%`).first<{ meta: string }>();
    expect(JSON.parse(audit!.meta)).toEqual({ attempts: 3, deadlineAt: t0 + 30 * MINUTE, jobId: id });
  });

  it("still completes an in-flight legacy job whose deadline has passed when the purge succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })));
    const t0 = Date.now();
    const id = await queuePurge(t0, { attempts: 2, deadlineAt: t0 + 30 * MINUTE, nextAttemptAt: t0 + MINUTE }, 2);
    expect(await processExternalRoleCachePurges(withZone, t0 + 90 * MINUTE)).toBe(1);
    expect(await jobRow(id)).toMatchObject({ status: "done", error: null });
    expect(await flagRow()).toBeNull();
  });
});
