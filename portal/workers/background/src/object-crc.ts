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
type Work = { etag: string | null; bytes: number | null; offset: number; crc_partial: number; state: "queued" | "running" | "failed"; updated_at: number; generation: number };

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

const readWork = (db: D1Database, r2Key: string) => db.prepare('SELECT etag, bytes, "offset", crc_partial, state, updated_at, generation FROM object_crc32_work WHERE r2_key = ?1').bind(r2Key).first<Work>();
const truncate = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** What a message holds once it has claimed a range: its failures, advances and finish are all fenced on this and nothing else. */
type Owned = { etag: string; offset: number; generation: number };

/** Processes one message: a start (no etag) or the next range of a run. Returns the outcome. Throws so the queue retries, until the last attempt, which records `failed` and returns. */
export async function processObjectCrc(env: JobEnv, message: ObjectCrcMessage, options: Options = {}): Promise<ObjectCrcOutcome> {
  const attempts = options.attempts ?? 1; const now = options.now ?? Date.now(); const owned: { current?: Owned } = {};
  try { return await runRange(env, message, { ...options, attempts, now }, owned); }
  catch (error) {
    const final = attempts >= CRC_MAX_ATTEMPTS; const text = truncate(error);
    if (owned.current) {
      // Fenced on the claim this delivery holds: a takeover or a restart moved the generation, and then this failure belongs to nobody.
      const { etag, offset, generation } = owned.current;
      await env.DB.prepare(`UPDATE object_crc32_work SET attempts = ?1, last_error = ?2, updated_at = ?3${final ? ", state = 'failed'" : ""} WHERE r2_key = ?4 AND etag = ?5 AND "offset" = ?6 AND generation = ?7 AND state = 'running'`).bind(attempts, text, now, message.r2Key, etag, offset, generation).run();
    } else if (final && message.etag === undefined) {
      // Nothing was claimed, so no existing row is touched. A start for a key with no row at all is recorded, so the failure is not silent.
      await env.DB.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at, last_error) VALUES (?1, 'failed', ?2, ?3, ?3, ?4) ON CONFLICT(r2_key) DO NOTHING`).bind(message.r2Key, attempts, now, text).run();
    }
    if (!final) throw error;
    console.error("Object CRC failed for good", { r2Key: message.r2Key, attempts, error: text });
    return "failed";
  }
}

async function runRange(env: JobEnv, message: ObjectCrcMessage, options: Required<Pick<Options, "attempts" | "now">> & Options, owned: { current?: Owned }): Promise<ObjectCrcOutcome> {
  const { r2Key } = message; const { attempts, now } = options; const db = env.DB;
  const rangeBytes = options.rangeBytes ?? CRC_RANGE_BYTES; const continuation = message.etag !== undefined;
  let work = await readWork(db, r2Key);
  // A continuation must still be the run the row is on before it looks at R2: an obsolete one that sees the object gone, or changed, must not act on a run that replaced it.
  if (continuation && (!work || work.state === "failed" || work.etag !== message.etag || work.offset !== message.offset)) return "stale";
  const head = await env.MEDIA.head(r2Key);
  if (!head) return markMissing(db, r2Key, now, continuation ? { etag: message.etag!, offset: message.offset! } : undefined);
  if (!continuation) {
    const done = await db.prepare("SELECT etag, bytes FROM object_crc32 WHERE r2_key = ?1").bind(r2Key).first<{ etag: string; bytes: number }>();
    if (done && done.etag === head.etag && done.bytes === head.size) { await db.prepare("DELETE FROM object_crc32_work WHERE r2_key = ?1 AND state != 'running'").bind(r2Key).run(); return "skipped"; }
    work = await readWork(db, r2Key);
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
  if (head.etag !== work.etag) return restart(env, r2Key, work.etag, work.generation, head.etag, head.size, now);
  const { etag, bytes: size } = work as Work & { etag: string; bytes: number };
  // Claim the range. A queued row is claimable; a running one only by a retry of its own message or once it has gone quiet. The claim hands out the next generation.
  const claimed = await db.prepare(`UPDATE object_crc32_work SET state = 'running', attempts = ?5, updated_at = ?4, generation = generation + 1 WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND (state = 'queued' OR (state = 'running' AND (?5 > 1 OR updated_at <= ?6))) RETURNING generation`)
    .bind(r2Key, etag, work.offset, now, attempts, now - CRC_STALE_MS).first<{ generation: number }>();
  if (!claimed) return "stale";
  const generation = claimed.generation; const offset = work.offset;
  owned.current = { etag, offset, generation };
  const length = Math.min(rangeBytes, size - offset);
  let crc = work.crc_partial;
  if (length > 0) {
    const object = await env.MEDIA.get(r2Key, { range: { offset, length }, onlyIf: { etagMatches: etag } });
    if (!object) return markMissing(db, r2Key, now, { etag, offset, generation });
    // A failed precondition answers with the object's metadata and no body: it is no longer the object this run started on.
    if (!("body" in object) || !object.body) return restart(env, r2Key, etag, generation, object.etag, object.size, now);
    const read = await crcOfBody(object.body, length, crc, options.bufferBytes);
    // A short or long read is not a checksum of the range: throw, so the queue retries it.
    if (read.bytes !== length) throw new Error(`Object CRC read ${read.bytes} of ${length} bytes for ${r2Key} at ${offset}`);
    crc = read.crc;
  }
  const next = offset + length;
  if (next >= size) {
    // The last range: the result and the end of the work row land together, and only for the owner that read it.
    const [, removed] = await db.batch([
      db.prepare(`INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) SELECT r2_key, ?5, bytes, etag, ?6 FROM object_crc32_work WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND generation = ?4 AND state = 'running'
        ON CONFLICT(r2_key) DO UPDATE SET crc32 = excluded.crc32, bytes = excluded.bytes, etag = excluded.etag, computed_at = excluded.computed_at`).bind(r2Key, etag, offset, generation, crc, now),
      db.prepare(`DELETE FROM object_crc32_work WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND generation = ?4 AND state = 'running'`).bind(r2Key, etag, offset, generation),
    ]);
    return removed!.meta.changes === 0 ? "stale" : "stored";
  }
  const advanced = await db.prepare(`UPDATE object_crc32_work SET "offset" = ?5, crc_partial = ?6, state = 'queued', updated_at = ?7 WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?3 AND generation = ?4 AND state = 'running'`).bind(r2Key, etag, offset, generation, next, crc, now).run();
  if (advanced.meta.changes === 0) return "stale";
  // A lost send is repaired by the hourly sweep: the row goes quiet, and a row quiet for ten minutes counts as not live.
  await enqueueObjectCrcMessages(env, [{ type: "object_crc32", r2Key, etag, offset: next }], "object-crc-next-range");
  return "advanced";
}

/**
 * A queued key whose object is not in R2 is recorded as `failed`, not forgotten. Forgotten, the hourly sweep would queue it again every hour, and enough of them would fill its cap and starve the keys behind them.
 * A `failed` row is skipped by the sweep and answers a download with 502; deleting it (once the object is restored) is the way back.
 * Only the run that owns the row may record it: a claimed range by its generation, a validated continuation by its etag and offset. A start touches a row nobody has begun (no etag) or inserts one, and leaves a run in progress to its own continuation.
 */
async function markMissing(db: D1Database, r2Key: string, now: number, run?: { etag: string; offset: number; generation?: number }): Promise<ObjectCrcOutcome> {
  const error = "The object is not in R2";
  if (!run) await db.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at, last_error) VALUES (?1, 'failed', 0, ?2, ?2, ?3) ON CONFLICT(r2_key) DO UPDATE SET state = 'failed', updated_at = excluded.updated_at, last_error = excluded.last_error WHERE object_crc32_work.etag IS NULL AND object_crc32_work.state = 'queued'`).bind(r2Key, now, error).run();
  else await db.prepare(`UPDATE object_crc32_work SET state = 'failed', updated_at = ?3, last_error = ?4 WHERE r2_key = ?1 AND etag = ?2 AND "offset" = ?5 AND state != 'failed' AND (?6 IS NULL OR (generation = ?6 AND state = 'running'))`).bind(r2Key, run.etag, now, error, run.offset, run.generation ?? null).run();
  return "missing";
}

/** The object changed under a run: start over from offset 0 on the new etag. Only the owner of `generation` may do it, and it takes the next generation, so anything still holding the old one is fenced out. */
async function restart(env: JobEnv, r2Key: string, from: string, generation: number, etag: string, size: number, now: number): Promise<ObjectCrcOutcome> {
  const reset = await env.DB.prepare(`UPDATE object_crc32_work SET etag = ?3, bytes = ?4, "offset" = 0, crc_partial = 0, state = 'queued', attempts = 0, last_error = NULL, updated_at = ?5, generation = generation + 1 WHERE r2_key = ?1 AND etag = ?2 AND generation = ?6 AND state != 'failed'`).bind(r2Key, from, etag, size, now, generation).run();
  if (reset.meta.changes === 0) return "stale";
  await enqueueObjectCrcMessages(env, [{ type: "object_crc32", r2Key, etag, offset: 0 }], "object-crc-restart");
  return "restarted";
}
