import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const appEnv = env as unknown as Env;
const adminId = crypto.randomUUID();
const adminToken = `kanban-admin-${crypto.randomUUID()}`;
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

  it("delegates same-Stage direction ordering to the Board command", async () => {
    const first = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "edited_review", 1024); await seedProject(target, "edited_review", 2048);
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({ direction: "up" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ projectId: target, boardRevision: 1 });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 0, board_revision: 1 });
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 1").bind(target).first()).toEqual({ action: "project.board_position_set" });
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

  it("rejects the exact legacy body before mutation", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "raw_review", 1024);
    const response = await request(`/api/projects/${target}/stage/`, adminToken, { method: "POST", body: JSON.stringify({ stageKey: "delivered" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Reload the application before moving this project.", code: "stage_contract_reload_required" });
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ stage_key: "raw_review", board_revision: 0 });
  });
});
