import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const adminToken = "tb135-admin-session-token";
const photographerId = "91111111-1111-4111-8111-111111111111";
const photographerToken = "tb135-photographer-session-token";
const activeEditorId = "92222222-2222-4222-8222-222222222222";
const inactiveEditorId = "93333333-3333-4333-8333-333333333333";
const externalEditorId = "94444444-4444-4444-8444-444444444444";
const activePhotographerId = "95555555-5555-4555-8555-555555555555";

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
  const context = await createAuth(authEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function insertUser(id: string, name: string, email: string, role: "admin" | "photographer" | "editor" | "external_editor", active = true): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
    .bind(id, name, email, role, active ? 1 : 0, now, now).run();
}

async function insertSession(id: string, token: string, userId: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, now + 3_600_000, token, userId, now, now).run();
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

async function patchDefaultEditor(id: string, cookie: string, defaultEditor: boolean): Promise<Response> {
  return request(`/api/users/${id}`, cookie, "PATCH", { defaultEditor });
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  await insertUser(photographerId, "TB135 Photographer", "tb135-photographer@example.test", "photographer");
  await insertUser(activeEditorId, "TB135 Active Editor", "tb135-active-editor@example.test", "editor");
  await insertUser(inactiveEditorId, "TB135 Inactive Editor", "tb135-inactive-editor@example.test", "editor", false);
  await insertUser(externalEditorId, "TB135 External Editor", "tb135-external-editor@example.test", "external_editor");
  await insertUser(activePhotographerId, "TB135 Ineligible Photographer", "tb135-ineligible-photographer@example.test", "photographer");
  await insertSession("tb135-admin-session", adminToken, adminId);
  await insertSession("tb135-photographer-session", photographerToken, photographerId);
});

describe("default editors — users route (#135)", () => {
  it("includes defaultEditor on GET /api/users", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const response = await request("/api/users", adminCookie);
    expect(response.status).toBe(200);
    const body = await response.json() as { users: Array<{ id: string; defaultEditor: unknown }> };
    const activeEditor = body.users.find((user) => user.id === activeEditorId);
    expect(activeEditor).toMatchObject({ defaultEditor: false });
  });

  it("rejects a non-admin (403) and rejects defaultEditor combined with a lifecycle field (400)", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const photographerCookie = await sessionCookie(photographerToken);
    expect((await patchDefaultEditor(activeEditorId, photographerCookie, true)).status).toBe(403);
    const combined = await request(`/api/users/${activeEditorId}`, adminCookie, "PATCH", { defaultEditor: true, active: false });
    expect(combined.status).toBe(400);
    await expect(combined.json()).resolves.toMatchObject({ code: "default_editor_separate_request" });
  });

  it("enables an active, editor-eligible user and audits the transition", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const enabled = await patchDefaultEditor(activeEditorId, adminCookie, true);
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toEqual({ ok: true, defaultEditor: true });
    const row = await database.DB.prepare("SELECT default_editor AS defaultEditor FROM user WHERE id = ?").bind(activeEditorId).first<{ defaultEditor: number }>();
    expect(row?.defaultEditor).toBe(1);
    const auditRow = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE action = 'user.default_editor.enabled' AND target_id = ?").bind(activeEditorId).first<{ actor_id: string; meta_json: string }>();
    expect(auditRow).toEqual({ actor_id: adminId, meta_json: "{}" });

    // Already-on is a no-op: 200, no second audit row.
    const again = await patchDefaultEditor(activeEditorId, adminCookie, true);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ ok: true, defaultEditor: true });
    const auditCount = await database.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.default_editor.enabled' AND target_id = ?").bind(activeEditorId).first<{ n: number }>();
    expect(auditCount?.n).toBe(1);

    // Disable then confirm no-op disable is also a no-op.
    const disabled = await patchDefaultEditor(activeEditorId, adminCookie, false);
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toEqual({ ok: true, defaultEditor: false });
    const disabledRow = await database.DB.prepare("SELECT default_editor AS defaultEditor FROM user WHERE id = ?").bind(activeEditorId).first<{ defaultEditor: number }>();
    expect(disabledRow?.defaultEditor).toBe(0);
    const disabledAgain = await patchDefaultEditor(activeEditorId, adminCookie, false);
    expect(disabledAgain.status).toBe(200);
    await expect(disabledAgain.json()).resolves.toEqual({ ok: true, defaultEditor: false });
    const disableAuditCount = await database.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.default_editor.disabled' AND target_id = ?").bind(activeEditorId).first<{ n: number }>();
    expect(disableAuditCount?.n).toBe(1);
  });

  it("rejects enabling an inactive user with 409 default_editor_ineligible", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const response = await patchDefaultEditor(inactiveEditorId, adminCookie, true);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "default_editor_ineligible" });
    const row = await database.DB.prepare("SELECT default_editor AS defaultEditor FROM user WHERE id = ?").bind(inactiveEditorId).first<{ defaultEditor: number }>();
    expect(row?.defaultEditor).toBe(0);
  });

  it("rejects enabling an ineligible-role (photographer) user with 409 default_editor_ineligible", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const response = await patchDefaultEditor(activePhotographerId, adminCookie, true);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "default_editor_ineligible" });
  });

  it("allows enabling an active external_editor (editor-eligible role)", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const response = await patchDefaultEditor(externalEditorId, adminCookie, true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, defaultEditor: true });
  });

  it("returns 404 for a missing user id", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const response = await patchDefaultEditor("99999999-9999-4999-8999-999999999999", adminCookie, true);
    expect(response.status).toBe(404);
  });

  it("clears default_editor on the same UPDATE when a role change makes the user ineligible", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const flagged = await patchDefaultEditor(activeEditorId, adminCookie, true);
    expect(flagged.status).toBe(200);
    const roleChange = await request(`/api/users/${activeEditorId}`, adminCookie, "PATCH", { role: "photographer" });
    expect(roleChange.status).toBe(200);
    const row = await database.DB.prepare("SELECT default_editor AS defaultEditor, role FROM user WHERE id = ?").bind(activeEditorId).first<{ defaultEditor: number; role: string }>();
    expect(row).toEqual({ defaultEditor: 0, role: "photographer" });
    // Cleanup: restore role for any later ordering assumptions.
    await database.DB.prepare("UPDATE user SET role = 'editor', authorization_epoch = authorization_epoch WHERE id = ?").bind(activeEditorId).run();
  });

  it("clears default_editor on the same UPDATE when the user is deactivated", async () => {
    const adminCookie = await sessionCookie(adminToken);
    await database.DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(externalEditorId).run();
    const flagged = await patchDefaultEditor(externalEditorId, adminCookie, true);
    expect(flagged.status).toBe(200);
    const deactivate = await request(`/api/users/${externalEditorId}`, adminCookie, "PATCH", { active: false });
    expect(deactivate.status).toBe(200);
    const row = await database.DB.prepare("SELECT default_editor AS defaultEditor, active FROM user WHERE id = ?").bind(externalEditorId).first<{ defaultEditor: number; active: number }>();
    expect(row).toEqual({ defaultEditor: 0, active: 0 });
  });
});
