import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { McpPrincipal } from "../src/lib/mcp-dispatch-context";
import type { McpFetchApp } from "../src/mcp/dispatch";
import { MCP_TOOLS } from "../src/mcp/tools/registry";

/**
 * Audit parity (#704, extended by #705): every write tool the MCP door lists must stamp provenance on every audit_log and
 * project_activity_events row it creates. Each call below drives the tool itself (so the route it dispatches to is the production
 * allowlist), and the completeness test fails when a write tool has neither a call nor a stated reason in NO_AUDIT_ROWS.
 * Later tickets (collaboration writes, admin) append to WRITE_CALLS and, only with a stated reason, to EXCEPTIONS.
 */

/** audit_log actions a write may create WITHOUT provenance, each with the reason. A listed action that never appears fails the run, so the list cannot go stale. */
const EXCEPTIONS: ReadonlyArray<{ action: string; reason: string }> = [
  { action: "project.deadline.automatic_set", reason: "System consequence (actor NULL, meta actor:system) of a fill or create. The person's own rows in the same batch carry provenance." },
];

const database = env as unknown as { DB: D1Database };
const testEnv = env as unknown as Env;
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b6000000-0000-4000-8000-000000000001";
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const fetchApp: McpFetchApp = (request, e, c) => app.fetch(request, e, c);
const principal: McpPrincipal = { userId: adminId, connectionId: "conn-parity", clientName: "Parity Client", authorizationEpoch: 0 };
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

type Setup = { projectId: string; [key: string]: string };
type WriteCall = {
  tool: string;
  stage?: string;
  archived?: boolean;
  /** Extra rows the call needs; returns ids the arguments can use. */
  setup?: (projectId: string) => Promise<Record<string, string>>;
  args: (ids: Setup) => Record<string, unknown>;
};

const insert = async (sql: string, ...bindings: unknown[]) => { await database.DB.prepare(sql).bind(...bindings).run(); };
const subtaskSetup = async (projectId: string) => {
  const created = async (title: string) => { const body = JSON.parse(await callTool("create_subtask", { projectId, title })) as { id?: string; subtask?: { id: string } }; return (body.subtask?.id ?? body.id)!; };
  return { subtaskId: await created("Parity"), otherId: await created("Other") };
};
const commentSetup = async (projectId: string) => {
  const created = JSON.parse(await callTool("add_project_comment", { projectId, text: "Seed" })) as { id: string };
  return { commentId: created.id };
};
const linkSetup = async (projectId: string) => {
  const first = JSON.parse(await callTool("add_video_link", { projectId, url: `https://example.test/${crypto.randomUUID()}` })) as { id: string };
  const second = JSON.parse(await callTool("add_video_link", { projectId, url: `https://example.test/${crypto.randomUUID()}` })) as { id: string };
  return { linkId: first.id, otherId: second.id };
};
const memberSetup = async (projectId: string) => {
  const membershipCycle = crypto.randomUUID();
  await insert("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)", membershipCycle, projectId, editorId, Date.now());
  return { membershipCycle };
};

const assetSetup = async (projectId: string) => {
  const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
  await insert("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)", collectionId, projectId, now, now);
  await insert("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'p.jpg', 10, 'upload', ?, ?)", assetId, collectionId, `parity/${assetId}.jpg`, now, now);
  return { assetId };
};
const annotationSetup = async (projectId: string) => {
  const { assetId } = await assetSetup(projectId);
  const created = JSON.parse(await callTool("create_annotation", { assetId, noteText: "Seed" })) as { id: string };
  return { assetId, annotationId: created.id };
};
const selectedSetup = async (projectId: string) => {
  const ids = await assetSetup(projectId);
  await callTool("select_asset_for_editing", ids);
  return ids;
};
const noticeSetup = async () => {
  const created = JSON.parse(await callTool("create_notice_post", { text: "Seed notice" })) as { post: { id: string } };
  return { postId: created.post.id };
};

