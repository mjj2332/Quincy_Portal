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
type Claim = { generation: number; etag: string | null; bytes: number | null; offset: number; crc_partial: number };

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

const truncate = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * Claim first. Every delivery's first D1 write is one atomic claim of the row (no read, then write), which hands out the next generation and sets the row `running`; a claim that changes no row
 * means another delivery owns the row, and the delivery returns `stale` having written nothing. After the claim every write is fenced on `r2_key AND generation = <mine> AND state = 'running'`: nothing
 * that read the row earlier can act on a run that has moved on. A start claims a row nobody has begun (the sweep's, no etag yet) or one that has gone quiet for ten minutes, never a live run. A continuation
 * claims the (etag, offset) it names. A failed attempt hands the row back (`queued`, quiet at once), so the queue's retry can claim it.
 */
const fenced = 'r2_key = ?1 AND generation = ?2 AND state = \'running\'';

/** Processes one message: a start (no etag) or the next range of a run. Returns the outcome. Throws so the queue retries, until the last attempt, which records `failed` and returns. */
export async function processObjectCrc(env: JobEnv, message: ObjectCrcMessage, options: Options = {}): Promise<ObjectCrcOutcome> {
  const attempts = options.attempts ?? 1; const now = options.now ?? Date.now(); const mine: { generation?: number } = {};
  try { return await runRange(env, message, { ...options, attempts, now }, mine); }
  catch (error) {
    const final = attempts >= CRC_MAX_ATTEMPTS; const text = truncate(error);
    // Only a delivery that claimed the row writes anything, and only under its own generation. A claim that itself threw owns nothing: the sweep takes the row back once it has been quiet.
    if (mine.generation !== undefined) {
      const state = final ? "failed" : "queued"; const quiet = final ? now : 0;
      await env.DB.prepare(`UPDATE object_crc32_work SET state = ?3, attempts = ?4, last_error = ?5, updated_at = ?6 WHERE ${fenced}`).bind(message.r2Key, mine.generation, state, attempts, text, quiet).run();
    }
    if (!final) throw error;
    console.error("Object CRC failed for good", { r2Key: message.r2Key, attempts, error: text });
    return "failed";
  }
}

async function claim(db: D1Database, message: ObjectCrcMessage, attempts: number, now: number): Promise<Claim | null> {
  const stale = now - CRC_STALE_MS;
  if (message.etag === undefined) {
    return db.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at, generation) VALUES (?1, 'running', ?2, ?3, ?3, 1)
      ON CONFLICT(r2_key) DO UPDATE SET generation = generation + 1, state = 'running', attempts = ?2, updated_at = ?3
      WHERE (state = 'queued' AND etag IS NULL) OR (state IN ('queued', 'running') AND updated_at <= ?4)
      RETURNING generation, etag, bytes, "offset", crc_partial`).bind(message.r2Key, attempts, now, stale).first<Claim>();
  }
  return db.prepare(`UPDATE object_crc32_work SET generation = generation + 1, state = 'running', attempts = ?5, updated_at = ?4
      WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND (state = 'queued' OR (state = 'running' AND updated_at <= ?6))
      RETURNING generation, etag, bytes, "offset", crc_partial`).bind(message.r2Key, message.etag, message.offset, now, attempts, stale).first<Claim>();
}

async function runRange(env: JobEnv, message: ObjectCrcMessage, options: Required<Pick<Options, "attempts" | "now">> & Options, mine: { generation?: number }): Promise<ObjectCrcOutcome> {
  const { r2Key } = message; const { attempts, now } = options; const db = env.DB; const rangeBytes = options.rangeBytes ?? CRC_RANGE_BYTES;
  const claimed = await claim(db, message, attempts, now);
  if (!claimed) return "stale";
  const generation = claimed.generation; mine.generation = generation;
  const write = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(r2Key, generation, ...binds);
  const head = await env.MEDIA.head(r2Key);
  if (!head) {
    await write(`UPDATE object_crc32_work SET state = 'failed', updated_at = ?3, last_error = 'The object is not in R2' WHERE ${fenced}`, now).run();
    return "missing";
  }
  if (message.etag === undefined) {
    const done = await db.prepare("SELECT etag, bytes FROM object_crc32 WHERE r2_key = ?1").bind(r2Key).first<{ etag: string; bytes: number }>();
    if (done && done.etag === head.etag && done.bytes === head.size) { await write(`DELETE FROM object_crc32_work WHERE ${fenced}`).run(); return "skipped"; }
  }
  let { offset, crc_partial: crc } = claimed;
  if (claimed.etag !== head.etag || claimed.bytes !== head.size) {
    // The row was never begun (no etag) or is for bytes that are gone. Under this claim, begin it on the object as it is now.
    await write(`UPDATE object_crc32_work SET etag = ?3, bytes = ?4, "offset" = 0, crc_partial = 0, last_error = NULL WHERE ${fenced}`, head.etag, head.size).run();
    offset = 0; crc = 0;
    if (claimed.etag !== null) return restart(env, r2Key, generation, head.etag, now);
  }
  const etag = head.etag; const size = head.size; const length = Math.min(rangeBytes, size - offset);
  if (length > 0) {
    const object = await env.MEDIA.get(r2Key, { range: { offset, length }, onlyIf: { etagMatches: etag } });
    if (!object) {
      await write(`UPDATE object_crc32_work SET state = 'failed', updated_at = ?3, last_error = 'The object is not in R2' WHERE ${fenced}`, now).run();
      return "missing";
    }
    // A failed precondition answers with the object's metadata and no body: it is no longer the object this run started on.
    if (!("body" in object) || !object.body) {
      await write(`UPDATE object_crc32_work SET etag = ?3, bytes = ?4, "offset" = 0, crc_partial = 0 WHERE ${fenced}`, object.etag, object.size).run();
      return restart(env, r2Key, generation, object.etag, now);
    }
    const read = await crcOfBody(object.body, length, crc, options.bufferBytes);
    // A short or long read is not a checksum of the range: throw, so the queue retries it.
    if (read.bytes !== length) throw new Error(`Object CRC read ${read.bytes} of ${length} bytes for ${r2Key} at ${offset}`);
    crc = read.crc;
  }
  const next = offset + length;
  if (next >= size) {
    // The last range: the result and the end of the work row land together, under this claim.
    const [, removed] = await db.batch([
      write(`INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) SELECT r2_key, ?3, bytes, etag, ?4 FROM object_crc32_work WHERE ${fenced}
        ON CONFLICT(r2_key) DO UPDATE SET crc32 = excluded.crc32, bytes = excluded.bytes, etag = excluded.etag, computed_at = excluded.computed_at`, crc, now),
      write(`DELETE FROM object_crc32_work WHERE ${fenced}`),
    ]);
    return removed!.meta.changes === 0 ? "stale" : "stored";
  }
  const advanced = await write(`UPDATE object_crc32_work SET "offset" = ?3, crc_partial = ?4, state = 'queued', updated_at = ?5 WHERE ${fenced}`, next, crc, now).run();
  if (advanced.meta.changes === 0) return "stale";
  // A lost send is repaired by the hourly sweep: the row goes quiet, and a row quiet for ten minutes counts as not live.
  await enqueueObjectCrcMessages(env, [{ type: "object_crc32", r2Key, etag, offset: next }], "object-crc-next-range");
  return "advanced";
}

/** The object changed under a run (the row is already reset to offset 0 on the new etag, under this claim): hand the row back and send the first range of the new run. */
async function restart(env: JobEnv, r2Key: string, generation: number, etag: string, now: number): Promise<ObjectCrcOutcome> {
  const queued = await env.DB.prepare(`UPDATE object_crc32_work SET state = 'queued', attempts = 0, last_error = NULL, updated_at = ?3 WHERE ${fenced}`).bind(r2Key, generation, now).run();
  if (queued.meta.changes === 0) return "stale";
  await enqueueObjectCrcMessages(env, [{ type: "object_crc32", r2Key, etag, offset: 0 }], "object-crc-restart");
  return "restarted";
}
