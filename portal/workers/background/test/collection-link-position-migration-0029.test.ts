import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

declare const __PORTAL_MIGRATION_SQL_BEFORE_0029__: string;
declare const __PORTAL_MIGRATION_0029_SQL__: string;
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

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL_BEFORE_0029__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('project', 'Migration', 'editing_autohdr', ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES ('video', 'project', 'video', 'received', 3, ?, ?), ('copy', 'project', 'copy', 'received', 2, ?, ?)").bind(now, now, now, now),
    database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, created_at, updated_at) VALUES ('video-c', 'video', 'https://example.test/c', NULL, 'manual', 200, 200), ('video-b', 'video', 'https://example.test/b', NULL, 'tonomo', 100, 100), ('video-a', 'video', 'https://example.test/a', NULL, 'manual', 100, 100), ('copy-b', 'copy', 'https://example.test/copy-b', NULL, 'manual', 300, 300), ('copy-a', 'copy', 'https://example.test/copy-a', NULL, 'manual', 50, 50)").bind(),
  ]);
  await executeSql(__PORTAL_MIGRATION_0029_SQL__);
});

describe("migration 0029", () => {
  it("backfills every collection independently in deterministic created_at, id order", async () => {
    const rows = await database.DB.prepare("SELECT collection_id, id, position FROM collection_links ORDER BY collection_id, position, id").all<{ collection_id: string; id: string; position: number }>();
    expect(rows.results).toEqual([
      { collection_id: "copy", id: "copy-a", position: 1024 },
      { collection_id: "copy", id: "copy-b", position: 2048 },
      { collection_id: "video", id: "video-a", position: 1024 },
      { collection_id: "video", id: "video-b", position: 2048 },
      { collection_id: "video", id: "video-c", position: 3072 },
    ]);
  });
});
