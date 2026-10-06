import { EMBEDDED_DISPLAY_MAX_EDGE, embeddedMediaDisplayKey, inspectJpeg } from "@quincy/shared";

/**
 * The embedded-media helpers that both Workers run (#495): the app Worker serves and cleans up, the background Worker makes the HEIC
 * display copy. They live here, in a package both already import, so the cleanup SQL has one copy and the app's HTTP tests can run the
 * conversion. Nothing in this file knows how a transform URL is signed: the caller injects it.
 */
export type EmbeddedMediaStores = { DB: D1Database; MEDIA: R2Bucket };

export type CleanupEntry = { key: string; uploadId?: string | null; projectId?: string | null };

/**
 * Hands R2 objects (and the multipart uploads that may still create them) to the durable cleanup queue
 * (`embedded_media_cleanup`), which the background sweep drains. Idempotent: a key already queued keeps its row,
 * and gains an upload id if it had none.
 */
export async function enqueueEmbeddedMediaCleanup(db: D1Database, entries: CleanupEntry[], now = Date.now()): Promise<void> {
  if (!entries.length) return;
  await db.batch(entries.map((entry) => db.prepare(`
    INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at), claimed_until = NULL
  `).bind(entry.key, entry.uploadId ?? null, entry.projectId ?? null, now)));
}

/**
 * Gives up an R2 object nothing references (a video poster, a link preview image, a HEIC display copy): on a lost adoption and on an adoption that threw. Deletes the object, then its queue
 * entry (a leftover entry is harmless, the sweep deletes an already-gone object). If R2 refuses, the key is queued again with the
 * lease cleared. Accepted residual gap: when the R2 delete AND that following D1 write both fail back to back, the object is an orphan
 * nothing tracks. That is logged loudly with the key (see docs/lessons.md), and the daily orphan sweep (`workers/background/src/embedded-media-orphan-sweep.ts`, #549) queues it once it is a week old.
 */
