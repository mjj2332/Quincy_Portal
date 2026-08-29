import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const appEnv = env as unknown as Env;
const adminId = crypto.randomUUID();
const adminToken = `kanban-admin-${crypto.randomUUID()}`;
const photographerId = crypto.randomUUID();
const photographerToken = `kanban-photographer-${crypto.randomUUID()}`;
const authSecret = appEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const flat = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of flat.split(";")) {
      const value = statement.replace(/\s+/g, " ").trim();
      if (value) await database.DB.exec(`${value};`);
    }
  }
}

async function cookie(token: string) {
  const context = await createAuth(appEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", await cookie(token));
  if (init.method && init.method !== "GET") headers.set("origin", appEnv.APP_ORIGIN);
  if (init.body) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { ...init, headers });
}

async function seedProject(id: string, stageKey: string, boardPosition: number, priority: number | null = null) {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
    .bind(id, id, stageKey, priority, boardPosition, now, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Kanban Admin', ?, 1, 'admin', 1, 0, ?, ?)")
      .bind(adminId, `${adminId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, adminToken, adminId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Kanban Photographer', ?, 1, 'photographer', 1, 0, ?, ?)")
      .bind(photographerId, `${photographerId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, photographerToken, photographerId, now, now),
  ]);
});

describe("Kanban priority and Board commands", () => {
  it("changes Priority metadata without changing position or Board revision", async () => {
    const first = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "raw_review", 1024, 1); await seedProject(target, "raw_review", 4096);
    const response = await request(`/api/projects/${target}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: 2 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ priority: 2, boardRevision: 0 });
    expect(await database.DB.prepare("SELECT priority, board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ priority: 2, board_position: 4096, board_revision: 0 });
  });

  it("moves a same-Stage card to the exact requested boundary", async () => {
    const first = crypto.randomUUID(); const middle = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "edited_review", 1024); await seedProject(middle, "edited_review", 2048); await seedProject(target, "edited_review", 3072);
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "edited_review", boardRevision: 0 },
      targetStageKey: "edited_review",
      placement: { kind: "between", before: null, after: { projectId: first, boardRevision: 0 } },
    }) });
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ projectId: target, boardRevision: 1 });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 0, board_revision: 1 });
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 1").bind(target).first()).toEqual({ action: "project.board_position_set" });
  });

  it("creates at the awaiting-RAW bottom while the Board mutation flag is off", async () => {
    const street = `Flag-off create ${crypto.randomUUID()}`;
    const before = await database.DB.prepare("SELECT COALESCE(MAX(board_position) + 1024, 0) AS position FROM projects WHERE stage_key = 'awaiting_raw' AND archived_at IS NULL").first<{ position: number }>();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const response = await request("/api/projects", adminToken, { method: "POST", body: JSON.stringify({ street, orderedServices: [] }) });
      expect(response.status).toBe(201);
      const created = await response.json() as { id: string };
      expect(await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(created.id).first()).toEqual({ stage_key: "awaiting_raw", board_position: before?.position ?? 0, board_revision: 0 });
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    }
  });

  it("appends a non-bottom card on a column-background drop", async () => {
    // This suite seeds with beforeAll (no per-test cleanup), so raw_review already holds rows from
    // earlier tests. Assert the relative outcome — target moves past every other visible card —
    // rather than an absolute board_position that depends on the column's prior contents.
    const stage = "raw_review";
    const target = crypto.randomUUID(); const middle = crypto.randomUUID(); const tail = crypto.randomUUID();
    const base = (await database.DB.prepare("SELECT COALESCE(MAX(board_position), 0) AS position FROM projects WHERE stage_key = ? AND archived_at IS NULL").bind(stage).first<{ position: number }>())?.position ?? 0;
    await seedProject(target, stage, base + 1024); await seedProject(middle, stage, base + 2048); await seedProject(tail, stage, base + 3072);
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: stage, boardRevision: 0 }, targetStageKey: stage, placement: { kind: "append" },
    }) });
    expect(response.status).toBe(200);
    const rows = (await database.DB.prepare("SELECT id, board_position, board_revision FROM projects WHERE id IN (?, ?, ?) ORDER BY board_position, id").bind(target, middle, tail).all<{ id: string; board_position: number; board_revision: number }>()).results;
    expect(rows.map((row) => row.id)).toEqual([middle, tail, target]);
    expect(rows.find((row) => row.id === target)).toMatchObject({ board_revision: 1 });
    expect(rows.find((row) => row.id === target)!.board_position).toBeGreaterThan(rows.find((row) => row.id === tail)!.board_position);
  });

  it("rejects a stale placement neighbour with a stage conflict", async () => {
    const target = crypto.randomUUID(); const neighbour = crypto.randomUUID();
    await seedProject(target, "edited_review", 0); await seedProject(neighbour, "edited_review", 1024);
    await database.DB.prepare("UPDATE projects SET board_revision = 1 WHERE id = ?").bind(neighbour).run();
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "edited_review", boardRevision: 0 }, targetStageKey: "edited_review",
      placement: { kind: "between", before: null, after: { projectId: neighbour, boardRevision: 0 } },
    }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "project_stage_conflict" });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 0, board_revision: 0 });
  });

  it("rejects the moving project as a between-neighbour during body parsing", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "edited_review", 1024);
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "edited_review", boardRevision: 0 },
      targetStageKey: "edited_review",
      placement: { kind: "between", before: null, after: { projectId: target, boardRevision: 0 } },
    }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid input" });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 1024, board_revision: 0 });
  });

  it("returns no_change for an unchanged logical slot without mutating", async () => {
    const first = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "delivered", 0); await seedProject(target, "delivered", 1024);
    const beforeAudit = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(target).first();
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "delivered", boardRevision: 0 }, targetStageKey: "delivered",
      placement: { kind: "between", before: { projectId: first, boardRevision: 0 }, after: null },
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: false });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 1024, board_revision: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(target).first()).toEqual(beforeAudit);
  });

  it("requires exact cumulative confirmation and publishes the human Stage activity", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "raw_review", 1024);
    const body = { expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: "delivered", placement: { kind: "append" } };
    const first = await request(`/api/projects/${target}/stage`, adminToken, { method: "POST", body: JSON.stringify(body) });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: "stage_confirmation_required", requiredConfirmation: { reasons: ["skipped_forward", "delivered_boundary"] } });
    const confirmed = await request(`/api/projects/${target}/stage`, adminToken, { method: "POST", body: JSON.stringify({ ...body, confirmation: { reasons: ["skipped_forward", "delivered_boundary"] } }) });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).project).toMatchObject({ projectId: target, stageKey: "delivered", boardRevision: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'stage.set'").bind(target).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.stage.changed'").bind(target).first()).toEqual({ count: 1 });
  });

  it("returns the Stage capability denial before either Board operational gate", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "raw_review", 1024);
    const body = JSON.stringify({
      expected: { stageKey: "raw_review", boardRevision: 0 },
      targetStageKey: "editing_autohdr",
      placement: { kind: "append" },
      confirmation: { reasons: ["editing_boundary"] },
    });
    try {
      for (const enabled of [false, true]) {
        await database.DB.prepare("UPDATE feature_flags SET enabled = ? WHERE key = 'tb5a_board_contract_enabled'").bind(enabled ? 1 : 0).run();
        const response = await request(`/api/projects/${target}/stage`, photographerToken, { method: "POST", body });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "moveProjectStage" });
      }
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    }
  });

  it("rejects the exact legacy body before mutation", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "raw_review", 1024);
    const response = await request(`/api/projects/${target}/stage/`, adminToken, { method: "POST", body: JSON.stringify({ stageKey: "delivered" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Reload the application before moving this project.", code: "stage_contract_reload_required" });
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ stage_key: "raw_review", board_revision: 0 });
  });
});
