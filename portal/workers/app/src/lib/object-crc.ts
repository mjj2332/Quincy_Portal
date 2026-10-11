import { enqueueObjectCrcs } from "@quincy/shared";
import type { Env } from "../env";
import type { ZipObjectEntry } from "./zip-native";

/**
 * The CRC-32 gate of the native ZIP writer (#802). A zip route asks `assessZip` what to do with a set of objects BEFORE it writes an audit row or reads a byte, and gets one of five answers:
 *
 *  - `legacy`: stream with the old per-chunk writer (`zip-stream.ts`), which is safe up to `ZIP_LEGACY_MAX_BYTES` (about half the CPU limit at the measured 52 ms/MB);
 *  - `native`: every CRC is ready, so `zip-native.ts` can put the CRC and size in each local header and pipe the bodies natively;
 *  - `preparing`: some CRC is not ready and the set is too big for the old writer, so the caller answers 409 and the page polls;
 *  - `unavailable`: an object is gone, is not the size D1 records, or its CRC job failed for good (502, never an endless "preparing");
 *  - `too_large`: the `native_zip` flag is off and the set is over the legacy cap (413: the old writer would silently truncate the file).
 *
 * The flag is `feature_flags.native_zip`; a missing row is off ("ship dark behind flags"). With it off nothing here touches R2 or the queue, so legacy behaviour is unchanged.
 */
export const NATIVE_ZIP_FLAG = "native_zip";
/** 256 MiB, about 0.5 x the 30 s CPU limit / 52 ms per MB (the probe on #787). The old writer is cut off by the CPU limit above this. */
export const ZIP_LEGACY_MAX_BYTES = 256 * 1024 * 1024;
/** What the page is told to wait between checks while an object is being prepared. */
export const ZIP_RETRY_AFTER_SECONDS = 30;
/** A work row nobody has touched for this long is no longer live: the next gate queues the key again. The same ten minutes as the background job (`CRC_STALE_MS`). */
export const ZIP_WORK_STALE_MS = 10 * 60_000;

export type ObjectCrc = { crc32: number; bytes: number; etag: string };
export type CrcSubject = { r2Key: string; bytes: number };
export type ZipAssessment =
  | { kind: "legacy" }
  | { kind: "too_large" }
  | { kind: "native"; ready: Map<string, ObjectCrc> }
  | { kind: "preparing"; pending: string[]; retryAfterSeconds: number }
  | { kind: "unavailable"; reason: "missing" | "changed" | "failed" };
/** Whether the gate queues the CRC job for what is pending: never (a read-only poll), only when it is about to answer `preparing`, or always (a preparation request). */
export type EnqueueMode = "never" | "when_blocked" | "always";
type GateEnv = Pick<Env, "DB" | "OBJECT_CRC_QUEUE"> & { MEDIA: Pick<R2Bucket, "head"> };

/** D1 allows 100 bound variables per statement. */
const CHUNK = 80;
/** HEADs in flight at once: a selection can hold hundreds of objects and Workers keep six connections open. */
const HEAD_BATCH = 25;

export async function nativeZipEnabled(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS on_ FROM feature_flags WHERE key = ?1 AND enabled = 1").bind(NATIVE_ZIP_FLAG).first()) !== null;
}

export async function loadObjectCrcs(db: D1Database, keys: readonly string[]): Promise<Map<string, ObjectCrc & { r2Key: string }>> {
  const rows = new Map<string, ObjectCrc & { r2Key: string }>();
  const unique = [...new Set(keys)];
  for (let at = 0; at < unique.length; at += CHUNK) {
    const chunk = unique.slice(at, at + CHUNK);
    const found = await db.prepare(`SELECT r2_key, crc32, bytes, etag FROM object_crc32 WHERE r2_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ r2_key: string; crc32: number; bytes: number; etag: string }>();
    for (const row of found.results) rows.set(row.r2_key, { r2Key: row.r2_key, crc32: row.crc32, bytes: row.bytes, etag: row.etag });
  }
  return rows;
}

async function loadWork(db: D1Database, keys: readonly string[]): Promise<Map<string, { state: string; updatedAt: number }>> {
  const rows = new Map<string, { state: string; updatedAt: number }>();
  for (let at = 0; at < keys.length; at += CHUNK) {
    const chunk = keys.slice(at, at + CHUNK);
    const found = await db.prepare(`SELECT r2_key, state, updated_at FROM object_crc32_work WHERE r2_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ r2_key: string; state: string; updated_at: number }>();
    for (const row of found.results) rows.set(row.r2_key, { state: row.state, updatedAt: row.updated_at });
  }
  return rows;
}

