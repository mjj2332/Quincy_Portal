import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { mcpHarness } from "./mcp-oauth-support";

/** #971: planning reads (Calendar, Gantt) and the caller's own notification preferences, all through /mcp. */

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b9710000-0000-4000-8000-000000000001";
const photographerId = "b9710000-0000-4000-8000-000000000002";
const externalId = "b9710000-0000-4000-8000-000000000003";
const assignedProject = "c9710000-0000-4000-8000-000000000001";
const otherProject = "c9710000-0000-4000-8000-000000000002";
const CLIENT = "Test Client";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};

const PLANNING_READS = ["get_production_calendar", "get_production_gantt"];
const range = "start=2037-03-01&end=2037-04-01";

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addUser(editorId, "editor"); await h.addUser(photographerId, "photographer"); await h.addUser(externalId, "external_editor");
  for (const [name, id] of [["admin", adminId], ["editor", editorId], ["photographer", photographerId], ["external", externalId]] as const) await h.addSession(name, id);
  const now = Date.now();
  for (const [id, street] of [[assignedProject, "Assigned Street"], [otherProject, "Other Street"]]) {
    await DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', '2037-03-10', ?, ?)").bind(id, street, now, now).run();
  }
  await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), assignedProject, externalId, now).run();
  tokens.adminReadOnly = await h.connect("read", "admin");
  for (const [name, scope] of [["admin", "read write"], ["editor", "read write"], ["photographer", "read write"], ["external", "read write"]] as const) tokens[name] = await h.connect(scope, name);
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const names = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name);
const text = (result?: { content: { text: string }[] }) => result!.content[0]!.text;

