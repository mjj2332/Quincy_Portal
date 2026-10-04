import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { sweepEmbeddedMedia } from "../src/embedded-media-sweep";

const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;
const day = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const projectId = "c1111111-1111-4111-8111-111111111111";
const userId = "c2222222-2222-4222-8222-222222222222";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

type Seed = { state: "uploading" | "pending" | "attached" | "detached"; createdAt?: number; detachedAt?: number | null; uploadId?: string | null; display?: boolean; poster?: boolean; id?: string };
async function seed(input: Seed) {
  const id = input.id ?? crypto.randomUUID(); const key = `projects/${projectId}/embedded-media/${id}/original`;
  const detachedAt = input.state === "detached" ? (input.detachedAt ?? now) : null;
  const ownerId = input.state === "attached" || input.state === "detached" ? crypto.randomUUID() : null;
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, display_key, poster_key, upload_id, state, detached_at, created_at, updated_at) VALUES (?, 'project_comment', ?, ?, ?, 'image', 'image/png', 3, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ownerId, projectId, userId, key, input.display ? `${key}.display` : null, input.poster ? `${key}.poster` : null, input.uploadId ?? null, input.state, detachedAt, input.createdAt ?? now, input.createdAt ?? now).run();
  const keys = [key, ...(input.display ? [`${key}.display`] : []), ...(input.poster ? [`${key}.poster`] : [])];
  for (const object of keys) await database.MEDIA.put(object, "xyz");
  return { id, keys };
}
const exists = async (id: string) => (await database.DB.prepare("SELECT 1 AS one FROM embedded_media WHERE id = ?").bind(id).first()) !== null;
const objectExists = async (key: string) => (await database.MEDIA.head(key)) !== null;
const count = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").bind(userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'S', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
});
beforeEach(async () => { await database.DB.exec("DELETE FROM embedded_media;"); });
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => { consoleError.mockRestore(); });

describe("embedded media sweep (#493)", () => {
  it("reclaims media detached seven days ago or longer, and keeps newer detached media", async () => {
    const old = await seed({ state: "detached", detachedAt: now - 7 * day });
    const justShy = await seed({ state: "detached", detachedAt: now - 7 * day + 1 });
    const result = await sweepEmbeddedMedia(env, now);
    expect(result).toMatchObject({ scanned: 1, reclaimed: 1 });
    expect(await exists(old.id)).toBe(false); expect(await objectExists(old.keys[0]!)).toBe(false);
    expect(await exists(justShy.id)).toBe(true); expect(await objectExists(justShy.keys[0]!)).toBe(true);
  });

  it("reclaims media left uploading or pending for seven days, and never an attached row however old", async () => {
    const pending = await seed({ state: "pending", createdAt: now - 7 * day });
    const uploading = await seed({ state: "uploading", createdAt: now - 8 * day });
    const freshPending = await seed({ state: "pending", createdAt: now - 7 * day + 1 });
    const attached = await seed({ state: "attached", createdAt: now - 400 * day });
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ scanned: 2, reclaimed: 2 });
    for (const row of [pending, uploading]) { expect(await exists(row.id)).toBe(false); expect(await objectExists(row.keys[0]!)).toBe(false); }
    for (const row of [freshPending, attached]) { expect(await exists(row.id)).toBe(true); expect(await objectExists(row.keys[0]!)).toBe(true); }
  });

  it("reclaims media detached_at 0 (a deleted comment's media is due now)", async () => {
    const gone = await seed({ state: "detached", detachedAt: 0 });
    await sweepEmbeddedMedia(env, now);
    expect(await exists(gone.id)).toBe(false); expect(await objectExists(gone.keys[0]!)).toBe(false);
  });

  it("deletes the display and poster objects as well as the original", async () => {
    const row = await seed({ state: "detached", detachedAt: 0, display: true, poster: true });
    expect(row.keys).toHaveLength(3);
    await sweepEmbeddedMedia(env, now);
    for (const key of row.keys) expect(await objectExists(key), key).toBe(false);
  });

  it("aborts the multipart upload of an uploading row, and carries on when R2 no longer knows it", async () => {
    const started = await seed({ state: "uploading", createdAt: now - 8 * day, uploadId: "s3-upload-1" });
    const aborted: Array<[string, string]> = [];
    const wrapped = { ...env, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "resumeMultipartUpload") return (key: string, uploadId: string) => ({ abort: async () => { aborted.push([key, uploadId]); throw Object.assign(new Error("The specified multipart upload does not exist."), { code: "NoSuchUpload" }); } });
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    expect(await sweepEmbeddedMedia(wrapped, now)).toMatchObject({ reclaimed: 1 });
    expect(aborted).toEqual([[started.keys[0], "s3-upload-1"]]);
    expect(await exists(started.id)).toBe(false);
  });

  it("keeps the row for tomorrow when R2 will not delete its objects", async () => {
    const stuck = await seed({ state: "detached", detachedAt: 0 });
    const failing = { ...env, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    expect(await sweepEmbeddedMedia(failing, now)).toMatchObject({ scanned: 1, reclaimed: 0, failed: 1 });
    expect(await exists(stuck.id)).toBe(true);
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ reclaimed: 1 });
    expect(await exists(stuck.id)).toBe(false);
  });

  it("skips a row that was attached between the sweep's read and its claim, leaving the object alone", async () => {
    const row = await seed({ state: "pending", createdAt: now - 8 * day });
    const racing = { ...env, DB: new Proxy(database.DB, { get: (target, property) => {
      if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("ORDER BY id LIMIT")) return statement;
        return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { all: async () => {
          const read = await bound.all();
          await database.DB.prepare("UPDATE embedded_media SET state = 'attached', owner_id = ? WHERE id = ?").bind(crypto.randomUUID(), row.id).run();
          return read;
        } }; } };
      };
    } }) };
    expect(await sweepEmbeddedMedia(racing as unknown as typeof env, now)).toMatchObject({ scanned: 1, reclaimed: 0, failed: 0 });
    expect(await exists(row.id)).toBe(true); expect(await objectExists(row.keys[0]!)).toBe(true);
  });

  it("claims an expired row before deleting objects: the row is unattachable (detached, due now, owned by itself) while R2 is still working", async () => {
    const row = await seed({ state: "pending", createdAt: now - 8 * day });
    let seen: unknown = null;
    const watching = { ...env, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "delete") return async (keys: string | string[]) => { seen = await database.DB.prepare("SELECT state, detached_at, owner_id FROM embedded_media WHERE id = ?").bind(row.id).first(); return target.delete(keys); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    expect(await sweepEmbeddedMedia(watching, now)).toMatchObject({ reclaimed: 1 });
    expect(seen).toEqual({ state: "detached", detached_at: 0, owner_id: row.id });
  });

  it("takes at most 100 rows a run, and a rerun finishes the rest and then does nothing", async () => {
    for (let index = 0; index < 101; index += 1) await seed({ state: "detached", detachedAt: 0 });
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ scanned: 100, reclaimed: 100 });
    expect(await count()).toBe(1);
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ scanned: 1, reclaimed: 1 });
    expect(await sweepEmbeddedMedia(env, now)).toEqual({ scanned: 0, reclaimed: 0, failed: 0 });
  });
});
