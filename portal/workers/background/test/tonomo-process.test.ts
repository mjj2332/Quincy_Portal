import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { processTonomoEvent, type TonomoProcessDependencies } from "../src/tonomo/process";
import { commitShootDateChange } from "../src/projects/shoot-date";
import type { DropboxFile, DropboxFolder } from "../src/dropbox/client";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));

describe("processTonomoEvent collection links", () => {
  it("appends a delivered Tonomo link, dedupes redelivery, and reconciles its collection count", async () => {
    const suffix = crypto.randomUUID(); const projectId = crypto.randomUUID(); const collectionId = crypto.randomUUID(); const eventId = crypto.randomUUID(); const orderId = `order-${suffix}`; const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, order_id, street, stage_key, created_at, updated_at) VALUES (?, ?, ?, 'awaiting_raw', ?, ?)").bind(projectId, orderId, "Tonomo writer test", now, now),
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'received', 1, ?, ?)").bind(collectionId, projectId, now, now),
      database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, 'https://example.test/manual', 'Manual', 'manual', 1024, ?, ?)").bind(crypto.randomUUID(), collectionId, now, now),
      database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)").bind(eventId, `event-${suffix}`, JSON.stringify({ id: orderId, street: "Tonomo writer test", services: [{ service: "Video", url: "https://example.test/tonomo" }] }), now),
    ]);
    const event = { id: eventId, payloadJson: JSON.stringify({ id: orderId, street: "Tonomo writer test", services: [{ service: "Video", url: "https://example.test/tonomo" }] }) };
    await processTonomoEvent(env, event);
    expect(await database.DB.prepare("SELECT source, position FROM collection_links WHERE collection_id = ? AND url = ?").bind(collectionId, "https://example.test/tonomo").first()).toEqual({ source: "tonomo", position: 2048 });
    expect(await database.DB.prepare("SELECT received_count, status FROM collections WHERE id = ?").bind(collectionId).first()).toEqual({ received_count: 2, status: "received" });
    await processTonomoEvent(env, event);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM collection_links WHERE collection_id = ? AND url = ?").bind(collectionId, "https://example.test/tonomo").first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(collectionId).first()).toEqual({ received_count: 2 });
  });
});

