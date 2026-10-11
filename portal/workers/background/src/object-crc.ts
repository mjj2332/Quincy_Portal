import { crc32 } from "node:zlib";
import { enqueueObjectCrcMessages, type ObjectCrcMessage } from "@quincy/shared";
import type { Env } from "./env";

/**
 * The object CRC-32 job (#802). The native ZIP writer puts an entry's CRC and size in its local header ahead of the bytes, so each object's CRC is computed here, off the request path, and stored in
 * `object_crc32`. R2 delivers bodies in ~4 KB chunks, so a range is read with a 1 MiB BYOB buffer where workerd offers one, and the CRC itself is native (`node:zlib`, ~0.13 ms/MB).
 *
 * One queue message is one range of at most 512 MiB. `object_crc32_work` carries the etag, the offset reached and the running CRC between messages, and the last range upserts `object_crc32` and deletes
 * the work row in one batch. Every write is a compare-and-set on (etag, offset), so a duplicate or late delivery finds the row somewhere else and does nothing. A range is read with `onlyIf: { etagMatches }`:
 * an object overwritten mid-way restarts from offset 0 with its new etag, and a CRC never mixes two versions of the bytes.
 */
export const CRC_READ_BYTES = 1024 * 1024;
export const CRC_RANGE_BYTES = 512 * 1024 * 1024;
/** The attempt on which a failing message records `failed` in the work row and is acked. The queue allows one more (max_retries 3), which is never used. */
export const CRC_MAX_ATTEMPTS = 3;
/** A running row nobody has touched for this long is taken over; the sweep also treats such a row as no longer live. */
export const CRC_STALE_MS = 10 * 60_000;
export type ObjectCrcOutcome = "stored" | "advanced" | "restarted" | "skipped" | "stale" | "missing" | "failed";
type JobEnv = Pick<Env, "DB" | "MEDIA" | "OBJECT_CRC_QUEUE">;
type Options = { attempts?: number; now?: number; rangeBytes?: number; bufferBytes?: number };
type Work = { etag: string | null; bytes: number | null; offset: number; crc_partial: number; state: "queued" | "running" | "failed"; updated_at: number };

/** CRC-32 and byte count of a body, continuing from `previous`. BYOB with `readAtLeast` when the stream supports it, the default reader otherwise. */
export async function crcOfBody(body: ReadableStream<Uint8Array>, expectedBytes: number, previous = 0, bufferBytes = CRC_READ_BYTES): Promise<{ crc: number; bytes: number }> {
  let byob: ReadableStreamBYOBReader | null = null;
  try { byob = body.getReader({ mode: "byob" }); } catch { byob = null; }
  let crc = previous; let bytes = 0;
  if (byob) {
    const reader = byob; const size = Math.min(bufferBytes, Math.max(1, expectedBytes));
    try {
      let buffer = new ArrayBuffer(size);
      while (true) {
        // Ask for a full buffer, but never more than is left, and at least one byte so the end of the stream is seen.
        const wanted = Math.max(1, Math.min(size, expectedBytes - bytes));
        const view = new Uint8Array(buffer);
        const result = typeof reader.readAtLeast === "function" ? await reader.readAtLeast(wanted, view) : await reader.read(view);
        if (result.value) { crc = crc32(result.value, crc); bytes += result.value.byteLength; buffer = result.value.buffer as ArrayBuffer; }
        if (result.done) break;
        // The transferred buffer comes back full-size, so it is reused as it is.
        if (buffer.byteLength !== size) buffer = new ArrayBuffer(size);
      }
    } finally { reader.releaseLock(); }
    return { crc, bytes };
  }
  const reader = body.getReader();
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; if (value) { crc = crc32(value, crc); bytes += value.byteLength; } }
  } finally { reader.releaseLock(); }
  return { crc, bytes };
}

