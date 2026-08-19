import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { processTonomoEvent } from "../src/tonomo/process";

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