describe("processTonomoEvent shootDate upgrade", () => {
  async function seedProject(overrides: { shootDate: string | null; agentName?: string | null }) {
    const suffix = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const orderId = `order-${suffix}`;
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO projects (id, order_id, street, stage_key, shoot_date, agent_name, created_at, updated_at) VALUES (?, ?, ?, 'awaiting_raw', ?, ?, ?, ?)",
    ).bind(projectId, orderId, "Tonomo shoot date test", overrides.shootDate, overrides.agentName ?? null, now, now).run();
    return { projectId, orderId, now };
  }

  async function processEvent(orderId: string, order: Record<string, unknown>) {
    const eventId = crypto.randomUUID();
    const payloadJson = JSON.stringify({ id: orderId, street: "Tonomo shoot date test", ...order });
    await database.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)",
    ).bind(eventId, `event-${eventId}`, payloadJson, Date.now()).run();
    await processTonomoEvent(env, { id: eventId, payloadJson });
  }

  it("upgrades a display shoot date to ISO when the event carries when.start_time", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "Thursday, 17 Sep, 2026" });
    await processEvent(orderId, { when: { start_time: 1_789_516_800 }, property_address: { timezone: "UTC" } });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-16" });
  });

  it("does not overwrite an already-canonical shoot date with a different incoming value", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(orderId, { date: "Monday, 17 Sep, 2026" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-17" });
  });

  it("moves an already-canonical shoot date when the event's when.start_time names a different day, with a fenced audit row", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(orderId, { when: { start_time: 1_789_516_800 }, property_address: { timezone: "UTC" } });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-16" });
    const changed = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_type = 'project' AND target_id = ? AND action = 'project.shoot_date.changed'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>();
    expect(changed.results).toHaveLength(1);
    expect(changed.results[0]!.actor_id).toBeNull();
    expect(JSON.parse(changed.results[0]!.meta_json)).toMatchObject({ actor: "tonomo", orderId, previousShootDate: "2026-09-17", shootDate: "2026-09-16", eventReceivedAt: expect.any(Number) });
  });

  it("upgrades a display shoot date when the event's only date is itself display text that now parses to ISO", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "Thursday, 17 Sep, 2026" });
    await processEvent(orderId, { date: "Saturday, 14 Feb, 2026" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-02-14" });
  });

  it("moves a canonical shoot date from weekday-checked display text and from ISO text", async () => {
    const display = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(display.orderId, { date: "Saturday, 14 Feb, 2026" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(display.projectId).first())
      .toEqual({ shoot_date: "2026-02-14" });
    const iso = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(iso.orderId, { shoot_date: "2026-09-18" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(iso.projectId).first())
      .toEqual({ shoot_date: "2026-09-18" });
  });

  it("declines unparsed shoot date text against a canonical date, records why once, and moves nothing", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(orderId, { date: "Monday, 17 Sep, 2026" });
    await processEvent(orderId, { date: "Monday, 17 Sep, 2026" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-17" });
    const declined = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE target_type = 'project' AND target_id = ? AND action = 'project.shoot_date.declined'").bind(projectId).all<{ meta_json: string }>();
    expect(declined.results).toHaveLength(1);
    expect(JSON.parse(declined.results[0]!.meta_json)).toEqual({
      actor: "tonomo", orderId, storedShootDate: "2026-09-17", incomingShootDate: "Monday, 17 Sep, 2026",
      reason: "incoming shoot date is unparsed text, not a verified calendar date; keeping stored date",
    });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.shoot_date.changed'").bind(projectId).first())
      .toEqual({ count: 0 });
  });

  it("ignores a redelivered older event whose date predates the last accepted change", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(orderId, { shoot_date: "2026-09-20" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-20" });
    const staleId = crypto.randomUUID();
    const stalePayload = JSON.stringify({ id: orderId, street: "Tonomo shoot date test", shoot_date: "2026-09-18" });
    await database.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)",
    ).bind(staleId, `event-${staleId}`, stalePayload, Date.now() - 60_000).run();
    await processTonomoEvent(env, { id: staleId, payloadJson: stalePayload });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-20" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.shoot_date.changed'").bind(projectId).first())
      .toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT status FROM webhook_events WHERE id = ?").bind(staleId).first())
      .toEqual({ status: "processed" });
  });

  it("writes neither the date nor an audit row when the stored date changed after the processor read it", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-09-25' WHERE id = ?").bind(projectId).run();
    expect(await commitShootDateChange(env as never, { projectId, orderId, previous: "2026-09-17", next: "2026-09-18", receivedAt: new Date() })).toBe(false);
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-25" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.shoot_date.changed'").bind(projectId).first())
      .toEqual({ count: 0 });
  });

  it("still applies a newer event processed after an older one, because the guard compares receipt times", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    const store = async (date: string, receivedAt: number) => {
      const id = crypto.randomUUID();
      const payloadJson = JSON.stringify({ id: orderId, street: "Tonomo shoot date test", shoot_date: date });
      await database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)").bind(id, `event-${id}`, payloadJson, receivedAt).run();
      return { id, payloadJson };
    };
    const older = await store("2026-09-18", Date.now() - 120_000);
    const newer = await store("2026-09-19", Date.now() - 60_000);
    await processTonomoEvent(env, older);
    await processTonomoEvent(env, newer);
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-19" });
  });

  it("does not let a shoot date event overwrite another already-set snapshot field", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "Thursday, 17 Sep, 2026", agentName: "Original Agent" });
    await processEvent(orderId, { when: { start_time: 1_789_516_800 }, property_address: { timezone: "UTC" }, agent_name: "New Agent" });
    expect(await database.DB.prepare("SELECT shoot_date, agent_name FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-16", agent_name: "Original Agent" });
  });
});