/**
 * Queues the CRC job for `keys`, once. The dedupe is the work row, as in the hourly sweep: a key with no row gets a `queued` row inserted first and is sent only by the request whose insert landed, so two
 * concurrent requests send one message; a key whose row has been quiet for ten minutes is sent again (the start message takes the row over); a live row is left alone. Best effort, never throws.
 */
async function queuePending(env: GateEnv, keys: readonly string[], work: Map<string, { state: string; updatedAt: number }>, source: string, now: number): Promise<number> {
  const send: string[] = [];
  const fresh = keys.filter((key) => !work.has(key));
  for (const key of keys) { const row = work.get(key); if (row && row.state !== "failed" && row.updatedAt <= now - ZIP_WORK_STALE_MS) send.push(key); }
  try {
    for (let at = 0; at < fresh.length; at += 100) {
      const chunk = fresh.slice(at, at + 100);
      const results = await env.DB.batch(chunk.map((key) => env.DB.prepare("INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?1, 'queued', 0, ?2, ?2) ON CONFLICT(r2_key) DO NOTHING").bind(key, now)));
      chunk.forEach((key, index) => { if (results[index]!.meta.changes === 1) send.push(key); });
    }
  } catch (error) { console.error("Object CRC work row insert failed; the hourly sweep queues it again", { source, error }); return 0; }
  return enqueueObjectCrcs(env, send, source);
}

/**
 * Decides how a zip route serves `subjects` (R2 key and the size D1 records). See the file comment for the five answers.
 * With the flag on, EVERY object is HEADed: Dropbox RAW keys are reused across revisions, so a stored row can describe bytes that are gone, and only R2's etag now says whether it still matches.
 * An object is pending when it has no row or its row's etag differs from R2's. The row's own size is not compared with D1's: the etag decides, and the writer checks the size again as it reads.
 */
export async function assessZip(env: GateEnv, subjects: readonly CrcSubject[], options: { source: string; enqueue: EnqueueMode; now?: number }): Promise<ZipAssessment> {
  const now = options.now ?? Date.now();
  const small = subjects.reduce((total, subject) => total + subject.bytes, 0) <= ZIP_LEGACY_MAX_BYTES;
  if (!await nativeZipEnabled(env.DB)) return small ? { kind: "legacy" } : { kind: "too_large" };

  const unique = [...new Map(subjects.map((subject) => [subject.r2Key, subject])).values()];
  const heads: Array<{ etag: string; size: number } | null> = [];
  for (let at = 0; at < unique.length; at += HEAD_BATCH) heads.push(...await Promise.all(unique.slice(at, at + HEAD_BATCH).map((subject) => env.MEDIA.head(subject.r2Key))));
  for (const [index, head] of heads.entries()) {
    if (head === null) return { kind: "unavailable", reason: "missing" };
    if (head.size !== unique[index]!.bytes) return { kind: "unavailable", reason: "changed" };
  }

  const rows = await loadObjectCrcs(env.DB, unique.map((subject) => subject.r2Key));
  const ready = new Map<string, ObjectCrc>(); const pending: string[] = [];
  for (const [index, subject] of unique.entries()) {
    const row = rows.get(subject.r2Key);
    if (row && row.etag === heads[index]!.etag) ready.set(subject.r2Key, { crc32: row.crc32, bytes: row.bytes, etag: row.etag });
    else pending.push(subject.r2Key);
  }
  if (pending.length === 0) return { kind: "native", ready };

  const work = await loadWork(env.DB, pending);
  if (pending.some((key) => work.get(key)?.state === "failed")) return { kind: "unavailable", reason: "failed" };
  const blocked = !small;
  if (options.enqueue === "always" || (options.enqueue === "when_blocked" && blocked)) await queuePending(env, pending, work, options.source, now);
  return blocked ? { kind: "preparing", pending, retryAfterSeconds: ZIP_RETRY_AFTER_SECONDS } : { kind: "legacy" };
}

/** A zip entry for an object whose CRC is ready. */
export function objectEntry(name: string, r2Key: string, ready: Map<string, ObjectCrc>): ZipObjectEntry {
  const row = ready.get(r2Key);
  if (!row) throw new Error(`No CRC-32 for ${r2Key}`);
  return { name, r2Key, crc32: row.crc32, bytes: row.bytes, etag: row.etag };
}
