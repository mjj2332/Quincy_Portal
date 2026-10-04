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

type Seed = { state: "uploading" | "pending" | "attached" | "detached"; createdAt?: number; detachedAt?: number | null; uploadId?: string | null; display?: boolean; poster?: boolean; id?: string; notice?: boolean };
async function seed(input: Seed) {
  const id = input.id ?? crypto.randomUUID(); const key = input.notice ? `notice-board/embedded-media/${id}/original` : `projects/${projectId}/embedded-media/${id}/original`;
  const detachedAt = input.state === "detached" ? (input.detachedAt ?? now) : null;
  const ownerId = input.state === "attached" || input.state === "detached" ? crypto.randomUUID() : null;
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, display_key, poster_key, upload_id, state, detached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'image', 'image/png', 3, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.notice ? "notice_post" : "project_comment", ownerId, input.notice ? null : projectId, userId, key, input.display ? `${key}.display` : null, input.poster ? `${key}.poster` : null, input.uploadId ?? null, input.state, detachedAt, input.createdAt ?? now, input.createdAt ?? now).run();
  const keys = [key, ...(input.display ? [`${key}.display`] : []), ...(input.poster ? [`${key}.poster`] : [])];
  for (const object of keys) await database.MEDIA.put(object, "xyz");
  return { id, keys };
}
const exists = async (id: string) => (await database.DB.prepare("SELECT 1 AS one FROM embedded_media WHERE id = ?").bind(id).first()) !== null;
const objectExists = async (key: string) => (await database.MEDIA.head(key)) !== null;
const queueRow = (key: string) => database.DB.prepare("SELECT storage_key AS storageKey, upload_id AS uploadId, project_id AS projectId, attempts FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storageKey: string; uploadId: string | null; projectId: string | null; attempts: number }>();
const queueSize = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media_cleanup").first<{ n: number }>())!.n;
const wrapMedia = (override: (target: R2Bucket, property: string | symbol) => unknown) => ({ ...env, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
  const custom = override(target, property); if (custom !== undefined) return custom;
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });
const count = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").bind(userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'S', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
});
beforeEach(async () => { await database.DB.exec("DELETE FROM link_previews; DELETE FROM embedded_media; DELETE FROM embedded_media_cleanup;"); });
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => { consoleError.mockRestore(); });

describe("embedded media sweep covers Notice board media (#496)", () => {
  it("reclaims notice media detached seven days ago, detached at 0, and left pending or uploading for seven days, and never an attached notice row", async () => {
    const oldDetached = await seed({ notice: true, state: "detached", detachedAt: now - 7 * day });
    const deletedPost = await seed({ notice: true, state: "detached", detachedAt: 0 });
    const stalePending = await seed({ notice: true, state: "pending", createdAt: now - 7 * day });
    const staleUploading = await seed({ notice: true, state: "uploading", createdAt: now - 8 * day });
    const freshDetached = await seed({ notice: true, state: "detached", detachedAt: now - 7 * day + 1 });
    const attached = await seed({ notice: true, state: "attached", createdAt: now - 400 * day });
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ scanned: 4, reclaimed: 4 });
    for (const row of [oldDetached, deletedPost, stalePending, staleUploading]) { expect(await exists(row.id)).toBe(false); expect(await objectExists(row.keys[0]!)).toBe(false); }
    for (const row of [freshDetached, attached]) { expect(await exists(row.id)).toBe(true); expect(await objectExists(row.keys[0]!)).toBe(true); }
  });

  it("queues an unremovable notice object with no Project id, and drains it once R2 recovers", async () => {
    const stuck = await seed({ notice: true, state: "pending", createdAt: now - 8 * day });
    let failing = true;
    const flaky = wrapMedia((target, property) => property === "delete" ? async (keys: string | string[]) => { if (failing) throw new Error("R2 down"); return target.delete(keys); } : undefined);
    await sweepEmbeddedMedia(flaky as never, now);
    expect(await exists(stuck.id)).toBe(false);
    expect(await queueRow(stuck.keys[0]!)).toMatchObject({ projectId: null });
    failing = false; await sweepEmbeddedMedia(flaky as never, now + 1);
    expect(await queueRow(stuck.keys[0]!)).toBeNull(); expect(await objectExists(stuck.keys[0]!)).toBe(false);
  });
});