const WRITE_CALLS: readonly WriteCall[] = [
  { tool: "create_project", args: () => ({ street: "Parity Created", shootDate: "2037-05-04" }) },
  { tool: "update_project_details", stage: "edited_review", args: ({ projectId }) => ({ projectId, suburb: "Parity", shootDate: "2037-06-01" }) },
  { tool: "set_project_priority", stage: "edited_review", args: ({ projectId }) => ({ projectId, priority: 2 }) },
  { tool: "set_project_deadline", stage: "edited_review", args: ({ projectId }) => ({ projectId, expectedVersion: 0, deadline: { localCivil: "2037-02-15T09:00" }, reminderOffsetsMinutes: [60] }) },
  { tool: "add_project_editor", stage: "edited_review", args: ({ projectId }) => ({ projectId, userId: editorId }) },
  { tool: "remove_project_editor", stage: "edited_review", setup: memberSetup, args: ({ projectId, membershipCycle }) => ({ projectId, userId: editorId, membershipCycle: membershipCycle! }) },
  { tool: "move_project_stage", stage: "awaiting_raw", args: ({ projectId }) => ({ projectId, expectedStageKey: "awaiting_raw", expectedBoardRevision: 0, targetStageKey: "raw_review" }) },
  { tool: "archive_project", stage: "edited_review", args: ({ projectId }) => ({ projectId }) },
  { tool: "restore_project", stage: "edited_review", archived: true, args: ({ projectId }) => ({ projectId }) },
  { tool: "create_subtask", stage: "edited_review", args: ({ projectId }) => ({ projectId, title: "Parity subtask" }) },
  { tool: "update_subtask", stage: "edited_review", setup: subtaskSetup, args: ({ projectId, subtaskId }) => ({ projectId, subtaskId: subtaskId!, title: "Renamed", done: true }) },
  { tool: "reorder_subtask", stage: "edited_review", setup: subtaskSetup, args: ({ projectId, subtaskId, otherId }) => ({ projectId, subtaskId: subtaskId!, beforeId: otherId!, afterId: null }) },
  { tool: "delete_subtask", stage: "edited_review", setup: subtaskSetup, args: ({ projectId, subtaskId }) => ({ projectId, subtaskId: subtaskId! }) },
  { tool: "add_project_comment", stage: "edited_review", args: ({ projectId }) => ({ projectId, text: "Parity comment" }) },
  { tool: "edit_project_comment", stage: "edited_review", setup: commentSetup, args: ({ projectId, commentId }) => ({ projectId, commentId: commentId!, text: "Edited" }) },
  { tool: "delete_project_comment", stage: "edited_review", setup: commentSetup, args: ({ projectId, commentId }) => ({ projectId, commentId: commentId! }) },
  { tool: "add_video_link", stage: "edited_review", args: ({ projectId }) => ({ projectId, url: "https://example.test/parity", label: "Parity" }) },
  { tool: "update_video_link", stage: "edited_review", setup: linkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, url: "https://example.test/parity-b" }) },
  { tool: "reorder_video_link", stage: "edited_review", setup: linkSetup, args: ({ projectId, linkId, otherId }) => ({ projectId, linkId: linkId!, beforeId: otherId!, afterId: null }) },
  { tool: "remove_video_link", stage: "edited_review", setup: linkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId! }) },
  { tool: "create_annotation", stage: "edited_review", setup: assetSetup, args: ({ assetId }) => ({ assetId: assetId!, noteText: "Parity note" }) },
  { tool: "edit_annotation", stage: "edited_review", setup: annotationSetup, args: ({ annotationId }) => ({ annotationId: annotationId!, noteText: "Edited" }) },
  { tool: "delete_annotation", stage: "edited_review", setup: annotationSetup, args: ({ annotationId }) => ({ annotationId: annotationId! }) },
  { tool: "create_notice_post", args: () => ({ text: "Parity notice" }) },
  { tool: "edit_notice_post", setup: noticeSetup, args: ({ postId }) => ({ postId: postId!, text: "Edited notice" }) },
  { tool: "delete_notice_post", setup: noticeSetup, args: ({ postId }) => ({ postId: postId! }) },
  { tool: "set_asset_review", stage: "edited_review", setup: assetSetup, args: ({ assetId }) => ({ assetId: assetId!, stars: 3 }) },
  { tool: "select_asset_for_editing", stage: "edited_review", setup: assetSetup, args: ({ assetId }) => ({ assetId: assetId! }) },
  { tool: "unselect_asset_for_editing", stage: "edited_review", setup: selectedSetup, args: ({ assetId }) => ({ assetId: assetId! }) },
  { tool: "request_project_link_preview", stage: "edited_review", args: ({ projectId }) => ({ projectId, url: "https://example.com/parity-preview" }) },
  { tool: "request_notice_link_preview", args: () => ({ url: "https://example.com/parity-notice-preview" }) },
];