const readWork = (db: D1Database, r2Key: string) => db.prepare('SELECT etag, bytes, "offset", crc_partial, state, updated_at FROM object_crc32_work WHERE r2_key = ?1').bind(r2Key).first<Work>();
const truncate = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Processes one message: a start (no etag) or the next range of a run. Returns the outcome. Throws so the queue retries, until the last attempt, which records `failed` and returns. */
export async function processObjectCrc(env: JobEnv, message: ObjectCrcMessage, options: Options = {}): Promise<ObjectCrcOutcome> {
  const attempts = options.attempts ?? 1; const now = options.now ?? Date.now();
  try { return await runRange(env, message, { ...options, attempts, now }); }
  catch (error) {
    const final = attempts >= CRC_MAX_ATTEMPTS;
    // A continuation only touches the run it belongs to: a late failure of an old run must not mark the newer one.
    const fence = message.etag === undefined ? "" : ' AND etag = ?5 AND "offset" = ?6'; const fenceBinds = message.etag === undefined ? [] : [message.etag, message.offset];
    const state = final ? ", state = 'failed'" : "";
    await env.DB.prepare(`UPDATE object_crc32_work SET attempts = ?1, last_error = ?2, updated_at = ?3${state} WHERE r2_key = ?4${fence}`).bind(attempts, truncate(error), now, message.r2Key, ...fenceBinds).run();
    if (!final) throw error;
    if (message.etag === undefined) await env.DB.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at, last_error) VALUES (?1, 'failed', ?2, ?3, ?3, ?4) ON CONFLICT(r2_key) DO NOTHING`).bind(message.r2Key, attempts, now, truncate(error)).run();
    console.error("Object CRC failed for good", { r2Key: message.r2Key, attempts, error: truncate(error) });
    return "failed";
  }
}

async function runRange(env: JobEnv, message: ObjectCrcMessage, options: Required<Pick<Options, "attempts" | "now">> & Options): Promise<ObjectCrcOutcome> {
  const { r2Key } = message; const { attempts, now } = options; const db = env.DB;
  const rangeBytes = options.rangeBytes ?? CRC_RANGE_BYTES; const continuation = message.etag !== undefined;
  const head = await env.MEDIA.head(r2Key);
  if (!head) { await db.prepare("DELETE FROM object_crc32_work WHERE r2_key = ?1 AND state != 'failed'").bind(r2Key).run(); return "missing"; }
  let work = await readWork(db, r2Key);
  if (continuation && (!work || work.state === "failed" || work.etag !== message.etag || work.offset !== message.offset)) return "stale";
  if (!continuation) {
    const done = await db.prepare("SELECT etag, bytes FROM object_crc32 WHERE r2_key = ?1").bind(r2Key).first<{ etag: string; bytes: number }>();
    if (done && done.etag === head.etag && done.bytes === head.size) { await db.prepare("DELETE FROM object_crc32_work WHERE r2_key = ?1").bind(r2Key).run(); return "skipped"; }
    if (work?.state === "failed") return "stale";
    if (!work) {
      const created = await db.prepare(`INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, 'queued', 0, ?4, ?4) ON CONFLICT(r2_key) DO NOTHING`).bind(r2Key, head.etag, head.size, now).run();
      if (created.meta.changes === 0) return "stale";
      work = await readWork(db, r2Key); if (!work) return "stale";
    } else if (work.etag === null) {
      const set = await db.prepare(`UPDATE object_crc32_work SET etag = ?2, bytes = ?3, updated_at = ?4 WHERE r2_key = ?1 AND etag IS NULL AND "offset" = 0`).bind(r2Key, head.etag, head.size, now).run();
      if (set.meta.changes === 0) return "stale";
      work = await readWork(db, r2Key); if (!work) return "stale";
    }
  }
  if (!work || work.etag === null || work.bytes === null) return "stale";
  if (head.etag !== work.etag) return restart(env, r2Key, work.etag, head.etag, head.size, now);
  const { etag, bytes: size } = work as Work & { etag: string; bytes: number };
  // Claim the range. A queued row is claimable; a running one only by a retry of its own message or once it has gone quiet.
  const claimed = await db.prepare(`UPDATE object_crc32_work SET state = 'running', attempts = ?5, updated_at = ?4 WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND (state = 'queued' OR (state = 'running' AND (?5 > 1 OR updated_at <= ?6)))`)
    .bind(r2Key, etag, work.offset, now, attempts, now - CRC_STALE_MS).run();
  if (claimed.meta.changes === 0) return "stale";
  const length = Math.min(rangeBytes, size - work.offset);
  let crc = work.crc_partial;
  if (length > 0) {
    const object = await env.MEDIA.get(r2Key, { range: { offset: work.offset, length }, onlyIf: { etagMatches: etag } });
    if (!object) { await db.prepare("DELETE FROM object_crc32_work WHERE r2_key = ?1 AND etag = ?2").bind(r2Key, etag).run(); return "missing"; }
    // A failed precondition answers with the object's metadata and no body: it is no longer the object this run started on.
    if (!("body" in object) || !object.body) return restart(env, r2Key, etag, object.etag, object.size, now);
    const read = await crcOfBody(object.body, length, crc, options.bufferBytes);
    // A short or long read is not a checksum of the range: throw, so the queue retries it.
    if (read.bytes !== length) throw new Error(`Object CRC read ${read.bytes} of ${length} bytes for ${r2Key} at ${work.offset}`);
    crc = read.crc;
  }
  const next = work.offset + length;
  if (next >= size) {
    // The last range: the result and the end of the work row land together, and only for the run that read it.
    const [, removed] = await db.batch([
      db.prepare(`INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) SELECT r2_key, ?4, bytes, etag, ?5 FROM object_crc32_work WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND state = 'running'
        ON CONFLICT(r2_key) DO UPDATE SET crc32 = excluded.crc32, bytes = excluded.bytes, etag = excluded.etag, computed_at = excluded.computed_at`).bind(r2Key, etag, work.offset, crc, now),
      db.prepare(`DELETE FROM object_crc32_work WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND state = 'running'`).bind(r2Key, etag, work.offset),
    ]);
    return removed!.meta.changes === 0 ? "stale" : "stored";
  }
  const advanced = await db.prepare(`UPDATE object_crc32_work SET "offset" = ?4, crc_partial = ?5, state = 'queued', updated_at = ?6 WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND state = 'running'`).bind(r2Key, etag, work.offset, next, crc, now).run();
  if (advanced.meta.changes === 0) return "stale";
  // A lost send is repaired by the hourly sweep: the row goes quiet, and a row quiet for ten minutes counts as not live.
  await enqueueObjectCrcMessages(env, [{ type: "object_crc32", r2Key, etag, offset: next }], "object-crc-next-range");
  return "advanced";
}

/** The object changed under a run: start over from offset 0 on the new etag. Only the run that holds `from` may do it. */
async function restart(env: JobEnv, r2Key: string, from: string, etag: string, size: number, now: number): Promise<ObjectCrcOutcome> {
  const reset = await env.DB.prepare(`UPDATE object_crc32_work SET etag = ?3, bytes = ?4, "offset" = 0, crc_partial = 0, state = 'queued', attempts = 0, last_error = NULL, updated_at = ?5 WHERE r2_key = ?1 AND etag = ?2`).bind(r2Key, from, etag, size, now).run();
  if (reset.meta.changes === 0) return "stale";
  await enqueueObjectCrcMessages(env, [{ type: "object_crc32", r2Key, etag, offset: 0 }], "object-crc-restart");
  return "restarted";
}
