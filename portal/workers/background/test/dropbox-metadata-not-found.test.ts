import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDb } from "@quincy/db";
import { getMetadata, isDropboxPathNotFoundError } from "../src/dropbox/client";

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

const state = (id: string) => database.DB.prepare("SELECT status, last_error FROM integration_connections WHERE id = ?").bind(id).first<{ status: string; last_error: string | null }>();

describe("Dropbox get_metadata failures and the connection's sticky error", () => {
  it("leaves the connection healthy when a probed path does not exist, and still reports not_found to the caller", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "path/not_found/..", error: { ".tag": "path", path: { ".tag": "not_found" } } }), { status: 409 })));
    const error = await getMetadata(env as never, db, "/tonomo/raw files/gone", id, client).catch((caught: unknown) => caught);
    expect(isDropboxPathNotFoundError(error)).toBe(true);
    expect(await state(id)).toEqual({ status: "connected", last_error: null });
  });

  it("still marks the connection for any other get_metadata failure", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "path/restricted_content/.." }), { status: 409 })));
    await expect(getMetadata(env as never, db, "/restricted", id, client)).rejects.toThrow(/409/);
    expect(await state(id)).toMatchObject({ status: "error", last_error: expect.stringMatching(/^\[dropbox:configuration\] .*restricted_content/) });

    const unauthorised = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "missing_scope/.." }), { status: 401 })));
    await expect(getMetadata(env as never, db, "/x", unauthorised.id, unauthorised.client)).rejects.toThrow(/401/);
    expect((await state(unauthorised.id))?.status).toBe("error");
  });
});