describe("processTonomoEvent RAW folder path update", () => {
  const STORED_RAW_FOLDER_PATH = "/tonomo/raw files/igor melo/04-09-2026/72 victoria st, paddington nsw 2021, australia";
  const NEWER_RAW_FOLDER_PATH = "/tonomo/raw files/christian quinlan/15-09-2026/72 victoria st, paddington nsw 2021, australia";
  const DIFFERENT_ADDRESS_RAW_FOLDER_PATH = "/tonomo/raw files/christian quinlan/15-09-2026/9 smith st, redfern nsw 2016, australia";

  async function seedProject(overrides: { rawFolderPath: string | null; rawFolderLink?: string | null }) {
    const suffix = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const orderId = `order-${suffix}`;
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO projects (id, order_id, street, stage_key, raw_folder_path, raw_folder_link, created_at, updated_at) VALUES (?, ?, ?, 'awaiting_raw', ?, ?, ?, ?)",
    ).bind(projectId, orderId, "72 Victoria St, Paddington NSW 2021, Australia", overrides.rawFolderPath, overrides.rawFolderLink ?? null, now, now).run();
    return { projectId, orderId, now };
  }

  async function seedDropboxConnection() {
    const connectionId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)",
    ).bind(connectionId, now, now).run();
    return connectionId;
  }

  async function seedReadyEditorMapping(projectId: string) {
    const now = Date.now();
    const root = `/Editor/01_ACTIVE EDITS/${projectId}`;
    const connectionId = await seedDropboxConnection();
    await database.DB.prepare(
      "INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name, photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'id:root', '2026-09-15', ?, '{}', '[]', '[]', ?, 'ready', ?, ?)",
    ).bind(crypto.randomUUID(), projectId, connectionId, root, root.toLowerCase(), projectId, `${root}/Editing Notes`, now, now).run();
  }

  async function processEvent(orderId: string, order: Record<string, unknown>, dependencies?: TonomoProcessDependencies) {
    const eventId = crypto.randomUUID();
    const payloadJson = JSON.stringify({ id: orderId, street: "72 Victoria St, Paddington NSW 2021, Australia", ...order });
    await database.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)",
    ).bind(eventId, `event-${eventId}`, payloadJson, Date.now()).run();
    await processTonomoEvent(env, { id: eventId, payloadJson }, dependencies);
  }

  it("adopts a newer Tonomo path once Dropbox confirms it is a folder", async () => {
    await seedDropboxConnection();
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH, rawFolderLink: "https://www.dropbox.com/scl/fo/old" });
    const getMetadata = async (_env: unknown, _db: unknown, path: string): Promise<DropboxFile | DropboxFolder> => ({
      ".tag": "folder",
      id: "id:new",
      name: "72 victoria st, paddington nsw 2021, australia",
      path_lower: path.toLowerCase(),
      path_display: NEWER_RAW_FOLDER_PATH,
    });
    await processEvent(orderId, { rawFolderPath: NEWER_RAW_FOLDER_PATH, rawFolderLink: "https://www.dropbox.com/scl/fo/new" }, { getMetadata });

    expect(await database.DB.prepare("SELECT raw_folder_path, raw_folder_link FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: NEWER_RAW_FOLDER_PATH, raw_folder_link: "https://www.dropbox.com/scl/fo/new" });

    const auditRow = await database.DB.prepare(
      "SELECT meta_json FROM audit_log WHERE target_type = 'project' AND target_id = ? AND action = 'project.raw_folder_path.changed'",
    ).bind(projectId).first<{ meta_json: string }>();
    expect(auditRow).toBeTruthy();
    const meta = JSON.parse(auditRow!.meta_json);
    expect(meta.previousRawFolderPath).toBe(STORED_RAW_FOLDER_PATH);
    expect(meta.rawFolderPath).toBe(NEWER_RAW_FOLDER_PATH);
    expect(meta.orderId).toBe(orderId);

    expect(await database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(projectId).first())
      .toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ? AND kind = 'autohdr_scaffold'").bind(projectId).first())
      .toEqual({ count: 1 });
  });

  it("keeps the stored path when Tonomo's newer path does not exist in Dropbox (Rosemont)", async () => {
    await seedDropboxConnection();
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH });
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => {
      throw new Error("Dropbox files/get_metadata failed (409): {\"error_summary\": \"path/not_found/...\"}");
    };
    await processEvent(orderId, { rawFolderPath: NEWER_RAW_FOLDER_PATH }, { getMetadata });

    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_type = 'project' AND target_id = ? AND action = 'project.raw_folder_path.changed'").bind(projectId).first())
      .toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(projectId).first())
      .toEqual({ count: 0 });
    const declined = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE target_type = 'project' AND target_id = ? AND action = 'project.raw_folder_path.declined'").bind(projectId).first<{ meta_json: string }>();
    expect(JSON.parse(declined!.meta_json)).toMatchObject({ actor: "tonomo", orderId, storedPath: STORED_RAW_FOLDER_PATH, incomingPath: NEWER_RAW_FOLDER_PATH, reason: "Tonomo path not found in Dropbox; keeping stored path" });
    // A redelivered webhook with the same path and reason adds no second audit row.
    await processEvent(orderId, { rawFolderPath: NEWER_RAW_FOLDER_PATH }, { getMetadata });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.raw_folder_path.declined'").bind(projectId).first())
      .toEqual({ count: 1 });
  });

  it("keeps the stored path when Tonomo's newer path exists but is a file, not a folder", async () => {
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH });
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => ({
      ".tag": "file", id: "id:file", name: "x.jpg", path_lower: NEWER_RAW_FOLDER_PATH, path_display: NEWER_RAW_FOLDER_PATH,
    } as unknown as DropboxFile);
    await processEvent(orderId, { rawFolderPath: NEWER_RAW_FOLDER_PATH }, { getMetadata });
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(projectId).first())
      .toEqual({ count: 0 });
    const declined = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE target_id = ? AND action = 'project.raw_folder_path.declined'").bind(projectId).first<{ meta_json: string }>();
    expect(JSON.parse(declined!.meta_json)).toMatchObject({ reason: "Tonomo path is not a folder in Dropbox; keeping stored path" });
  });

  it("completes the event without mutation when Dropbox fails for a reason other than not_found", async () => {
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH });
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => {
      throw new Error("Dropbox request failed (503)", { cause: new Error("upstream unavailable") });
    };
    await processEvent(orderId, { rawFolderPath: NEWER_RAW_FOLDER_PATH, agentName: "Survived" }, { getMetadata });
    expect(await database.DB.prepare("SELECT raw_folder_path, agent_name FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH, agent_name: "Survived" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(projectId).first())
      .toEqual({ count: 0 });
    // A transient failure is retried by the webhook, so it is not written to the audit trail.
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.raw_folder_path.declined'").bind(projectId).first())
      .toEqual({ count: 0 });
  });

  it("declines a path whose address leaf only gained a Tonomo suffix, because Editor and AutoHDR names derive from the leaf", async () => {
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH });
    let calls = 0;
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => { calls += 1; throw new Error("unreachable"); };
    await processEvent(orderId, { rawFolderPath: `${NEWER_RAW_FOLDER_PATH} 2` }, { getMetadata });
    expect(calls).toBe(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH });
  });

  it("keeps the stored path when the Editor mapping is ready", async () => {
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH });
    await seedReadyEditorMapping(projectId);
    let calls = 0;
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => {
      calls += 1;
      throw new Error("getMetadata should not be called when the Editor mapping is ready");
    };
    await processEvent(orderId, { rawFolderPath: NEWER_RAW_FOLDER_PATH }, { getMetadata });

    expect(calls).toBe(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH });
    const declined = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE target_id = ? AND action = 'project.raw_folder_path.declined'").bind(projectId).first<{ meta_json: string }>();
    expect(JSON.parse(declined!.meta_json)).toMatchObject({ reason: "editor mapping ready; RAW intake already moved to the Editor tree" });
  });

  it("keeps the stored path when the address leaf changed", async () => {
    const { projectId, orderId } = await seedProject({ rawFolderPath: STORED_RAW_FOLDER_PATH });
    let calls = 0;
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => {
      calls += 1;
      throw new Error("getMetadata should not be called when the address leaf changed");
    };
    await processEvent(orderId, { rawFolderPath: DIFFERENT_ADDRESS_RAW_FOLDER_PATH }, { getMetadata });

    expect(calls).toBe(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH });
  });

  it("still fills a null path without verification", async () => {
    const { projectId, orderId } = await seedProject({ rawFolderPath: null });
    let calls = 0;
    const getMetadata = async (): Promise<DropboxFile | DropboxFolder> => {
      calls += 1;
      throw new Error("getMetadata should not be called when filling a previously null path");
    };
    await processEvent(orderId, { rawFolderPath: STORED_RAW_FOLDER_PATH }, { getMetadata });

    expect(calls).toBe(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ raw_folder_path: STORED_RAW_FOLDER_PATH });
  });
});

