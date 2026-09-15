import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { processTonomoEvent, type TonomoProcessDependencies } from "../src/tonomo/process";
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

  it("does not overwrite an already-canonical shoot date with a different canonical incoming value", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "2026-09-17" });
    await processEvent(orderId, { when: { start_time: 1_789_516_800 }, property_address: { timezone: "UTC" } });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-09-17" });
  });

  it("upgrades a display shoot date when the event's only date is itself display text that now parses to ISO", async () => {
    const { projectId, orderId } = await seedProject({ shootDate: "Thursday, 17 Sep, 2026" });
    await processEvent(orderId, { date: "Saturday, 14 Feb, 2026" });
    expect(await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first())
      .toEqual({ shoot_date: "2026-02-14" });
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
