import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDb } from "@quincy/db";
import { DropboxPathNotFoundError, DropboxRelocationConflictError, getMetadata, isDropboxPathNotFoundError, moveFolderStrict } from "../src/dropbox/client";

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

  it("applies the same not_found handling when probing by folder ID, the way an Editor tree move locates a root", async () => {
    const { id, client } = await connection();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string).path).toBe("id:abc123");
      return new Response(JSON.stringify({ error_summary: "path/not_found/..", error: { ".tag": "path", path: { ".tag": "not_found" } } }), { status: 409 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const error = await getMetadata(env as never, db, "id:abc123", id, client).catch((caught: unknown) => caught);
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

  it("parses a file's server_modified timestamp when Dropbox sends one, and leaves it undefined otherwise", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ".tag": "file", name: "photo.jpg", path_lower: "/editor/01_active edits/09. september/01/project/0. input/photo.jpg",
      id: "id:file1", size: 1024, server_modified: "2026-09-01T10:00:00Z",
    }), { status: 200 })));
    const withTimestamp = await getMetadata(env as never, db, "/Editor/01_ACTIVE EDITS/09. September/01/Project/0. Input/photo.jpg", id, client);
    expect(withTimestamp).toMatchObject({ ".tag": "file", server_modified: "2026-09-01T10:00:00Z" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ".tag": "file", name: "photo.jpg", path_lower: "/editor/.../photo.jpg", id: "id:file2", size: 1024,
    }), { status: 200 })));
    const withoutTimestamp = await getMetadata(env as never, db, "/Editor/.../photo.jpg", id, client);
    expect((withoutTimestamp as { server_modified?: string }).server_modified).toBeUndefined();
  });
});

describe("Dropbox moveFolderStrict and relocation conflicts", () => {
  const fromPath = "/Editor/01_ACTIVE EDITS/09. September/01/Project";
  const toPath = "/Editor/01_ACTIVE EDITS/09. September/02/Project";

  it("moves a folder and parses the returned metadata as a folder", async () => {
    const { id, client } = await connection();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ from_path: fromPath, to_path: toPath, autorename: false, allow_ownership_transfer: false });
      return new Response(JSON.stringify({ metadata: { ".tag": "folder", name: "Project", path_lower: toPath.toLowerCase(), path_display: toPath, id: "id:root" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const moved = await moveFolderStrict(env as never, db, fromPath, toPath, id, client);
    expect(moved).toMatchObject({ ".tag": "folder", id: "id:root", path_display: toPath });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/files/move_v2"), expect.anything());
  });

  it("refuses a relocation that did not return a folder, rather than mistyping the entry", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      metadata: { ".tag": "file", name: "Project", path_lower: toPath.toLowerCase(), path_display: toPath, id: "id:file1", size: 12 },
    }), { status: 200 })));
    await expect(moveFolderStrict(env as never, db, fromPath, toPath, id, client)).rejects.toThrow(/did not move a folder/);
  });

  it("throws DropboxRelocationConflictError on a destination conflict without recording the connection as errored", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "to/conflict/folder/..", error: { ".tag": "to", to: { ".tag": "conflict", conflict: { ".tag": "folder" } } } }), { status: 409 })));
    const error = await moveFolderStrict(env as never, db, fromPath, toPath, id, client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DropboxRelocationConflictError);
    expect(await state(id)).toEqual({ status: "connected", last_error: null });
  });

  it("throws DropboxPathNotFoundError when the source is gone, without recording the connection as errored", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "from_lookup/not_found/..", error: { ".tag": "from_lookup", from_lookup: { ".tag": "not_found" } } }), { status: 409 })));
    const error = await moveFolderStrict(env as never, db, fromPath, toPath, id, client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DropboxPathNotFoundError);
    expect(await state(id)).toEqual({ status: "connected", last_error: null });
  });

  it("throws DropboxPathNotFoundError when the destination's parent is gone, without recording the connection as errored", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "to/not_found/..", error: { ".tag": "to", to: { ".tag": "not_found" } } }), { status: 409 })));
    const error = await moveFolderStrict(env as never, db, fromPath, toPath, id, client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DropboxPathNotFoundError);
    expect(await state(id)).toEqual({ status: "connected", last_error: null });
  });

  it("still marks the connection for any other move_v2 failure", async () => {
    const { id, client } = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "internal_error/.." }), { status: 500 })));
    await expect(moveFolderStrict(env as never, db, fromPath, toPath, id, client)).rejects.toThrow(/500/);
    expect((await state(id))?.status).toBe("error");
  });
});