describe("processTonomoEvent create — default editors (#135)", () => {
  async function insertUser(id: string, name: string, email: string, role: "admin" | "photographer" | "editor" | "external_editor", active: boolean, defaultEditor: boolean) {
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, active, default_editor, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
    ).bind(id, name, email, role, active ? 1 : 0, defaultEditor ? 1 : 0, now, now).run();
  }

  async function processCreateEvent(order: Record<string, unknown>): Promise<{ orderId: string; projectId: string }> {
    const suffix = crypto.randomUUID();
    const orderId = `order-${suffix}`;
    const street = `${suffix} Default Editor Ave`;
    const eventId = crypto.randomUUID();
    const payloadJson = JSON.stringify({ id: orderId, street, ...order });
    await database.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)",
    ).bind(eventId, `event-${eventId}`, payloadJson, Date.now()).run();
    await processTonomoEvent(env, { id: eventId, payloadJson });
    const project = await database.DB.prepare("SELECT id FROM projects WHERE order_id = ?").bind(orderId).first<{ id: string }>();
    return { orderId, projectId: project!.id };
  }

  it("adds every flagged, active, editor-eligible user as an editor with audit + outbox + ledger provenance", async () => {
    const flaggedEditorId = crypto.randomUUID();
    const flaggedAdminId = crypto.randomUUID();
    const unflaggedEditorId = crypto.randomUUID();
    const flaggedInactiveEditorId = crypto.randomUUID();
    const flaggedPhotographerId = crypto.randomUUID();
    await insertUser(flaggedEditorId, "TB135 Tonomo Flagged Editor", `tb135-tonomo-editor-${flaggedEditorId}@example.test`, "editor", true, true);
    await insertUser(flaggedAdminId, "TB135 Tonomo Flagged Admin", `tb135-tonomo-admin-${flaggedAdminId}@example.test`, "admin", true, true);
    await insertUser(unflaggedEditorId, "TB135 Tonomo Unflagged Editor", `tb135-tonomo-unflagged-${unflaggedEditorId}@example.test`, "editor", true, false);
    await insertUser(flaggedInactiveEditorId, "TB135 Tonomo Inactive Editor", `tb135-tonomo-inactive-${flaggedInactiveEditorId}@example.test`, "editor", false, true);
    await insertUser(flaggedPhotographerId, "TB135 Tonomo Flagged Photographer", `tb135-tonomo-photographer-${flaggedPhotographerId}@example.test`, "photographer", true, true);

    const before = Date.now();
    const { orderId, projectId } = await processCreateEvent({});

    // The project row itself still goes in with ms timestamps, awaiting_raw, a stage-bottom position and revision 0.
    const created = await database.DB.prepare("SELECT stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?").bind(projectId).first<{ stageKey: string; boardPosition: number; boardRevision: number; createdAt: number; updatedAt: number }>();
    const maxOther = await database.DB.prepare("SELECT COALESCE(MAX(board_position), -1024) AS maxPosition FROM projects WHERE stage_key = 'awaiting_raw' AND archived_at IS NULL AND id != ?").bind(projectId).first<{ maxPosition: number }>();
    expect(created).toMatchObject({ stageKey: "awaiting_raw", boardRevision: 0, boardPosition: maxOther!.maxPosition + 1024 });
    expect(created!.createdAt).toBeGreaterThanOrEqual(before);
    expect(created!.updatedAt).toBe(created!.createdAt);

    for (const userId of [flaggedEditorId, flaggedAdminId]) {
      const membership = await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, userId).first<{ id: string }>();
      expect(membership).not.toBeNull();
      const auditRow = await database.DB.prepare("SELECT actor_id AS actorId, meta_json AS metaJson FROM audit_log WHERE action = 'project.member.add' AND target_type = 'project_member' AND target_id = ?").bind(membership!.id).first<{ actorId: string | null; metaJson: string }>();
      expect(auditRow?.actorId).toBeNull();
      expect(JSON.parse(auditRow!.metaJson)).toMatchObject({ actor: "tonomo", source: "default_editor", orderId, projectId, userId, roleOnProject: "editor", membershipCycle: membership!.id });
      const outboxRow = await database.DB.prepare("SELECT id, actor_id AS actorId, event_type AS eventType FROM notification_outbox WHERE project_id = ? AND recipient_id = ? AND event_type = 'project.assignment.created'").bind(projectId, userId).first<{ id: string; actorId: string; eventType: string }>();
      expect(outboxRow).not.toBeNull();
      expect(outboxRow!.actorId).toBe("00000000-0000-4000-8000-000000000000");
      const ledgerRows = await database.DB.prepare("SELECT channel FROM notification_delivery_ledger WHERE outbox_id = ?").bind(outboxRow!.id).all<{ channel: string }>();
      expect(ledgerRows.results.map((row) => row.channel).sort()).toEqual(["email", "in_app"]);
      const activityRow = await database.DB.prepare("SELECT id FROM project_activity_events WHERE project_id = ? AND source_id = ?").bind(projectId, membership!.id).first();
      expect(activityRow).toBeNull();
    }

    const notAdded = await database.DB.prepare(
      "SELECT user_id AS userId FROM project_members WHERE project_id = ? AND role_on_project = 'editor' AND user_id IN (?, ?, ?)",
    ).bind(projectId, unflaggedEditorId, flaggedInactiveEditorId, flaggedPhotographerId).all<{ userId: string }>();
    expect(notAdded.results).toEqual([]);
  });

  it("does not re-add a default editor removed from an existing project on update", async () => {
    const flaggedEditorId = crypto.randomUUID();
    await insertUser(flaggedEditorId, "TB135 Tonomo Update Editor", `tb135-tonomo-update-${flaggedEditorId}@example.test`, "editor", true, true);
    const { orderId, projectId } = await processCreateEvent({});
    const membership = await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, flaggedEditorId).first<{ id: string }>();
    expect(membership).not.toBeNull();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(membership!.id).run();

    const eventId = crypto.randomUUID();
    const payloadJson = JSON.stringify({ id: orderId, street: "An updated street name", notes: "trigger an update" });
    await database.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)",
    ).bind(eventId, `event-${eventId}`, payloadJson, Date.now()).run();
    await processTonomoEvent(env, { id: eventId, payloadJson });

    const stillMissing = await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, flaggedEditorId).first();
    expect(stillMissing).toBeNull();
  });

  it("does not add default editors when an order links to an existing project by address (update path)", async () => {
    const flaggedEditorId = crypto.randomUUID();
    await insertUser(flaggedEditorId, "TB135 Tonomo Address Link Editor", `tb135-tonomo-address-${flaggedEditorId}@example.test`, "editor", true, true);
    const projectId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?)",
    ).bind(projectId, "1 Address Link Way", now, now).run();
    const eventId = crypto.randomUUID();
    const orderId = `order-${crypto.randomUUID()}`;
    const payloadJson = JSON.stringify({ id: orderId, street: "1 Address Link Way" });
    await database.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)",
    ).bind(eventId, `event-${eventId}`, payloadJson, Date.now()).run();
    await processTonomoEvent(env, { id: eventId, payloadJson });

    const linked = await database.DB.prepare("SELECT order_id AS orderId FROM projects WHERE id = ?").bind(projectId).first<{ orderId: string }>();
    expect(linked?.orderId).toBe(orderId);
    const membership = await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, flaggedEditorId).first();
    expect(membership).toBeNull();
  });
});