describe("tools/list", () => {
  it("offers the Calendar and Gantt only to roles that hold viewProductionCalendar", async () => {
    for (const who of ["admin", "editor", "external"]) for (const name of PLANNING_READS) expect(await names(who), `${who} ${name}`).toContain(name);
    for (const name of PLANNING_READS) expect(await names("photographer"), name).not.toContain(name);
  });
  it("offers the preference tools to every role; the update needs the write scope", async () => {
    for (const who of ["admin", "editor", "photographer", "external"]) {
      expect(await names(who), who).toEqual(expect.arrayContaining(["get_notification_preferences", "update_notification_preferences"]));
    }
    const readOnly = await h.toolsList(tokens.adminReadOnly!.accessToken);
    expect(readOnly.map((tool) => tool.name)).toContain("get_notification_preferences");
    expect(readOnly.map((tool) => tool.name)).not.toContain("update_notification_preferences");
    expect(readOnly.map((tool) => tool.name)).toContain("get_production_calendar");
  });
  it("annotates the reads read-only and the update as a non-destructive write", async () => {
    const list = await h.toolsList(tokens.admin!.accessToken) as { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[];
    for (const name of [...PLANNING_READS, "get_notification_preferences"]) expect(list.find((tool) => tool.name === name)!.annotations?.readOnlyHint, name).toBe(true);
    expect(list.find((tool) => tool.name === "update_notification_preferences")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("Calendar and Gantt match the cookie routes", () => {
  const calendarPath = `/api/production-calendar?${range}&date=2037-03-01&sub=month&scope=active&layers=project,checklist`;
  it("get_production_calendar returns the cookie route's body, for admin, editor and external", async () => {
    for (const who of ["admin", "editor", "external"]) {
      const cookie = await h.asCookie(who, calendarPath);
      expect(cookie.status, who).toBe(200);
      const call = await h.callTool(tokens[who]!.accessToken, "get_production_calendar", { start: "2037-03-01", end: "2037-04-01" });
      expect(call.result?.isError, who).toBeUndefined();
      expect(JSON.parse(text(call.result))).toEqual(await cookie.json());
    }
  });
  it("the External editor's Calendar carries only its assigned Project", async () => {
    const body = text((await h.callTool(tokens.external!.accessToken, "get_production_calendar", { start: "2037-03-01", end: "2037-04-01" })).result);
    expect(body).toContain("Assigned Street");
    expect(body).not.toContain("Other Street");
  });
  it("filters pass through: layers, q and flags", async () => {
    const path = `/api/production-calendar?${range}&date=2037-03-01&sub=month&scope=active&layers=project&q=Assigned&unassigned=1`;
    const cookie = await h.asCookie("admin", path);
    expect(cookie.status).toBe(200);
    const call = await h.callTool(tokens.admin!.accessToken, "get_production_calendar", { start: "2037-03-01", end: "2037-04-01", layers: "project", q: "Assigned", unassigned: true });
    expect(JSON.parse(text(call.result))).toEqual(await cookie.json());
  });
  it("a route refusal passes through verbatim (range over 42 days)", async () => {
    const call = await h.callTool(tokens.admin!.accessToken, "get_production_calendar", { start: "2037-03-01", end: "2037-06-01" });
    expect(call.result?.isError).toBe(true);
    expect(text(call.result)).toMatch(/^HTTP 400: .*calendar_query_invalid/s);
  });
  it("the archived scope stays admin only: an editor is refused by the route", async () => {
    const call = await h.callTool(tokens.editor!.accessToken, "get_production_calendar", { start: "2037-03-01", end: "2037-04-01", archived: "include" });
    expect(call.result?.isError).toBe(true);
    expect(text(call.result)).toMatch(/^HTTP 403/);
  });
  it("get_production_gantt returns the cookie route's body, for admin, editor and external", async () => {
    for (const who of ["admin", "editor", "external"]) {
      const cookie = await h.asCookie(who, "/api/production-gantt?scope=active&limit=50");
      expect(cookie.status, who).toBe(200);
      const call = await h.callTool(tokens[who]!.accessToken, "get_production_gantt", { limit: 50 });
      expect(call.result?.isError, who).toBeUndefined();
      expect(JSON.parse(text(call.result))).toEqual(await cookie.json());
    }
    const external = text((await h.callTool(tokens.external!.accessToken, "get_production_gantt", {})).result);
    expect(external).toContain("Assigned Street");
    expect(external).not.toContain("Other Street");
  });
  it("Gantt child pages pass childrenOf through", async () => {
    const cookie = await h.asCookie("admin", `/api/production-gantt?scope=active&childrenOf=${assignedProject}`);
    expect(cookie.status).toBe(200);
    const call = await h.callTool(tokens.admin!.accessToken, "get_production_gantt", { childrenOf: assignedProject });
    expect(JSON.parse(text(call.result))).toEqual(await cookie.json());
  });
  it("the tool refuses a role the route refuses, even when called by name", async () => {
    const calendar = await h.callTool(tokens.photographer!.accessToken, "get_production_calendar", { start: "2037-03-01", end: "2037-04-01" });
    expect(calendar.error ?? calendar.result?.isError).toBeTruthy();
    const gantt = await h.callTool(tokens.photographer!.accessToken, "get_production_gantt", {});
    expect(gantt.error ?? gantt.result?.isError).toBeTruthy();
  });
  it("refuses an unknown argument", async () => {
    const call = await h.callTool(tokens.admin!.accessToken, "get_production_gantt", { scope: "all" });
    expect(call.error ?? call.result?.isError).toBeTruthy();
  });
});

describe("own notification preferences", () => {
  const cookiePrefs = async (who: string) => (await (await h.asCookie(who, "/api/notification-preferences")).json()) as Record<string, unknown>;

  it("get_notification_preferences matches the cookie route, defaults included", async () => {
    for (const who of ["admin", "photographer", "external"]) {
      const call = await h.callTool(tokens[who]!.accessToken, "get_notification_preferences", {});
      expect(call.result?.isError, who).toBeUndefined();
      expect(JSON.parse(text(call.result))).toEqual(await cookiePrefs(who));
    }
  });

  it("update_notification_preferences changes only the caller's own row and is audited via mcp", async () => {
    const before = await cookiePrefs("admin");
    const mark = (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
    const call = await h.callTool(tokens.editor!.accessToken, "update_notification_preferences", { emailDigestCadence: "daily", subtaskReminderEmails: false });
    expect(call.result?.isError, text(call.result)).toBeUndefined();
    expect(JSON.parse(text(call.result))).toMatchObject({ emailDigestCadence: "daily", subtaskReminderEmails: false, projectDeadlineReminderEmails: true });
    expect(await cookiePrefs("editor")).toEqual(JSON.parse(text(call.result)));
    // nobody else's row moved
    expect(await cookiePrefs("admin")).toEqual(before);
    const rows = (await DB.prepare("SELECT actor_id, target_id, meta_json FROM audit_log WHERE rowid > ? AND action = 'notification.preference.update'").bind(mark).all<{ actor_id: string; target_id: string; meta_json: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: editorId, target_id: editorId });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, connectionId: tokens.editor!.connectionId });
  });

  it("a later call keeps the preferences it did not mention", async () => {
    await h.callTool(tokens.photographer!.accessToken, "update_notification_preferences", { includeProjectActivity: false });
    const call = await h.callTool(tokens.photographer!.accessToken, "update_notification_preferences", { projectDeadlineReminderEmails: false });
    expect(JSON.parse(text(call.result))).toMatchObject({ includeProjectActivity: false, projectDeadlineReminderEmails: false });
  });

  it("takes no user id: another person's row cannot be named", async () => {
    const call = await h.callTool(tokens.editor!.accessToken, "update_notification_preferences", { userId: adminId, emailDigestCadence: "hourly" });
    expect(call.error ?? call.result?.isError).toBeTruthy();
    expect((await cookiePrefs("admin")).emailDigestCadence).not.toBe("hourly");
  });

  it("an empty update is refused by the route, and a bad cadence by the schema", async () => {
    const empty = await h.callTool(tokens.editor!.accessToken, "update_notification_preferences", {});
    expect(empty.result?.isError).toBe(true);
    expect(text(empty.result)).toMatch(/^HTTP 400/);
    const bad = await h.callTool(tokens.editor!.accessToken, "update_notification_preferences", { emailDigestCadence: "weekly" });
    expect(bad.error ?? bad.result?.isError).toBeTruthy();
  });

  it("a read-only grant cannot update", async () => {
    const call = await h.callTool(tokens.adminReadOnly!.accessToken, "update_notification_preferences", { emailDigestCadence: "daily" });
    expect(call.error ?? call.result?.isError).toBeTruthy();
  });
});
