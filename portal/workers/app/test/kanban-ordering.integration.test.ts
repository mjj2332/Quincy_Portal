import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env, SessionUser } from "../src/env";
import { moveProjectStage } from "../src/lib/project-stage";

const database = env as unknown as { DB: D1Database };
const appEnv = env as unknown as Env;
const adminId = crypto.randomUUID();
const adminToken = `kanban-admin-${crypto.randomUUID()}`;
const photographerId = crypto.randomUUID();
const photographerToken = `kanban-photographer-${crypto.randomUUID()}`;
const externalEditorId = crypto.randomUUID();
const externalEditorToken = `kanban-external-${crypto.randomUUID()}`;
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

async function seedProject(id: string, stageKey: string, boardPosition: number, priority: number | null = null, shootDate: string | null = null) {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, shoot_date, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
    .bind(id, id, stageKey, priority, shootDate, boardPosition, now, now).run();
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
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Kanban External Editor', ?, 1, 'external_editor', 1, 0, ?, ?)")
      .bind(externalEditorId, `${externalEditorId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, externalEditorToken, externalEditorId, now, now),
  ]);
});

describe("Kanban priority and Board commands", () => {
  it("changes Priority metadata without changing the Board revision (nothing writes a position)", async () => {
    const first = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "raw_review", 1024, 1); await seedProject(target, "raw_review", 4096);
    const response = await request(`/api/projects/${target}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: 2 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ priority: 2, boardRevision: 0 });
    expect(await database.DB.prepare("SELECT priority, board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ priority: 2, board_position: 4096, board_revision: 0 });
  });

  it("rejects an out-of-range Priority rather than clamping it silently", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "raw_review", 4096, 1);
    const response = await request(`/api/projects/${target}/priority`, adminToken, { method: "POST", body: JSON.stringify({ priority: 6 }) });
    expect(response.status).toBe(400);
    expect(await database.DB.prepare("SELECT priority FROM projects WHERE id = ?").bind(target).first()).toEqual({ priority: 1 });
  });

  it("POST /board-position is not a route: the generic 404 answers and nothing is written", async () => {
    const first = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "edited_review", 1024); await seedProject(target, "edited_review", 3072);
    const footprint = async () => [
      (await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id IN (?, ?) ORDER BY id").bind(first, target).all()).results,
      await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(target).first(),
    ];
    const before = await footprint();
    const response = await request(`/api/projects/${target}/board-position`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "edited_review", boardRevision: 0 },
      targetStageKey: "edited_review",
      placement: { kind: "between", before: null, after: { projectId: first, boardRevision: 0 } },
    }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(await footprint()).toEqual(before);
  });

  it("creates with board revision 0 and writes no position, whatever the awaiting-RAW column holds", async () => {
    await seedProject(crypto.randomUUID(), "awaiting_raw", 1024); await seedProject(crypto.randomUUID(), "awaiting_raw", 2048);
    const street = `Create no position ${crypto.randomUUID()}`;
    const response = await request("/api/projects", adminToken, { method: "POST", body: JSON.stringify({ street, orderedServices: [] }) });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string } & Record<string, unknown>;
    expect(created).not.toHaveProperty("boardPosition");
    expect(await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(created.id).first()).toEqual({ stage_key: "awaiting_raw", board_position: 0, board_revision: 0 });
  });

  it("answers a retired between placement on /stage with the reload-required 409 and writes nothing", async () => {
    const stage = "edited_review";
    const top = crypto.randomUUID(); const mover = crypto.randomUUID();
    await seedProject(top, stage, 1024, 5, "2026-01-01"); await seedProject(mover, "raw_review", 1024, 3, "2026-01-01");
    const footprint = async () => [
      (await database.DB.prepare("SELECT id, stage_key, board_position, board_revision FROM projects WHERE id IN (?, ?) ORDER BY id").bind(top, mover).all()).results,
      await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(mover).first(),
    ];
    const before = await footprint();
    const response = await request(`/api/projects/${mover}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: stage,
      placement: { kind: "between", before: null, after: { projectId: top, boardRevision: 0 } },
      confirmation: { reasons: ["skipped_forward"] },
    }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stage_contract_reload_required" });
    expect(await footprint()).toEqual(before);
  });

  it("moves a Project with a 200 changed:true (not a conflict), audit and activity, leaving every position and the destination column untouched", async () => {
    const stage = "edited_review";
    const neighbour = crypto.randomUUID(); const mover = crypto.randomUUID();
    await seedProject(neighbour, stage, 5120, 1, "2026-01-01"); await seedProject(mover, "raw_review", 777, 2, "2026-01-01");
    const now = Date.now();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), mover, photographerId, now).run();
    const response = await request(`/api/projects/${mover}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: stage, placement: { kind: "append" },
      confirmation: { reasons: ["skipped_forward"] },
    }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { changed: boolean; project: { stageKey: string; boardRevision: number } };
    expect(body).toMatchObject({ changed: true, project: { stageKey: stage, boardRevision: 1 } });
    expect(await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(mover).first()).toEqual({ stage_key: stage, board_position: 777, board_revision: 1 });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(neighbour).first()).toEqual({ board_position: 5120, board_revision: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'stage.set'").bind(mover).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.stage.changed'").bind(mover).first()).toEqual({ count: 1 });
  });

  it("keeps orderedVisibleProjectIds on the move and no-change responses, derived by the comparator (priority, oldest shoot date, street) and not by stored position (#475, until #476)", async () => {
    const stage = "edited_review";
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE stage_key = ? AND archived_at IS NULL").bind(Date.now(), stage).run();
    const p5 = crypto.randomUUID(); const p1 = crypto.randomUUID(); const mover = crypto.randomUUID();
    // Stored positions deliberately disagree with the comparator order.
    await seedProject(p5, stage, 9000, 5, "2026-03-01"); await seedProject(p1, stage, 1000, 1, "2026-01-01");
    await seedProject(mover, "raw_review", 5000, 3, "2026-02-01");
    const moved = await request(`/api/projects/${mover}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: stage, placement: { kind: "append" }, confirmation: { reasons: ["skipped_forward"] },
    }) });
    expect(moved.status).toBe(200);
    const movedBody = await moved.json() as { changed: boolean; board?: { sourceStageKey: string; targetStageKey: string; orderedVisibleProjectIds?: string[] } };
    expect(movedBody.changed).toBe(true);
    expect(movedBody.board).toMatchObject({ sourceStageKey: "raw_review", targetStageKey: stage });
    expect(movedBody.board?.orderedVisibleProjectIds).toEqual([p5, mover, p1]);

    const unchanged = await request(`/api/projects/${mover}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: stage, boardRevision: 1 }, targetStageKey: stage, placement: { kind: "append" },
    }) });
    expect(unchanged.status).toBe(200);
    const unchangedBody = await unchanged.json() as { changed: boolean; board?: { orderedVisibleProjectIds?: string[] } };
    expect(unchangedBody.changed).toBe(false);
    expect(unchangedBody.board?.orderedVisibleProjectIds).toEqual([p5, mover, p1]);
  });

  it("answers a user move 200 changed with its audit, and an unrelated Project entering the destination Stage at the same time no longer causes a 409 (#475)", async () => {
    const stage = "edited_review";
    const first = crypto.randomUUID(); const second = crypto.randomUUID();
    await seedProject(first, "raw_review", 10, 1, "2026-01-01"); await seedProject(second, "raw_review", 20, 2, "2026-01-02");
    const send = (id: string) => request(`/api/projects/${id}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: stage, placement: { kind: "append" }, confirmation: { reasons: ["skipped_forward"] },
    }) });
    const responses = await Promise.all([send(first), send(second)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    for (const [index, id] of [first, second].entries()) {
      expect(await responses[index]!.json()).toMatchObject({ changed: true, project: { projectId: id, stageKey: stage, boardRevision: 1 } });
      expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(id).first()).toEqual({ stage_key: stage, board_revision: 1 });
      expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'stage.set'").bind(id).first()).toEqual({ count: 1 });
      expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.stage.changed'").bind(id).first()).toEqual({ count: 1 });
    }
  });

  it("moveProjectStage reports a moved result whose finalizer carries the committed publication ids, and fills the Shoot date follow-up flag only for an undated Awaiting RAW exit (#475)", async () => {
    const principal: SessionUser = { id: adminId, email: `${adminId}@example.test`, name: "Kanban Admin", role: "admin", active: true, authorizationEpoch: 0, impersonatedBy: null };
    const dated = crypto.randomUUID(); const undated = crypto.randomUUID();
    await seedProject(dated, "raw_review", 1, null, "2026-01-01"); await seedProject(undated, "awaiting_raw", 2, null, null);
    // An assigned External Editor receives the safe Stage activity, so the finalizer has something to publish.
    const joinedAt = Date.now();
    await database.DB.batch([dated, undated].map((id) => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), id, externalEditorId, joinedAt)));
    const datedResult = await moveProjectStage({ env: appEnv, principal, projectId: dated, request: {
      expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: "edited_review", placement: { kind: "append" }, confirmation: { reasons: ["skipped_forward"] },
    } as never });
    expect(datedResult).toMatchObject({ kind: "moved", shootDateFilled: false, finalizer: { publicationIds: expect.any(Array) } });
    const undatedResult = await moveProjectStage({ env: appEnv, principal, projectId: undated, request: {
      expected: { stageKey: "awaiting_raw", boardRevision: 0 }, targetStageKey: "raw_review", placement: { kind: "append" }, confirmation: { reasons: [] },
    } as never });
    expect(undatedResult).toMatchObject({ kind: "moved", shootDateFilled: true, finalizer: { publicationIds: expect.any(Array) } });
    for (const result of [datedResult, undatedResult]) {
      if (result.kind !== "moved") throw new Error("expected moved");
      expect(result.finalizer.publicationIds.length).toBeGreaterThan(0);
      for (const id of result.finalizer.publicationIds) {
        expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE id = ?").bind(id).first()).toEqual({ count: 1 });
      }
    }
  });

  it("fills an undated Shoot date and reports the move as a success when a Project leaves Awaiting RAW (#475)", async () => {
    const neighbour = crypto.randomUUID(); const mover = crypto.randomUUID();
    await seedProject(neighbour, "raw_review", 2048, null, "2026-01-01"); await seedProject(mover, "awaiting_raw", 31, null, null);
    const response = await request(`/api/projects/${mover}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "awaiting_raw", boardRevision: 0 }, targetStageKey: "raw_review", placement: { kind: "append" }, confirmation: { reasons: [] },
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, project: { stageKey: "raw_review", boardRevision: 1 } });
    const row = await database.DB.prepare("SELECT shoot_date, board_position FROM projects WHERE id = ?").bind(mover).first<{ shoot_date: string | null; board_position: number }>();
    expect(row?.shoot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row?.board_position).toBe(31);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.shoot_date.changed'").bind(mover).first()).toEqual({ count: 1 });
  });

  it("restores an archived Project without writing a position and bumps its revision", async () => {
    const stage = "edited_review";
    await seedProject(crypto.randomUUID(), stage, 9000);
    const target = crypto.randomUUID();
    await seedProject(target, stage, 123);
    expect((await request(`/api/projects/${target}/archive`, adminToken, { method: "POST" })).status).toBe(200);
    const archived = await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first<{ board_position: number; board_revision: number }>();
    expect((await request(`/api/projects/${target}/restore`, adminToken, { method: "POST" })).status).toBe(200);
    const restored = await database.DB.prepare("SELECT board_position, board_revision, archived_at FROM projects WHERE id = ?").bind(target).first<{ board_position: number; board_revision: number; archived_at: number | null }>();
    expect(restored).toEqual({ board_position: 123, board_revision: archived!.board_revision + 1, archived_at: null });
  });

  it("rejects a wrong boardRevision on /stage with a stage conflict and no write", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "edited_review", 0);
    const response = await request(`/api/projects/${target}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "edited_review", boardRevision: 7 }, targetStageKey: "delivered", placement: { kind: "append" },
      confirmation: { reasons: ["skipped_forward", "delivered_boundary"] },
    }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "project_stage_conflict" });
    expect(await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ stage_key: "edited_review", board_position: 0, board_revision: 0 });
  });

  it("still rejects a malformed /stage body during parsing", async () => {
    const target = crypto.randomUUID();
    await seedProject(target, "edited_review", 1024);
    const response = await request(`/api/projects/${target}/stage`, adminToken, { method: "POST", body: JSON.stringify({
      expected: { stageKey: "edited_review", boardRevision: 0 },
      targetStageKey: "edited_review",
      placement: { kind: "append", extra: true },
    }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid input" });
    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 1024, board_revision: 0 });
  });

  it("returns no_change for a same-Stage append /stage request without mutating", async () => {
    const first = crypto.randomUUID(); const target = crypto.randomUUID();
    await seedProject(first, "delivered", 0); await seedProject(target, "delivered", 1024);
    const beforeAudit = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(target).first();
    for (const placement of [{ kind: "append" }]) {
      const response = await request(`/api/projects/${target}/stage`, adminToken, { method: "POST", body: JSON.stringify({
        expected: { stageKey: "delivered", boardRevision: 0 }, targetStageKey: "delivered", placement,
      }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ changed: false });
    }
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

  it("orders every role's Stage map by priority, then oldest shoot date, then street; the External Editor map never uses priority (#470)", async () => {
    // A Stage of its own, so rows seeded by earlier tests cannot interleave with the assertion.
    const stage = "awaiting_raw";
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE stage_key = ? AND archived_at IS NULL").bind(Date.now(), stage).run();
    const p5Late = crypto.randomUUID(); const p1Early = crypto.randomUUID(); const noneEarly = crypto.randomUUID(); const noneUndated = crypto.randomUUID();
    // Stored positions deliberately disagree with the expected order.
    await seedProject(p5Late, stage, 4000, 5, "2026-09-01");
    await seedProject(p1Early, stage, 3000, 1, "2026-01-01");
    await seedProject(noneEarly, stage, 2000, null, "2026-02-01");
    await seedProject(noneUndated, stage, 1000, null, null);
    const internalExpected = [p5Late, p1Early, noneEarly, noneUndated];

    const now = Date.now();
    await database.DB.batch([p5Late, p1Early, noneEarly, noneUndated].flatMap((projectId) => [
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, externalEditorId, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), projectId, photographerId, now),
    ]));

    for (const token of [adminToken, photographerToken]) {
      const listed = await request("/api/projects", token);
      expect(listed.status).toBe(200);
      const body = await listed.json() as { board: { orderedProjectIdsByStage: Record<string, string[]> } };
      expect(body.board.orderedProjectIdsByStage[stage]).toEqual(internalExpected);
    }
    const internalList = await (await request("/api/projects", adminToken)).json() as { projects: Array<Record<string, unknown>> };
    expect(internalList.projects.length).toBeGreaterThan(0);
    for (const project of internalList.projects) expect(project).not.toHaveProperty("boardPosition");
    const external = await request("/api/projects", externalEditorToken);
    expect(external.status).toBe(200);
    const externalBody = await external.json() as { board: { orderedProjectIdsByStage: Record<string, string[]> } };
    // No priority: oldest shoot date first, undated last.
    expect(externalBody.board.orderedProjectIdsByStage[stage]).toEqual([p1Early, noneEarly, p5Late, noneUndated]);
  });

  it("returns only currently-assigned, active Editors on the summary, never Photographers (#79)", async () => {
    const projectId = crypto.randomUUID();
    await seedProject(projectId, "editing_autohdr", 1024);
    const activeEditorId = crypto.randomUUID();
    const deactivatedEditorId = crypto.randomUUID();
    const removedEditorId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Active Editor', ?, 1, 'editor', 1, 0, ?, ?)")
        .bind(activeEditorId, `${activeEditorId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Deactivated Editor', ?, 1, 'editor', 0, 0, ?, ?)")
        .bind(deactivatedEditorId, `${deactivatedEditorId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Removed Editor', ?, 1, 'editor', 1, 0, ?, ?)")
        .bind(removedEditorId, `${removedEditorId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
        .bind(crypto.randomUUID(), projectId, activeEditorId, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
        .bind(crypto.randomUUID(), projectId, deactivatedEditorId, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
        .bind(crypto.randomUUID(), projectId, removedEditorId, now),
      // The Kanban Photographer is a real project member here (Photographer role), to prove
      // Photographers never surface in `editors` even while actively assigned to the Project.
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)")
        .bind(crypto.randomUUID(), projectId, photographerId, now),
    ]);
    // A removed assignment must not appear, even though the user is active.
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, removedEditorId).run();

    const response = await request("/api/projects", adminToken);
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Array<{ id: string; editors: Array<{ id: string; name: string }> }> };
    const project = body.projects.find((row) => row.id === projectId);
    expect(project?.editors).toEqual([{ id: activeEditorId, name: "Active Editor" }]);
  });
});
