import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { externalProjectActivityFeedItemSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { auditMeta } from "../src/lib/audit";
import type { McpPrincipal } from "../src/lib/mcp-dispatch-context";
import { dispatchToApi, type McpFetchApp } from "../src/mcp/dispatch";

// Test-local allowlist override: the production list is NOT widened in #704. Write routes are admitted here only, by wrapping the real predicate.
vi.mock("../src/mcp/route-allowlist", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mcp/route-allowlist")>();
  const ID = "[A-Za-z0-9_-]+";
  const extra: Array<{ method: string; pattern: RegExp }> = [
    { method: "GET", pattern: new RegExp(`^/api/projects/${ID}/comments$`) },
    { method: "POST", pattern: new RegExp(`^/api/projects/${ID}/comments$`) },
    { method: "GET", pattern: new RegExp(`^/api/projects/${ID}/activity$`) },
    { method: "POST", pattern: new RegExp(`^/api/projects/${ID}/subtasks$`) },
    { method: "PUT", pattern: new RegExp(`^/api/projects/${ID}/deadline$`) },
  ];
  return { ...original, isAllowedMcpRoute: (method: string, path: string) => original.isAllowedMcpRoute(method, path) || extra.some((route) => route.method === method && route.pattern.test(path)) };
});

const database = env as unknown as { DB: D1Database };
const testEnv = env as unknown as Env;
const authSecret = testEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const adminToken = "mcp-provenance-admin-session-token";
const externalId = "c2000000-0000-4000-8000-000000000704";
const externalToken = "mcp-provenance-external-session-token";
const projectId = "c1000000-0000-4000-8000-000000000704";
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const fetchApp: McpFetchApp = (request, e, c) => app.fetch(request, e, c);
const principal: McpPrincipal = { userId: adminId, connectionId: "conn-prov", clientName: "Test Client", authorizationEpoch: 0 };

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookieRequest(path: string, method = "GET", body?: unknown, token = adminToken): Promise<Response> {
  const context = await createAuth(testEnv).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  const headers = new Headers({ cookie, origin: testEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return app.fetch(new Request(`${testEnv.APP_ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), testEnv, ctx);
}
const viaMcp = (method: string, path: string, body?: unknown) => dispatchToApi(fetchApp, testEnv, ctx, principal, { method, path, ...(body === undefined ? {} : { body }) });

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
type AuditRow = { id: string; action: string; target_id: string | null; meta_json: string | null };
type ActivityRow = { id: string; event_type: string; via_client: string | null };

async function maxRowids() {
  const audit = await database.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>();
  const activity = await database.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM project_activity_events").first<{ n: number }>();
  return { audit: audit!.n, activity: activity!.n };
}
async function rowsSince(mark: { audit: number; activity: number }) {
  const audit = (await database.DB.prepare("SELECT id, action, target_id, meta_json FROM audit_log WHERE rowid > ? ORDER BY rowid").bind(mark.audit).all<AuditRow>()).results;
  const activity = (await database.DB.prepare("SELECT id, event_type, via_client FROM project_activity_events WHERE rowid > ? ORDER BY rowid").bind(mark.activity).all<ActivityRow>()).results;
  return { audit, activity };
}
const metaOf = (row: AuditRow) => (row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {});

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('mcp-provenance-admin-session', ?, ?, ?, ?, ?)").bind(now + 3_600_000, adminToken, adminId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Provenance Street', 'edited_review', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Provenance External', ?, 1, 'external_editor', 1, ?, ?)").bind(externalId, `${externalId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('mcp-provenance-external-session', ?, ?, ?, ?, ?)").bind(now + 3_600_000, externalToken, externalId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, externalId, now),
    database.DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES ('conn-prov', ?, 'client-1', 'Test Client', 'client.example.test', '[\"write\"]', 0, ?)").bind(adminId, now),
    database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(now),
  ]);
});

describe("auditMeta provenance", () => {
  it("stays null for a plain principal with no meta, and for impersonation behaviour it already had", () => {
    expect(auditMeta({ id: "u", impersonatedBy: null })).toBeNull();
    expect(auditMeta(null)).toBeNull();
    expect(auditMeta({ id: "u", impersonatedBy: "a" })).toBe('{"impersonatedBy":"a"}');
  });

  it("appends via, client and connectionId after the caller's meta, and is non-null with no meta", () => {
    const via = { kind: "mcp" as const, clientName: "Claude", connectionId: "conn-1" };
    expect(auditMeta({ id: "u", impersonatedBy: null, via }, { a: 1 })).toBe('{"a":1,"via":"mcp","client":"Claude","connectionId":"conn-1"}');
    expect(auditMeta({ id: "u", impersonatedBy: null, via })).toBe('{"via":"mcp","client":"Claude","connectionId":"conn-1"}');
  });

  it("throws when the caller's meta already carries a via or client key", () => {
    const via = { kind: "mcp" as const, clientName: "Claude", connectionId: "conn-1" };
    expect(() => auditMeta({ id: "u", impersonatedBy: null }, { via: "create" })).toThrow();
    expect(() => auditMeta({ id: "u", impersonatedBy: null, via }, { client: "x" })).toThrow();
  });
});

describe("a Project comment posted through MCP", () => {
  it("carries via in its audit row and activity row, and the list returns viaClient (cookie post stays null)", async () => {
    const mark = await maxRowids();
    const posted = await viaMcp("POST", `/api/projects/${projectId}/comments`, { content: doc("Hello from an AI client") });
    expect(posted.status).toBe(201);
    const mcpComment = await posted.json() as { id: string };
    const after = await rowsSince(mark);
    const audit = after.audit.find((row) => row.action === "project_comment.create");
    expect(audit && metaOf(audit)).toMatchObject({ via: "mcp", client: "Test Client", connectionId: "conn-prov" });
    const activity = after.activity.find((row) => row.event_type === "project.comment.created");
    expect(activity?.via_client).toBe("Test Client");

    const cookieMark = await maxRowids();
    const cookiePosted = await cookieRequest(`/api/projects/${projectId}/comments`, "POST", { content: doc("Hello from the browser") });
    expect(cookiePosted.status).toBe(201);
    const cookieComment = await cookiePosted.json() as { id: string; viaClient?: string | null };
    expect(cookieComment.viaClient ?? null).toBeNull();
    const cookieRows = await rowsSince(cookieMark);
    const cookieAudit = cookieRows.audit.find((row) => row.action === "project_comment.create")!;
    expect(cookieAudit.meta_json === null || !("via" in metaOf(cookieAudit))).toBe(true);
    expect(cookieAudit.meta_json === null || !("client" in metaOf(cookieAudit))).toBe(true);
    expect(cookieRows.activity.find((row) => row.event_type === "project.comment.created")?.via_client).toBeNull();

    for (const respond of [() => cookieRequest(`/api/projects/${projectId}/comments`), () => viaMcp("GET", `/api/projects/${projectId}/comments`)]) {
      const list = await (await respond()).json() as { comments: Array<{ id: string; viaClient: string | null }> };
      expect(list.comments.find((comment) => comment.id === mcpComment.id)?.viaClient).toBe("Test Client");
      expect(list.comments.find((comment) => comment.id === cookieComment.id)?.viaClient).toBeNull();
    }
  });

  it("shows viaClient on the staff Project activity feed and only there", async () => {
    const feed = await (await cookieRequest(`/api/projects/${projectId}/activity`)).json() as { items: Array<{ type: string; viaClient: string | null }> };
    const created = feed.items.filter((item) => item.type === "project.comment.created");
    expect(created.map((item) => item.viaClient)).toHaveLength(2);
    expect(created.map((item) => item.viaClient)).toEqual(expect.arrayContaining([null, "Test Client"]));
    expect(Object.keys(externalProjectActivityFeedItemSchema.shape)).not.toContain("viaClient");
  });
});

describe("an assigned External Editor sees the same provenance on comments", () => {
  it("returns viaClient on the list, with null for a cookie comment", async () => {
    const mcp = await (await viaMcp("POST", `/api/projects/${projectId}/comments`, { content: doc("External sees MCP") })).json() as { id: string };
    const browser = await (await cookieRequest(`/api/projects/${projectId}/comments`, "POST", { content: doc("External sees browser") })).json() as { id: string };
    const response = await cookieRequest(`/api/projects/${projectId}/comments`, "GET", undefined, externalToken);
    expect(response.status).toBe(200);
    const list = await response.json() as { comments: Array<{ id: string; viaClient: string | null }> };
    expect(list.comments.find((comment) => comment.id === mcp.id)?.viaClient).toBe("Test Client");
    expect(list.comments.find((comment) => comment.id === browser.id)?.viaClient).toBeNull();
  });

  it("returns viaClient on the external create and edit responses", async () => {
    const created = await cookieRequest(`/api/projects/${projectId}/comments`, "POST", { content: doc("External authored") }, externalToken);
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; viaClient: string | null };
    expect(body.viaClient).toBeNull();
    const edited = await cookieRequest(`/api/projects/${projectId}/comments/${body.id}`, "PATCH", { content: doc("External edited") }, externalToken);
    expect(edited.status).toBe(200);
    expect((await edited.json() as { viaClient: string | null }).viaClient).toBeNull();
  });
});

describe("a subtask create and a Deadline set through MCP", () => {
  it("carry provenance on every audit and activity row they write", async () => {
    const subtaskMark = await maxRowids();
    const subtask = await viaMcp("POST", `/api/projects/${projectId}/subtasks`, { title: "Provenance subtask" });
    expect(subtask.status).toBe(201);
    const subtaskRows = await rowsSince(subtaskMark);
    const created = subtaskRows.audit.find((row) => row.action === "project_subtask.create");
    expect(created && metaOf(created)).toMatchObject({ via: "mcp", client: "Test Client" });

    const deadlineMark = await maxRowids();
    const deadline = await viaMcp("PUT", `/api/projects/${projectId}/deadline`, { expectedVersion: 0, deadline: { localCivil: "2037-01-15T09:00" }, reminderOffsetsMinutes: [60] });
    expect(deadline.status).toBe(200);
    const deadlineRows = await rowsSince(deadlineMark);
    const saved = deadlineRows.audit.find((row) => row.action === "project.deadline.schedule_saved");
    expect(saved && metaOf(saved)).toMatchObject({ via: "mcp", client: "Test Client" });
    expect(deadlineRows.activity.find((row) => row.event_type === "project.deadline.schedule_changed")?.via_client).toBe("Test Client");
    const fill = deadlineRows.audit.find((row) => row.action === "project.shoot_date.changed");
    expect(fill && metaOf(fill)).toMatchObject({ via: "mcp", client: "Test Client" });
  });
});

