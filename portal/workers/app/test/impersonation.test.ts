import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { auditMeta } from "../src/lib/audit";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "44444444-4444-4444-8444-444444444444";
const photographerId = "55555555-5555-4555-8555-555555555555";
const otherPhotographerId = "66666666-6666-4666-8666-666666666666";
const otherAdminId = "77777777-7777-4777-8777-777777777777";
const inactiveId = "88888888-8888-4888-8888-888888888888";
const adminToken = "tb5-imp-admin-session-token";
const editorToken = "tb5-imp-editor-session-token";
const photographerToken = "tb5-imp-photographer-session-token";
const otherPhotographerToken = "tb5-imp-other-photographer-session-token";

declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function sessionCookie(token: string): Promise<string> {
  const { createAuth } = await import("../src/auth");
  const context = await createAuth(authEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  const cookies = new Map<string, string>();
  for (const value of values) {
    const pair = value.split(";", 1)[0]!;
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path: string, cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie, origin: authEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(new Request(`https://portal.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function setFlag(enabled: boolean, cookie: string): Promise<Response> {
  return request("/api/users/impersonation-settings", cookie, "PATCH", { enabled });
}

async function startImpersonation(targetId: string, cookie: string): Promise<{ response: Response; cookie: string; body: Record<string, any> }> {
  const response = await request("/api/auth/admin/impersonate-user", cookie, "POST", { userId: targetId });
  const body = await response.json() as Record<string, any>;
  return { response, cookie: cookieHeader(response), body };
}

async function insertUser(id: string, name: string, email: string, role: "admin" | "photographer" | "editor", active = true): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
    .bind(id, name, email, role, active ? 1 : 0, now, now).run();
}

async function insertSession(id: string, token: string, userId: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, now + 3_600_000, token, userId, now, now).run();
}

async function createAnnotationFixture(adminCookie: string): Promise<{ projectId: string; assetId: string }> {
  const projectResponse = await request("/api/projects", adminCookie, "POST", {
    street: `Impersonation annotation ${crypto.randomUUID()}`,
    orderedServices: [],
    photographerUserIds: [photographerId, otherPhotographerId],
  });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'")
    .bind(project.id).first<{ id: string }>();
  const assetId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(assetId, collection!.id, `tests/${assetId}.jpg`, "impersonation.jpg", 1, "upload", now, now).run();
  return { projectId: project.id, assetId };
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  await insertUser(editorId, "Impersonation Editor", "tb5-editor@example.test", "editor");
  await insertUser(photographerId, "Impersonation Photographer", "tb5-photographer@example.test", "photographer");
  await insertUser(otherPhotographerId, "Other Photographer", "tb5-other-photographer@example.test", "photographer");
  await insertUser(otherAdminId, "Other Admin", "tb5-other-admin@example.test", "admin");
  await insertUser(inactiveId, "Inactive Editor", "tb5-inactive@example.test", "editor", false);
  await insertSession("tb5-imp-admin-session", adminToken, adminId);
  await insertSession("tb5-imp-editor-session", editorToken, editorId);
  await insertSession("tb5-imp-photographer-session", photographerToken, photographerId);
  await insertSession("tb5-imp-other-photographer-session", otherPhotographerToken, otherPhotographerId);
});

beforeEach(async () => {
  await database.DB.batch([
    database.DB.prepare("UPDATE feature_flags SET enabled = 0, updated_by = NULL, updated_at = ? WHERE key = 'user_impersonation'").bind(Date.now()),
    database.DB.prepare("UPDATE user SET active = 1, role = CASE id WHEN ? THEN 'admin' WHEN ? THEN 'admin' ELSE role END WHERE id IN (?, ?, ?, ?)").bind(adminId, otherAdminId, adminId, otherAdminId, editorId, photographerId),
    database.DB.prepare("UPDATE user SET active = 0, role = 'editor' WHERE id = ?").bind(inactiveId),
    database.DB.prepare("DELETE FROM session WHERE user_id IN (?, ?, ?) AND token LIKE 'tb5-imp-%' AND token NOT IN (?, ?, ?, ?)").bind(editorId, photographerId, otherPhotographerId, editorToken, photographerToken, otherPhotographerToken, adminToken),
  ]);
});

describe("user impersonation gate and official Better Auth flow", () => {
  it("defaults OFF, strictly validates settings, and records toggle provenance", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const photographerCookie = await sessionCookie(photographerToken);
    await expect((await request("/api/users/impersonation-settings", adminCookie)).json()).resolves.toEqual({ enabled: false });
    expect((await request("/api/users/impersonation-settings", photographerCookie)).status).toBe(403);
    expect((await request("/api/users/impersonation-settings", adminCookie, "PATCH", { enabled: "yes" })).status).toBe(400);
    expect((await request("/api/users/impersonation-settings", adminCookie, "PATCH", { enabled: true, extra: false })).status).toBe(400);
    const enabled = await setFlag(true, adminCookie);
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toEqual({ enabled: true });
    const auditRow = await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = 'user.impersonation_toggle' AND target_id = 'user_impersonation' ORDER BY created_at DESC LIMIT 1").first();
    expect(auditRow).toEqual({ actor_id: adminId, action: "user.impersonation_toggle", target_type: "feature_flag", target_id: "user_impersonation", meta_json: '{"enabled":true}' });
    expect((await setFlag(false, adminCookie)).status).toBe(200);
  });

  it("retains the target session when stock Exit cannot resolve the revoked original session", async () => {
    const adminCookie = await sessionCookie(adminToken);
    expect((await setFlag(true, adminCookie)).status).toBe(200);
    const started = await startImpersonation(editorId, adminCookie);
    expect(started.response.status).toBe(200);
    const original = await database.DB.prepare("SELECT id FROM session WHERE token = ?").bind(adminToken).first<{ id: string }>();
    const target = await database.DB.prepare("SELECT id FROM session WHERE user_id = ? AND impersonated_by = ? ORDER BY created_at DESC LIMIT 1").bind(editorId, adminId).first<{ id: string }>();
    expect(original).not.toBeNull();
    expect(target).not.toBeNull();
    try {
      await database.DB.prepare("DELETE FROM session WHERE id = ?").bind(original!.id).run();
      const stop = await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {});
      expect(stop.status).not.toBe(200);
      expect(await database.DB.prepare("SELECT id FROM session WHERE id = ?").bind(target!.id).first()).toEqual({ id: target!.id });
    } finally {
      await database.DB.prepare("DELETE FROM session WHERE id = ?").bind(target!.id).run();
      await insertSession("tb5-imp-admin-session", adminToken, adminId);
      await database.DB.prepare("UPDATE feature_flags SET enabled = 0, updated_by = NULL, updated_at = ? WHERE key = ?").bind(Date.now(), "user_impersonation").run();
    }
  });

  it("surfaces stock Exit failure after target deactivation deletes the target session", async () => {
    const adminCookie = await sessionCookie(adminToken);
    expect((await setFlag(true, adminCookie)).status).toBe(200);
    const started = await startImpersonation(editorId, adminCookie);
    expect(started.response.status).toBe(200);
    const target = await database.DB.prepare("SELECT id FROM session WHERE user_id = ? AND impersonated_by = ? ORDER BY created_at DESC LIMIT 1").bind(editorId, adminId).first<{ id: string }>();
    expect(target).not.toBeNull();
    try {
      const deactivated = await request(`/api/users/${editorId}`, adminCookie, "PATCH", { active: false });
      expect(deactivated.status).toBe(200);
      expect(await database.DB.prepare("SELECT id FROM session WHERE user_id = ? AND impersonated_by = ?").bind(editorId, adminId).first()).toBeNull();
      const stop = await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {});
      expect(stop.status).not.toBe(200);
    } finally {
      await database.DB.prepare("DELETE FROM session WHERE id = ?").bind(target!.id).run();
      await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(editorId).run();
      await insertSession("tb5-imp-editor-session", editorToken, editorId);
      await database.DB.prepare("UPDATE feature_flags SET enabled = 0, updated_by = NULL, updated_at = ? WHERE key = ?").bind(Date.now(), "user_impersonation").run();
    }
  });

  it("does not apply the impersonation branch to ordinary session creation while OFF", async () => {
    const authContext = await createAuth(authEnv).$context;
    const normal = await authContext.internalAdapter.createSession(editorId, true);
    expect(normal.userId).toBe(editorId);
    await database.DB.prepare("DELETE FROM session WHERE id = ?").bind(normal.id).run();
    await expect(authContext.internalAdapter.createSession(inactiveId, true)).rejects.toThrow("This staff account is inactive.");
  });

  it("preserves ordinary audit JSON and makes impersonation provenance immutable", () => {
    expect(auditMeta({ id: adminId, impersonatedBy: null })).toBeNull();
    expect(auditMeta({ id: adminId, impersonatedBy: null }, { enabled: true })).toBe('{"enabled":true}');
    expect(auditMeta({ id: photographerId, impersonatedBy: adminId }, { impersonatedBy: "spoofed", action: "edit" })).toBe(`{"impersonatedBy":"${adminId}","action":"edit"}`);
  });

  it("blocks start while OFF, preserves ordinary sessions, and allows official start/stop while ON then OFF", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const editorCookie = await sessionCookie(editorToken);
    const ordinary = await request("/api/me", editorCookie);
    expect(ordinary.status).toBe(200);
    const disabled = await startImpersonation(editorId, adminCookie);
    expect(disabled.response.status).toBe(403);
    expect(disabled.body).toEqual({ error: "User impersonation is disabled.", code: "impersonation_disabled" });

    expect((await setFlag(true, adminCookie)).status).toBe(200);
    const started = await startImpersonation(editorId, adminCookie);
    expect(started.response.status).toBe(200);
    expect(started.body.user).toMatchObject({ id: editorId, role: "editor", name: "Impersonation Editor" });
    expect(started.body.user).toHaveProperty("banned");
    expect(started.body.user).toHaveProperty("banReason");
    expect(started.body.user).toHaveProperty("banExpires");
    expect(started.body.session).toHaveProperty("impersonatedBy", adminId);
    const stored = await database.DB.prepare("SELECT user_id, impersonated_by, expires_at FROM session WHERE user_id = ? AND impersonated_by = ? ORDER BY created_at DESC LIMIT 1").bind(editorId, adminId).first<{ user_id: string; impersonated_by: string; expires_at: number }>();
    expect(stored?.user_id).toBe(editorId);
    expect(stored?.impersonated_by).toBe(adminId);
    expect(stored!.expires_at).toBeLessThanOrEqual(Date.now() + 3_600_000 + 10_000);
    await expect((await request("/api/me", started.cookie)).json()).resolves.toMatchObject({ user: { id: editorId, role: "editor", impersonatedBy: adminId } });
    const directSession = await request("/api/auth/get-session", started.cookie);
    expect(directSession.status).toBe(200);
    await expect(directSession.json()).resolves.toMatchObject({ user: { id: editorId, role: "editor" }, session: { impersonatedBy: adminId } });

    const directory = await request("/api/users", adminCookie);
    const directoryBody = await directory.json() as { users: Array<Record<string, unknown>> };
    expect(directory.status).toBe(200);
    expect(directoryBody.users.every((user) => !Object.hasOwn(user, "banned") && !Object.hasOwn(user, "banReason") && !Object.hasOwn(user, "banExpires"))).toBe(true);

    expect((await setFlag(false, adminCookie)).status).toBe(200);
    const stop = await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {});
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ user: { id: adminId, role: "admin" } });
    expect(await database.DB.prepare("SELECT id FROM session WHERE user_id = ? AND impersonated_by = ?").bind(editorId, adminId).first()).toBeNull();
    const lifecycle = await database.DB.prepare("SELECT action, actor_id, target_type, target_id, meta_json FROM audit_log WHERE target_id = ? AND action IN ('user.impersonate_start', 'user.impersonate_stop') ORDER BY created_at").bind(editorId).all();
    expect(lifecycle.results).toEqual(expect.arrayContaining([
      { action: "user.impersonate_start", actor_id: adminId, target_type: "user", target_id: editorId, meta_json: '{"targetEmail":"tb5-editor@example.test","targetRole":"editor"}' },
      { action: "user.impersonate_stop", actor_id: adminId, target_type: "user", target_id: editorId, meta_json: '{"targetEmail":"tb5-editor@example.test","targetRole":"editor"}' },
    ]));
  });

  it("keeps the official plugin permission boundary and rejects invalid or chained targets", async () => {
    const adminCookie = await sessionCookie(adminToken);
    expect((await setFlag(true, adminCookie)).status).toBe(200);
    expect((await startImpersonation(adminId, adminCookie)).response.status).toBe(403);
    expect((await startImpersonation(otherAdminId, adminCookie)).response.status).toBe(403);
    expect((await startImpersonation(inactiveId, adminCookie)).response.status).toBe(403);
    expect((await startImpersonation("99999999-9999-4999-8999-999999999999", adminCookie)).response.status).toBe(404);
    expect((await request("/api/auth/admin/list-users", adminCookie, "GET")).status).toBe(403);
    expect((await request("/api/auth/admin/set-role", adminCookie, "POST", { userId: editorId, role: "editor" })).status).toBe(403);
    expect((await request("/api/auth/admin/ban-user", adminCookie, "POST", { userId: editorId, banReason: "not allowed" })).status).toBe(403);
    expect((await request("/api/auth/admin/remove-user", adminCookie, "POST", { userId: otherPhotographerId })).status).toBe(403);
    const started = await startImpersonation(editorId, adminCookie);
    expect(started.response.status).toBe(200);
    expect((await startImpersonation(photographerId, started.cookie)).response.status).toBe(403);
    expect((await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {})).status).toBe(200);
  });

  it("adds immutable provenance to a direct-batch project-comment audit", async () => {
    const adminCookie = await sessionCookie(adminToken);
    expect((await setFlag(true, adminCookie)).status).toBe(200);
    const started = await startImpersonation(photographerId, adminCookie);
    expect(started.response.status).toBe(200);
    const fixture = await createAnnotationFixture(adminCookie);
    const created = await request(`/api/projects/${fixture.projectId}/comments`, started.cookie, "POST", {
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Direct batch provenance" }] }] },
    });
    expect(created.status).toBe(201);
    const comment = await created.json() as { id: string };
    const auditRow = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE action = 'project_comment.create' AND target_id = ?").bind(comment.id).first<{ actor_id: string; meta_json: string }>();
    expect(auditRow?.actor_id).toBe(photographerId);
    expect(JSON.parse(auditRow!.meta_json)).toMatchObject({ impersonatedBy: adminId });
    expect((await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {})).status).toBe(200);
  });

  it("fails closed for target promotion, flag changes, and original-principal changes on API and media", async () => {
    const adminCookie = await sessionCookie(adminToken);
    expect((await setFlag(true, adminCookie)).status).toBe(200);
    const started = await startImpersonation(editorId, adminCookie);
    expect(started.response.status).toBe(200);
    const denied = async (cookie = started.cookie) => {
      const expected = { error: "User impersonation is disabled.", code: "impersonation_disabled" };
      await expect((await request("/api/me", cookie)).json()).resolves.toEqual(expected);
      await expect((await request("/media/asset/not-a-uuid/web", cookie)).json()).resolves.toEqual(expected);
    };
    await database.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(editorId).run();
    await denied();
    await database.DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(editorId).run();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run();
    await denied();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(adminId).run();
    await denied();
    await database.DB.prepare("UPDATE user SET active = 1, role = 'editor' WHERE id = ?").bind(adminId).run();
    await denied();
    await database.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(adminId).run();
    expect((await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {})).status).toBe(200);
  });

  it("keeps author-only enforcement effective for normal Admin and deliberately effective for X", async () => {
    const adminCookie = await sessionCookie(adminToken);
    expect((await setFlag(true, adminCookie)).status).toBe(200);
    const started = await startImpersonation(photographerId, adminCookie);
    expect(started.response.status).toBe(200);
    const fixture = await createAnnotationFixture(adminCookie);
    const own = await request(`/api/assets/${fixture.assetId}/annotations`, started.cookie, "POST", { noteText: "Photographer-owned" });
    expect(own.status).toBe(201);
    const ownAnnotation = await own.json() as { id: string };
    expect((await request(`/api/annotations/${ownAnnotation.id}`, adminCookie, "PATCH", { noteText: "Admin cannot edit" })).status).toBe(403);
    expect((await request(`/api/annotations/${ownAnnotation.id}`, started.cookie, "PATCH", { noteText: "Acting as photographer" })).status).toBe(200);

    const other = await request(`/api/assets/${fixture.assetId}/annotations`, await sessionCookie(otherPhotographerToken), "POST", { noteText: "Other-owned" });
    expect(other.status).toBe(201);
    const otherAnnotation = await other.json() as { id: string };
    expect((await request(`/api/annotations/${otherAnnotation.id}`, started.cookie, "PATCH", { noteText: "Unrelated author" })).status).toBe(403);
    const auditRow = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE action = 'annotation.edit' AND target_id = ? ORDER BY created_at DESC LIMIT 1").bind(ownAnnotation.id).first();
    expect(auditRow).toEqual({ actor_id: photographerId, meta_json: expect.stringContaining(`\"impersonatedBy\":\"${adminId}\"`) });
    expect((await request("/api/auth/admin/stop-impersonating", started.cookie, "POST", {})).status).toBe(200);
  });
});