describe("embedded media sweep covers link previews (#497)", () => {
  type Preview = { createdAt: number; ownerId?: string | null; notice?: boolean; image?: { id: string } };
  async function seedPreview(input: Preview) {
    const id = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, title, image_media_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'https://example.com/', 'T', ?, ?, ?)")
      .bind(id, input.notice ? "notice_post" : "project_comment", input.ownerId ?? null, input.notice ? null : projectId, userId, input.image?.id ?? null, input.createdAt, input.createdAt).run();
    return id;
  }
  const previewExists = async (id: string) => (await database.DB.prepare("SELECT 1 AS one FROM link_previews WHERE id = ?").bind(id).first()) !== null;

  it("deletes previews nobody owns after seven days, and keeps fresh and owned ones", async () => {
    const stale = await seedPreview({ createdAt: now - 7 * day });
    const staleNotice = await seedPreview({ createdAt: now - 30 * day, notice: true });
    const fresh = await seedPreview({ createdAt: now - 7 * day + 1 });
    const owned = await seedPreview({ createdAt: now - 400 * day, ownerId: crypto.randomUUID() });
    await sweepEmbeddedMedia(env, now);
    expect(await previewExists(stale)).toBe(false); expect(await previewExists(staleNotice)).toBe(false);
    expect(await previewExists(fresh)).toBe(true); expect(await previewExists(owned)).toBe(true);
  });

  it("reclaims the pending preview image the same run, which clears the card's image reference rather than blocking", async () => {
    const image = await seed({ state: "pending", createdAt: now - 8 * day });
    const stale = await seedPreview({ createdAt: now - 8 * day, image });
    await sweepEmbeddedMedia(env, now);
    expect(await previewExists(stale)).toBe(false);
    expect(await exists(image.id)).toBe(false); expect(await objectExists(image.keys[0]!)).toBe(false);
  });

  it("leaves an owned preview whose image expired with no image, not a dangling reference", async () => {
    const image = await seed({ state: "detached", detachedAt: now - 8 * day });
    const owned = await seedPreview({ createdAt: now - 20 * day, ownerId: crypto.randomUUID(), image });
    await sweepEmbeddedMedia(env, now);
    expect(await exists(image.id)).toBe(false);
    expect(await database.DB.prepare("SELECT image_media_id AS i FROM link_previews WHERE id = ?").bind(owned).first()).toEqual({ i: null });
  });
});

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

  it("hands a pending row's keys to the cleanup queue when R2 will not delete its objects, then drains them once R2 recovers", async () => {
    const stuck = await seed({ state: "detached", detachedAt: 0, display: true });
    const failing = wrapMedia((_t, property) => property === "delete" ? async () => { throw new Error("R2 down"); } : undefined);
    expect(await sweepEmbeddedMedia(failing as typeof env, now)).toMatchObject({ scanned: 1, reclaimed: 1, failed: 0 });
    expect(await exists(stuck.id)).toBe(false);
    for (const key of stuck.keys) expect(await queueRow(key), key).toMatchObject({ projectId, attempts: 1 });
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ scanned: 0, drained: 2 });
    for (const key of stuck.keys) { expect(await queueRow(key)).toBeNull(); expect(await objectExists(key)).toBe(false); }
  });

  it("moves an expired uploading row to the queue in one step instead of deleting its objects, and drains it in the same run", async () => {
    const row = await seed({ state: "uploading", createdAt: now - 8 * day, uploadId: "s3-upload-2" });
    let queuedWhileAborting: unknown = "not seen";
    const watching = wrapMedia((_t, property) => property === "resumeMultipartUpload" ? (_key: string, _uploadId: string) => ({ abort: async () => { queuedWhileAborting = await queueRow(row.keys[0]!); } }) : undefined);
    expect(await sweepEmbeddedMedia(watching as typeof env, now)).toMatchObject({ scanned: 1, reclaimed: 1, drained: 1 });
    expect(queuedWhileAborting).toMatchObject({ uploadId: "s3-upload-2", projectId });
    expect(await exists(row.id)).toBe(false); expect(await objectExists(row.keys[0]!)).toBe(false); expect(await queueSize()).toBe(0);
  });

  it("keeps an unabortable upload queued with its attempts counted, never deleting the object before the upload is terminal", async () => {
    const row = await seed({ state: "uploading", createdAt: now - 8 * day, uploadId: "s3-upload-3" });
    const deleted: unknown[] = [];
    const down = wrapMedia((target, property) => {
      if (property === "resumeMultipartUpload") return () => ({ abort: async () => { throw new Error("R2 unavailable"); } });
      if (property === "delete") return async (keys: unknown) => { deleted.push(keys); return target.delete(keys as string); };
      return undefined;
    });
    expect(await sweepEmbeddedMedia(down as typeof env, now)).toMatchObject({ reclaimed: 1, drained: 0 });
    expect(await exists(row.id)).toBe(false); expect(deleted).toEqual([]); expect(await objectExists(row.keys[0]!)).toBe(true);
    expect(await queueRow(row.keys[0]!)).toMatchObject({ uploadId: "s3-upload-3", attempts: 1 });
    await sweepEmbeddedMedia(down as typeof env, now);
    expect(await queueRow(row.keys[0]!)).toMatchObject({ attempts: 2 });
    // Once R2 reports the upload gone, the (late-completed) object is deleted and the entry leaves.
    const gone = wrapMedia((_t, property) => property === "resumeMultipartUpload" ? () => ({ abort: async () => { throw Object.assign(new Error("no"), { code: "NoSuchUpload" }); } }) : undefined);
    expect(await sweepEmbeddedMedia(gone as typeof env, now)).toMatchObject({ drained: 1 });
    expect(await objectExists(row.keys[0]!)).toBe(false); expect(await queueSize()).toBe(0);
  });

  it("retries a queued key whose delete fails (attempts counted, entry kept) until R2 accepts it", async () => {
    const key = `projects/${projectId}/embedded-media/${crypto.randomUUID()}/original`;
    await database.MEDIA.put(key, "late");
    await database.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(key, projectId, now).run();
    const failing = wrapMedia((_t, property) => property === "delete" ? async () => { throw new Error("R2 down"); } : undefined);
    expect(await sweepEmbeddedMedia(failing as typeof env, now)).toMatchObject({ drained: 0 });
    expect(await queueRow(key)).toMatchObject({ attempts: 1 }); expect(await objectExists(key)).toBe(true);
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ drained: 1 });
    expect(await queueRow(key)).toBeNull(); expect(await objectExists(key)).toBe(false);
  });

  it("skips an uploading row that was promoted to pending between the read and the claim, leaving it and its object alone", async () => {
    const row = await seed({ state: "uploading", createdAt: now - 8 * day });
    const racing = { ...env, DB: new Proxy(database.DB, { get: (target, property) => {
      if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("ORDER BY id LIMIT")) return statement;
        return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { all: async () => {
          const read = await bound.all();
          await database.DB.prepare("UPDATE embedded_media SET state = 'pending' WHERE id = ?").bind(row.id).run();
          return read;
        } }; } };
      };
    } }) };
    expect(await sweepEmbeddedMedia(racing as unknown as typeof env, now)).toMatchObject({ scanned: 1, reclaimed: 0, failed: 0 });
    expect(await exists(row.id)).toBe(true); expect(await objectExists(row.keys[0]!)).toBe(true); expect(await queueSize()).toBe(0);
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
    expect(await sweepEmbeddedMedia(env, now)).toEqual({ scanned: 0, reclaimed: 0, failed: 0, drained: 0 });
  });
});