/** Write tools whose route writes no audit_log or activity row at all (so there is nothing to stamp), each with the reason. */
const NO_AUDIT_ROWS: ReadonlyArray<{ tool: string; reason: string }> = [
  { tool: "mark_notification_read", reason: "The notifications read route only sets read_at; it writes no audit row." },
  { tool: "mark_all_notifications_read", reason: "The notifications read-all route only sets read_at; it writes no audit row." },
];

const mcpTool = (name: string) => MCP_TOOLS.find((tool) => tool.name === name)!;
async function callTool(name: string, args: Record<string, unknown>) {
  const result = await mcpTool(name).call({ env: testEnv, executionCtx: ctx, fetchApp, principal, role: "admin" }, args);
  expect(result.isError, `${name}: ${result.content[0]!.text}`).toBeUndefined();
  return result.content[0]!.text;
}
/** The background Worker's page fetch, answered locally: a link preview only writes its audit row once a page was fetched. */
const fakeBackground = { fetchLinkPreview: async () => ({ ok: true as const, finalUrl: "https://example.com/parity", title: "Parity", description: null, siteName: null, image: null }) };
async function callToolRaw(name: string, args: Record<string, unknown>) {
  const holder = testEnv as unknown as { BACKGROUND: unknown };
  const original = holder.BACKGROUND;
  if (name.endsWith("link_preview")) holder.BACKGROUND = fakeBackground;
  try { return await mcpTool(name).call({ env: testEnv, executionCtx: ctx, fetchApp, principal, role: "admin" }, args); }
  finally { holder.BACKGROUND = original; }
}

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
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Parity Editor', 'parity-editor@example.test', 1, 'editor', 1, ?, ?)").bind(editorId, now, now).run();
  await database.DB.batch([
    database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'"),
    database.DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES ('conn-parity', ?, 'client-1', 'Parity Client', 'client.example.test', '[\"write\"]', 0, ?)").bind(adminId, now),
    database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(now),
  ]);
});

describe("every row an MCP write creates carries provenance", () => {
  const seen = new Set<string>();

  it("covers every write tool", () => {
    const writes = MCP_TOOLS.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name).sort();
    expect([...WRITE_CALLS.map((call) => call.tool), ...NO_AUDIT_ROWS.map((entry) => entry.tool)].sort()).toEqual(writes);
  });

  for (const call of WRITE_CALLS) {
    it(call.tool, async () => {
      const projectId = crypto.randomUUID();
      const now = Date.now();
      await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'Parity Street', ?, 0, ?, ?, ?)").bind(projectId, call.stage ?? "edited_review", call.archived ? now : null, now, now).run();
      const ids: Setup = { projectId, ...(call.setup ? await call.setup(projectId) : {}) };
      const [auditMark, activityMark] = [await maxRowid("audit_log"), await maxRowid("project_activity_events")];
      const result = await callToolRaw(call.tool, call.args(ids));
      expect(result.isError, `${call.tool}: ${result.content[0]!.text}`).toBeUndefined();

      const audit = (await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? ORDER BY rowid").bind(auditMark).all<{ action: string; meta_json: string | null }>()).results;
      const activity = (await database.DB.prepare("SELECT event_type, via_client FROM project_activity_events WHERE rowid > ? ORDER BY rowid").bind(activityMark).all<{ event_type: string; via_client: string | null }>()).results;
      expect(audit.length, `${call.tool}: audit rows`).toBeGreaterThan(0);
      const covered = audit.filter((row) => !EXCEPTIONS.some((exception) => exception.action === row.action));
      expect(covered.length).toBeGreaterThan(0);
      for (const row of audit) {
        if (EXCEPTIONS.some((exception) => exception.action === row.action)) { seen.add(row.action); continue; }
        const meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {};
        expect(meta, `${call.tool}: audit ${row.action}`).toMatchObject({ via: "mcp", client: "Parity Client", connectionId: "conn-parity" });
      }
      for (const row of activity) expect(row.via_client, `${call.tool}: activity ${row.event_type}`).toBe("Parity Client");
    });
  }

  it("lists no exception that no call exercised", () => {
    expect([...seen].sort()).toEqual(EXCEPTIONS.map((exception) => exception.action).sort());
  });
});