export async function discardUnreferencedObject(env: EmbeddedMediaStores, posterKey: string, projectId: string | null): Promise<void> {
  let deleted = false;
  try { await env.MEDIA.delete(posterKey); deleted = true; } catch { /* queued below */ }
  if (deleted) {
    try { await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ?").bind(posterKey).run(); } catch { /* the sweep drops the entry of a gone object */ }
    return;
  }
  try { await enqueueEmbeddedMediaCleanup(env.DB, [{ key: posterKey, projectId }]); }
  catch (error) { console.error("Embedded object ORPHANED: the R2 delete and the re-queue both failed, the object needs manual cleanup", { key: posterKey, projectId, error: error instanceof Error ? error.message : String(error) }); }
}

/**
 * Decides, after an adoption batch threw, what to do with the object it was meant to adopt (a video poster, a link preview image, a HEIC display copy).
 * A throw can follow a commit, so the outcome comes from reading the row, in three: `adopted` (the row references the object, it is
 * live and stays), `discarded` (confirmed not adopted, so the object is deleted, re-queued if R2 refuses, see `discardUnreferencedObject`),
 * or `unknown` (the read threw too). Unknown deletes nothing and queues nothing, since either could destroy a live object: the object
 * stays, an unadopted queue entry is still the sweep's to reclaim, and the key is logged with the batch's error.
 */
export async function settleThrownAdoption(env: EmbeddedMediaStores, input: { key: string; projectId: string | null; mediaId: string; what: string; isAdopted: () => Promise<boolean>; error: unknown }): Promise<"adopted" | "discarded" | "unknown"> {
  let adopted: boolean;
  try { adopted = await input.isAdopted(); }
  catch {
    console.error(`${input.what} adoption outcome UNKNOWN: the batch threw and the verification read failed, the object was kept (a leak is possible, accepted gap #549)`, { key: input.key, mediaId: input.mediaId, projectId: input.projectId, error: input.error instanceof Error ? input.error.message : String(input.error) });
    return "unknown";
  }
  if (adopted) return "adopted";
  await discardUnreferencedObject(env, input.key, input.projectId);
  return "discarded";
}

/** How long one conversion attempt holds the row. A crashed worker's lease lapses and the next delivery or the recovery cron takes over. */
export const EMBEDDED_DISPLAY_LEASE_MS = 5 * 60 * 1000;
/** A row is failed once it has been claimed this many times (the queue's first delivery plus its three retries). */
export const EMBEDDED_DISPLAY_MAX_ATTEMPTS = 4;
/** The most JPEG bytes a display copy may have. A 4096 px photo at quality 85 is a few MiB. */
export const EMBEDDED_DISPLAY_MAX_BYTES = 20 * 1024 * 1024;

export type EmbeddedDisplayDeps = {
  /** The Image Transformations URL that returns the original as a JPEG display copy (`format=jpeg,metadata=none`), against a freshly signed source URL. */
  transformUrl(originalKey: string): Promise<string>;
  /** Must be a wrapped call of the global `fetch`, not the bare function (an unbound `fetch` throws "Illegal invocation"). */
  fetch: typeof fetch;
  now?: () => number;
  newNonce?: () => string;
  /**
   * The `rendition_requested_at` the queue message was sent for (its generation). Required. Only complete and a Retry write a new value, so a message
   * from an older generation claims nothing. The recovery cron re-sends the same generation.
   */
  generation: number;
};

/**
 * `ready`: this call made the display copy. `noop`: nothing to do (the row is ready, failed, gone, swept or leased, so a duplicate or a cron re-send
 * lands here). `failed`: the row is now `failed`. `lost`: the copy was made but the row no longer wanted it, and it was discarded.
 */
export type EmbeddedDisplayOutcome = "ready" | "noop" | "failed" | "lost";

/** A failure a redelivery may cure (the edge, the network, a configuration the owner can fix). The lease is released and the caller throws, which retries the message. */
export class EmbeddedDisplayTransientError extends Error {}
/** A failure no redelivery can cure (the file cannot be decoded, the output is wrong). The row is set `failed`. */
class EmbeddedDisplayPermanentError extends Error {}

type ClaimedRow = { original_key: string; project_id: string | null; rendition_attempts: number; rendition_requested_at: number | null };

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw new EmbeddedDisplayTransientError("The transformation response has no body");
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => undefined); throw new EmbeddedDisplayPermanentError(`The display copy is larger than ${limit} bytes`); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EmbeddedDisplayPermanentError) throw error;
    throw new EmbeddedDisplayTransientError(`The transformation body could not be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally { try { reader.releaseLock(); } catch { /* cancelled */ } }
  if (total === 0) throw new EmbeddedDisplayTransientError("The transformation output is empty");
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

const shortError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);

/** True when a response status (and what the edge said about it) is one a retry may cure. */
function isTransientResponse(response: Response, resized: string): boolean {
  if (response.status >= 500 || response.status === 408 || response.status === 429) return true;
  if (/(?:^|[;,\s])err=9401\b/i.test(resized)) return true;
  return response.status === 403 && /html/i.test(response.headers.get("content-type") ?? "");
}

/**
 * Makes the JPEG display copy of a HEIC embedded image (#495). Claim, transform, check, adopt:
 *
 * 1. Claim the row with a five minute lease and an attempt count. No row means ready, failed, gone, swept or leased: a duplicate is a no-op.
 * 2. Ask Image Transformations for a JPEG, at most 4096 px, with metadata stripped, from a signed source URL.
 * 3. Check the output is a JPEG of that size and carries no EXIF or XMP segment (so stripping GPS is a check, not a hope). A HEIC passed through
 *    untransformed fails the content-type check, so the original can never become the display copy.
 * 4. Adopt claim-first, as the video poster does: queue the key, write the object, then one batch sets the row `ready` and unqueues the key,
 *    only if the row still wants it. A lost batch deletes the object. A thrown batch decides from what the row says.
 *
 * A transient failure releases the lease first (or the immediate redelivery would find it held and ack) and throws. A permanent one sets `failed`.
 */
export async function generateEmbeddedDisplay(env: EmbeddedMediaStores, mediaId: string, deps: EmbeddedDisplayDeps): Promise<EmbeddedDisplayOutcome> {
  const now = deps.now ?? Date.now;
  const claimedAt = now();
  const claim = await env.DB.prepare(`
    UPDATE embedded_media SET rendition_lease_until = ?, rendition_attempts = rendition_attempts + 1
    WHERE id = ? AND rendition_status = 'pending' AND state IN ('pending', 'attached') AND (rendition_lease_until IS NULL OR rendition_lease_until < ?)
      AND rendition_requested_at = ?
    RETURNING original_key, project_id, rendition_attempts, rendition_requested_at
  `).bind(claimedAt + EMBEDDED_DISPLAY_LEASE_MS, mediaId, claimedAt, deps.generation).all<ClaimedRow>();
  const row = claim.results[0];
  if (!row) return "noop";
  const attempts = row.rendition_attempts; const projectId = row.project_id; const generation = row.rendition_requested_at;
  // Every write after the claim is fenced on the attempt count AND the generation the claim saw: a Retry resets the attempts to 0, so a stale run
  // and the new run can hold the same count, and only `rendition_requested_at` tells them apart (`IS` so a NULL generation matches itself).

  const release = async () => {
    try { await env.DB.prepare("UPDATE embedded_media SET rendition_lease_until = 0 WHERE id = ? AND rendition_status = 'pending' AND rendition_attempts = ? AND rendition_requested_at IS ?").bind(mediaId, attempts, generation).run(); }
    catch { /* the lease lapses on its own */ }
  };
  const fail = async (reason: string): Promise<EmbeddedDisplayOutcome> => {
    try {
      await env.DB.prepare("UPDATE embedded_media SET rendition_status = 'failed', rendition_error = ?, rendition_lease_until = NULL, updated_at = ? WHERE id = ? AND rendition_status = 'pending' AND rendition_attempts = ? AND rendition_requested_at IS ?").bind(reason, now(), mediaId, attempts, generation).run();
    } catch (error) {
      // A transient D1 error must not strand the row: an unreleased lease makes the redelivery a no-op that acks, and the image would sit pending until the cron.
      await release();
      throw error;
    }
    return "failed";
  };
  if (attempts > EMBEDDED_DISPLAY_MAX_ATTEMPTS) return fail("attempts");

  let body: Uint8Array; let width: number; let height: number;
  try {
    let response: Response;
    try { response = await deps.fetch(await deps.transformUrl(row.original_key), { headers: { accept: "image/jpeg" } }); }
    catch (error) { throw new EmbeddedDisplayTransientError(`The transformation request failed: ${shortError(error)}`); }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "missing";
    const resized = response.headers.get("cf-resized") ?? "";
    const edgeOk = response.ok && contentType === "image/jpeg" && !/(?:^|[;,\s])err=/i.test(resized) && /(?:^|[;,\s])internal=ok/i.test(resized);
    if (!edgeOk) {
      const detail = `transform status=${response.status} content-type=${contentType} cf-resized=${resized || "missing"}`;
      await response.body?.cancel().catch(() => undefined);
      throw isTransientResponse(response, resized) ? new EmbeddedDisplayTransientError(detail) : new EmbeddedDisplayPermanentError(detail);
    }
    body = await readBounded(response.body, EMBEDDED_DISPLAY_MAX_BYTES);
    const inspected = inspectJpeg(body);
    if (!inspected) throw new EmbeddedDisplayPermanentError("output is not a readable JPEG");
    if (inspected.width > EMBEDDED_DISPLAY_MAX_EDGE || inspected.height > EMBEDDED_DISPLAY_MAX_EDGE) throw new EmbeddedDisplayPermanentError(`output is ${inspected.width}x${inspected.height}, over ${EMBEDDED_DISPLAY_MAX_EDGE}`);
    if (inspected.metadata) throw new EmbeddedDisplayPermanentError("output still carries EXIF or XMP");
    width = inspected.width; height = inspected.height;
  } catch (error) {
    if (error instanceof EmbeddedDisplayPermanentError) { console.error("Embedded display copy failed permanently", { mediaId, attempts, reason: shortError(error) }); return fail(shortError(error)); }
    await release();
    throw error;
  }

  const displayKey = embeddedMediaDisplayKey(projectId, mediaId, (deps.newNonce ?? (() => crypto.randomUUID()))());
  // The queue entry is the fence: the adopting batch needs it to exist, unchanged and unleased, and removes it in the same batch.
  // A sweep or drain that claimed it, finished and dequeued it, or a re-queue that bumped it all make the adoption lose.
  const queuedAt = now();
  try { await env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(displayKey, projectId, queuedAt).run(); }
  catch (error) { await release(); throw new EmbeddedDisplayTransientError(`The cleanup entry could not be queued: ${shortError(error)}`); }
  try { await env.MEDIA.put(displayKey, body, { httpMetadata: { contentType: "image/jpeg" } }); }
  catch (error) {
    // A PUT that throws may still have committed (the acknowledgement was lost), so the object is deleted, and its entry only goes once that succeeded: if R2 refuses, the entry stays queued for the drain.
    await discardUnreferencedObject(env, displayKey, projectId);
    await release();
    throw new EmbeddedDisplayTransientError(`The display copy could not be stored: ${shortError(error)}`);
  }
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE embedded_media SET display_key = ?, display_content_type = 'image/jpeg', display_bytes = ?, display_width = ?, display_height = ?, rendition_status = 'ready', rendition_lease_until = NULL, rendition_error = NULL, updated_at = ?
        WHERE id = ? AND rendition_status = 'pending' AND display_key IS NULL AND state IN ('pending', 'attached') AND rendition_attempts = ? AND rendition_requested_at IS ?
          AND EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL)
      `).bind(displayKey, body.byteLength, width, height, now(), mediaId, attempts, generation, displayKey, queuedAt),
      env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL AND (SELECT display_key FROM embedded_media WHERE id = ?) = ?").bind(displayKey, queuedAt, mediaId, displayKey),
    ]);
  } catch (error) {
    // A throw can still follow a commit: adopted keeps the copy, a confirmed miss discards it, unknown keeps it and retries.
    const outcome = await settleThrownAdoption(env, { key: displayKey, projectId, mediaId, what: "Embedded display copy", error, isAdopted: async () => (await env.DB.prepare("SELECT display_key AS displayKey FROM embedded_media WHERE id = ?").bind(mediaId).first<{ displayKey: string | null }>())?.displayKey === displayKey });
    if (outcome === "adopted") return "ready";
    await release();
    throw error;
  }
  if ((results[0]!.meta.changes ?? 0) === 1) {
    console.log("Embedded display copy ready", { mediaId, attempts, bytes: body.byteLength, width, height, waitMs: row.rendition_requested_at === null ? null : now() - row.rendition_requested_at });
    return "ready";
  }
  // Lost: the row was swept, deleted or re-queued meanwhile. Nothing references the object, and a sweep's claim on its entry can never be undone.
  await discardUnreferencedObject(env, displayKey, projectId);
  return "lost";
}
