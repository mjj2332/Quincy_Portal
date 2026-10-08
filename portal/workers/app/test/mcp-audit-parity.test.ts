import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { McpPrincipal } from "../src/lib/mcp-dispatch-context";
import { dispatchToApi, type McpFetchApp } from "../src/mcp/dispatch";

/**
 * Audit parity (#704, plan #699 ticket 4): every write the MCP door can reach must stamp provenance on every audit_log and
 * project_activity_events row it creates. Later tickets (core writes, collaboration writes, admin) append to WRITE_CALLS and,
 * only with a stated reason, to EXCEPTIONS.
 *
 * Test-local allowlist override: the production list is NOT widened here. Add the route to ROUTES below when adding a call.
 */
const { ROUTES } = vi.hoisted(() => ({
  ROUTES: [
    ["POST", "/api/projects/[A-Za-z0-9_-]+/comments"],
    ["POST", "/api/projects/[A-Za-z0-9_-]+/subtasks"],
    ["PUT", "/api/projects/[A-Za-z0-9_-]+/deadline"],
    ["POST", "/api/projects/[A-Za-z0-9_-]+/stage"],
  ] as ReadonlyArray<readonly [method: string, pattern: string]>,
}));
vi.mock("../src/mcp/route-allowlist", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mcp/route-allowlist")>();
  return { ...original, isAllowedMcpRoute: (method: string, path: string) => original.isAllowedMcpRoute(method, path) || ROUTES.some(([m, p]) => m === method && new RegExp(`^${p}$`).test(path)) };
});

/** audit_log actions a write may create WITHOUT provenance, each with the reason. A listed action that never appears fails the run, so the list cannot go stale. */
const EXCEPTIONS: ReadonlyArray<{ action: string; reason: string }> = [
  { action: "project.deadline.automatic_set", reason: "System consequence (actor NULL, meta actor:system) of a fill or create. The person's own rows in the same batch carry provenance." },
];

const database = env as unknown as { DB: D1Database };
const testEnv = env as unknown as Env;
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const fetchApp: McpFetchApp = (request, e, c) => app.fetch(request, e, c);
const principal: McpPrincipal = { userId: adminId, connectionId: "conn-parity", clientName: "Parity Client", authorizationEpoch: 0 };
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

type WriteCall = { name: string; stage: string; request: (projectId: string) => { method: string; path: string; body: unknown } };
const WRITE_CALLS: readonly WriteCall[] = [
  { name: "comment create", stage: "edited_review", request: (id) => ({ method: "POST", path: `/api/projects/${id}/comments`, body: { content: doc("Parity comment") } }) },
  { name: "subtask create", stage: "edited_review", request: (id) => ({ method: "POST", path: `/api/projects/${id}/subtasks`, body: { title: "Parity subtask" } }) },
  { name: "deadline set", stage: "edited_review", request: (id) => ({ method: "PUT", path: `/api/projects/${id}/deadline`, body: { expectedVersion: 0, deadline: { localCivil: "2037-02-15T09:00" }, reminderOffsetsMinutes: [60] } }) },
  { name: "stage move leaving Awaiting RAW", stage: "awaiting_raw", request: (id) => ({ method: "POST", path: `/api/projects/${id}/stage`, body: { expected: { stageKey: "awaiting_raw", boardRevision: 0 }, targetStageKey: "raw_review", placement: { kind: "append" }, confirmation: { reasons: [] } } }) },
];

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

const maxRowid = async (table: "audit_log" | "project_activity_events") =>
  (await database.DB.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'"),
    database.DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES ('conn-parity', ?, 'client-1', 'Parity Client', 'client.example.test', '[\"write\"]', 0, ?)").bind(adminId, now),
    database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(now),
  ]);
});

describe("every row an MCP write creates carries provenance", () => {
  const seen = new Set<string>();

  for (const call of WRITE_CALLS) {
    it(call.name, async () => {
      const projectId = crypto.randomUUID();
      const now = Date.now();
      await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, created_at, updated_at) VALUES (?, 'Parity Street', ?, 0, ?, ?)").bind(projectId, call.stage, now, now).run();
      const [auditMark, activityMark] = [await maxRowid("audit_log"), await maxRowid("project_activity_events")];
      const request = call.request(projectId);
      expect(ROUTES.some(([method, pattern]) => method === request.method && new RegExp(`^${pattern}$`).test(request.path))).toBe(true);
      const response = await dispatchToApi(fetchApp, testEnv, ctx, principal, request);
      expect(response.status, await response.clone().text()).toBeLessThan(300);

      const audit = (await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? ORDER BY rowid").bind(auditMark).all<{ action: string; meta_json: string | null }>()).results;
      const activity = (await database.DB.prepare("SELECT event_type, via_client FROM project_activity_events WHERE rowid > ? ORDER BY rowid").bind(activityMark).all<{ event_type: string; via_client: string | null }>()).results;
      expect(audit.length).toBeGreaterThan(0);
      const covered = audit.filter((row) => !EXCEPTIONS.some((exception) => exception.action === row.action));
      expect(covered.length).toBeGreaterThan(0);
      for (const row of audit) {
        if (EXCEPTIONS.some((exception) => exception.action === row.action)) { seen.add(row.action); continue; }
        const meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {};
        expect(meta, `${call.name}: audit ${row.action}`).toMatchObject({ via: "mcp", client: "Parity Client", connectionId: "conn-parity" });
      }
      for (const row of activity) expect(row.via_client, `${call.name}: activity ${row.event_type}`).toBe("Parity Client");
    });
  }

  it("lists no exception that no call exercised", () => {
    expect([...seen].sort()).toEqual(EXCEPTIONS.map((exception) => exception.action).sort());
  });
});