describe("embedded media sweep claims keys it deletes (#494)", () => {
  /** Wraps the database so a poster lands between the sweep's read and its claim, the window a video upload's poster PUT can hit. */
  const lateWriter = (afterReadBeforeClaim: () => Promise<void>) => ({ ...env, DB: new Proxy(database.DB, { get: (target, property) => {
    if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
    return (sql: string) => {
      const statement = target.prepare(sql);
      if (!/UPDATE embedded_media SET state = 'detached', detached_at = 0/.test(sql)) return statement;
      return new Proxy(statement, { get: (inner, key) => {
        if (key === "bind") return (...values: unknown[]) => { const bound = inner.bind(...values); return new Proxy(bound, { get: (b, k) => {
          if (k === "run" || k === "all") return async () => { await afterReadBeforeClaim(); return (b as unknown as Record<string, () => Promise<unknown>>)[k as string]!(); };
          const v = Reflect.get(b, k); return typeof v === "function" ? v.bind(b) : v;
        } }); };
        const v = Reflect.get(inner, key); return typeof v === "function" ? v.bind(inner) : v;
      } });
    };
  } }) });

  it("deletes a poster written after the sweep read the row but before it claimed it", async () => {
    const stale = await seed({ state: "pending", createdAt: now - 8 * day });
    const posterKey = `projects/${projectId}/embedded-media/${stale.id}/poster-late`;
    const writer = lateWriter(async () => {
      await database.MEDIA.put(posterKey, "jpeg");
      await database.DB.prepare("UPDATE embedded_media SET poster_key = ? WHERE id = ?").bind(posterKey, stale.id).run();
    });
    expect(await sweepEmbeddedMedia(writer as never, now)).toMatchObject({ scanned: 1, reclaimed: 1 });
    expect(await exists(stale.id)).toBe(false);
    expect(await objectExists(stale.keys[0]!)).toBe(false);
    expect(await objectExists(posterKey)).toBe(false);
  });
});

describe("embedded media sweep dequeues only the entry it drained (#494)", () => {
  // The app worker's `enqueueEmbeddedMediaCleanup` upsert, as the poster route's failed-adoption path runs it.
  const REENQUEUE = `INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at)`;

  it("keeps an entry that was re-queued while the drain was between deleting the object and dequeuing it, and reclaims the new object next run", async () => {
    const key = `projects/${projectId}/embedded-media/${crypto.randomUUID()}/poster-race`;
    await database.MEDIA.put(key, "jpeg");
    await database.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(key, projectId, now).run();
    // The sweep deleted the object and is paused before its dequeue: meanwhile the late poster PUT lands, adoption loses, its delete fails and the key is queued again (same millisecond).
    const paused = wrapMedia((target, property) => property === "delete" ? async (keys: string | string[]) => {
      await target.delete(keys);
      await database.MEDIA.put(key, "jpeg-late");
      await database.DB.prepare(REENQUEUE).bind(key, null, projectId, now).run();
    } : undefined);
    expect(await sweepEmbeddedMedia(paused as never, now)).toMatchObject({ drained: 0 });
    expect(await queueRow(key)).not.toBeNull();
    expect(await objectExists(key)).toBe(true);
    expect(await sweepEmbeddedMedia(env, now + 1)).toMatchObject({ drained: 1 });
    expect(await queueRow(key)).toBeNull();
    expect(await objectExists(key)).toBe(false);
  });
});
