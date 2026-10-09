import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepVideoUploads } from "../src/video-upload-sweep";

const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;
const MINUTE = 60_000;
const NOW = 10_000_000_000;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

const userId = crypto.randomUUID(); const projectId = crypto.randomUUID(); const collectionId = crypto.randomUUID();
beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Sweep Editor', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, NOW, NOW),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Sweep Street', 'editing_autohdr', ?, ?)").bind(projectId, NOW, NOW),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'empty', 0, ?, ?)").bind(collectionId, projectId, NOW, NOW),
  ]);
});
beforeEach(async () => { await database.DB.exec("DELETE FROM video_upload_reservations;"); });
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => { consoleError.mockRestore(); });

type Seed = { status: "pending" | "completing" | "aborting" | "completed" | "rejected" | "expired" | "failed"; expiresAt?: number; completingAt?: number | null; multipart?: boolean | "unknown"; object?: boolean };
/** A reservation in the state a case needs, with its object and (unless `multipart: false`) a live multipart upload to reclaim. */
async function seed(input: Seed) {
  const id = crypto.randomUUID(); const videoId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const key = `projects/${projectId}/video/${videoId}/${assetId}/original.mp4`;
  let uploadId: string | null = null;
  if (input.multipart === "unknown") uploadId = "no-such-upload";
  else if (input.multipart !== false) {
    const upload = await database.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
    uploadId = upload.uploadId;
  }
  if (input.object) await database.MEDIA.put(key, new Uint8Array(32), { httpMetadata: { contentType: "video/mp4" } });
  await database.DB.prepare(`INSERT INTO video_upload_reservations (id, project_id, collection_id, created_by, video_id, new_video_title, version, asset_id, r2_key, original_filename, bytes, content_type, upload_id, status, expires_at, completing_at, completion_audit_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Swept', 1, ?, ?, 'cut.mp4', 32, 'video/mp4', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, projectId, collectionId, userId, videoId, assetId, key, uploadId, input.status, input.expiresAt ?? NOW + 7 * 60 * MINUTE, input.completingAt ?? null, crypto.randomUUID(), NOW - 8 * 60 * MINUTE, NOW - 8 * 60 * MINUTE).run();
  return { id, key, uploadId };
}
const statusOf = async (id: string) => (await database.DB.prepare("SELECT status FROM video_upload_reservations WHERE id = ?").bind(id).first<{ status: string }>())?.status;
const uploadIsDead = async (key: string, uploadId: string) => { try { await database.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(1, new Uint8Array(4)); return false; } catch { return true; } };

describe("video upload sweep", () => {
  it("expires a pending reservation past its expiry: the multipart upload is aborted, the object deleted, the row closed as expired", async () => {
    const row = await seed({ status: "pending", expiresAt: NOW - 1, object: true });
    await expect(sweepVideoUploads(database, NOW)).resolves.toEqual({ scanned: 1, reclaimed: 1 });
    expect(await statusOf(row.id)).toBe("expired"); expect(await database.MEDIA.head(row.key)).toBeNull(); expect(await uploadIsDead(row.key, row.uploadId!)).toBe(true);
    await expect(sweepVideoUploads(database, NOW)).resolves.toEqual({ scanned: 0, reclaimed: 0 });
  });

  it("leaves a live pending reservation and a fresh completing claim alone, and reclaims a completing claim past the 15 minute lease", async () => {
    const live = await seed({ status: "pending", object: true });
    const fresh = await seed({ status: "completing", completingAt: NOW - 14 * MINUTE, object: true });
    const stale = await seed({ status: "completing", completingAt: NOW - 15 * MINUTE, object: true });
    await expect(sweepVideoUploads(database, NOW)).resolves.toEqual({ scanned: 1, reclaimed: 1 });
    expect(await statusOf(live.id)).toBe("pending"); expect(await statusOf(fresh.id)).toBe("completing"); expect(await statusOf(stale.id)).toBe("expired");
    expect(await database.MEDIA.head(live.key)).not.toBeNull(); expect(await database.MEDIA.head(fresh.key)).not.toBeNull(); expect(await database.MEDIA.head(stale.key)).toBeNull();
  });

  it("finishes an abort that was left half done", async () => {
    const row = await seed({ status: "aborting", object: true });
    await expect(sweepVideoUploads(database, NOW)).resolves.toEqual({ scanned: 1, reclaimed: 1 });
    expect(await statusOf(row.id)).toBe("expired"); expect(await database.MEDIA.head(row.key)).toBeNull();
  });

  it("treats an upload R2 reports as already gone as aborted (a missing-upload error from the binding), and a reservation with no upload id (dev direct) as just an object to delete", async () => {
    // Miniflare answers an unknown upload id with an internal error rather than R2's NoSuchUpload, so the binding's answer is simulated.
    const gone = await seed({ status: "pending", expiresAt: NOW - 1 });
    const direct = await seed({ status: "pending", expiresAt: NOW - 1, multipart: false, object: true });
    const missing = { DB: database.DB, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "resumeMultipartUpload") return (key: string, uploadId: string) => uploadId === gone.uploadId ? { abort: async () => { throw Object.assign(new Error("The specified multipart upload does not exist. (10024)"), { code: "NoSuchUpload" }); } } : target.resumeMultipartUpload(key, uploadId);
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) } as { DB: D1Database; MEDIA: R2Bucket };
    await expect(sweepVideoUploads(missing, NOW)).resolves.toEqual({ scanned: 2, reclaimed: 2 });
    expect(await statusOf(gone.id)).toBe("expired"); expect(await statusOf(direct.id)).toBe("expired"); expect(await database.MEDIA.head(direct.key)).toBeNull();
  });

  it("never touches a completed, rejected, expired or failed reservation, however old", async () => {
    const rows = await Promise.all((["completed", "rejected", "expired", "failed"] as const).map((status) => seed({ status, expiresAt: NOW - 100 * MINUTE, completingAt: NOW - 100 * MINUTE, object: true })));
    await expect(sweepVideoUploads(database, NOW)).resolves.toEqual({ scanned: 0, reclaimed: 0 });
    for (const row of rows) expect(await database.MEDIA.head(row.key)).not.toBeNull();
    expect(await Promise.all(rows.map((row) => statusOf(row.id)))).toEqual(["completed", "rejected", "expired", "failed"]);
  });

  it("leaves the row aborting, with its object, when R2 refuses, and finishes on the next run", async () => {
    const row = await seed({ status: "pending", expiresAt: NOW - 1, object: true });
    const refusing = { DB: database.DB, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) } as { DB: D1Database; MEDIA: R2Bucket };
    await expect(sweepVideoUploads(refusing, NOW)).resolves.toEqual({ scanned: 1, reclaimed: 0 });
    expect(await statusOf(row.id)).toBe("aborting"); expect(await database.MEDIA.head(row.key)).not.toBeNull();
    await expect(sweepVideoUploads(database, NOW)).resolves.toEqual({ scanned: 1, reclaimed: 1 });
    expect(await statusOf(row.id)).toBe("expired"); expect(await database.MEDIA.head(row.key)).toBeNull();
  });

  it("loses cleanly to a completion that took the claim first: nothing is aborted or deleted", async () => {
    const row = await seed({ status: "pending", expiresAt: NOW - 1, object: true });
    // The completion's claim lands between the sweep's SELECT and its compare-and-set.
    const racing = { DB: new Proxy(database.DB, { get: (target, property) => {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/SET status = 'aborting'/.test(sql)) return statement;
        return new Proxy(statement, { get: (inner, name) => name === "bind" ? (...args: unknown[]) => { const bound = inner.bind(...args); return new Proxy(bound, { get: (b, method) => method === "run" ? async () => { await database.DB.prepare("UPDATE video_upload_reservations SET status = 'completing', completing_at = ? WHERE id = ?").bind(NOW, row.id).run(); return b.run(); } : (Reflect.get(b, method) as unknown) }); } : (Reflect.get(inner, name) as unknown) });
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }), MEDIA: database.MEDIA } as { DB: D1Database; MEDIA: R2Bucket };
    await expect(sweepVideoUploads(racing, NOW)).resolves.toEqual({ scanned: 1, reclaimed: 0 });
    expect(await statusOf(row.id)).toBe("completing"); expect(await database.MEDIA.head(row.key)).not.toBeNull(); expect(await uploadIsDead(row.key, row.uploadId!)).toBe(false);
  });
});
