import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDb } from "@quincy/db";
import { listFolderRecursive } from "../src/dropbox/client";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };
const db = createDb(database.DB);

beforeAll(async () => {
  for (const chunk of __PORTAL_MIGRATION_SQL__.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
});

afterEach(() => vi.unstubAllGlobals());

async function connection() {
  const id = `connection-${crypto.randomUUID()}`;
  const now = Date.now();
  await database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(id, now, now).run();
  return { id, client: { connectionId: id, accessToken: "test-token" } };
}

describe("listFolderRecursive", () => {
  it("follows list_folder/continue until has_more is false and returns every entry", async () => {
    const { id, client } = await connection();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/files/list_folder")) {
        return new Response(JSON.stringify({
          entries: [{ ".tag": "folder", name: "0. Input", path_lower: "/root/0. input", id: "id:input" }],
          cursor: "cursor-1",
          has_more: true,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        entries: [{ ".tag": "file", name: "a.jpg", path_lower: "/root/0. input/a.jpg", id: "id:a", size: 1, server_modified: "2026-09-01T10:00:00Z" }],
        cursor: "cursor-2",
        has_more: false,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const entries = await listFolderRecursive(env as never, db, "id:root", id, client);
    expect(entries).toEqual([
      { ".tag": "folder", name: "0. Input", path_lower: "/root/0. input", path_display: undefined, id: "id:input" },
      { ".tag": "file", name: "a.jpg", path_lower: "/root/0. input/a.jpg", path_display: undefined, id: "id:a", size: 1, content_hash: undefined, server_modified: "2026-09-01T10:00:00Z" },
    ]);
    expect(calls).toEqual([
      "https://api.dropboxapi.com/2/files/list_folder",
      "https://api.dropboxapi.com/2/files/list_folder/continue",
    ]);
  });

  it("returns every entry from a single page without calling continue", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      entries: [{ ".tag": "file", name: "a.jpg", path_lower: "/root/a.jpg", id: "id:a", size: 1 }],
      cursor: "cursor-1",
      has_more: false,
    }), { status: 200 })));
    const entries = await listFolderRecursive(env as never, db, "id:root", id, client);
    expect(entries).toHaveLength(1);
  });
});
