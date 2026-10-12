/**
 * The object CRC-32 queue (#802): the contract between the producers (the app's intent hooks, the background hourly sweep) and the background consumer. It is its own queue, `quincy-object-crcs`, so a
 * 6 s range read never waits behind, or holds up, a rendition. A message names one R2 object and, once a range has been read, the etag and offset to resume at; the work row in `object_crc32_work`
 * holds the running CRC.
 */
export const OBJECT_CRC_QUEUE_NAME = "quincy-object-crcs" as const;
/** Messages per `sendBatch` call: the queue's own cap. */
export const OBJECT_CRC_SEND_BATCH = 100;

/** `etag` and `offset` come together: both absent is a start (the consumer reads the object's head), both present is the next range of a run. */
export type ObjectCrcMessage = { type: "object_crc32"; r2Key: string; etag?: string; offset?: number };
type ObjectCrcQueue = { sendBatch(messages: Array<{ body: ObjectCrcMessage }>): Promise<unknown> };
export type ObjectCrcQueueEnv = { OBJECT_CRC_QUEUE?: ObjectCrcQueue };

export function parseObjectCrcMessage(value: unknown): ObjectCrcMessage | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.type !== "object_crc32" || typeof body.r2Key !== "string" || body.r2Key.length === 0) return null;
  if (body.etag === undefined && body.offset === undefined) return { type: "object_crc32", r2Key: body.r2Key };
  if (typeof body.etag !== "string" || body.etag.length === 0 || typeof body.offset !== "number" || !Number.isSafeInteger(body.offset) || body.offset < 0) return null;
  return { type: "object_crc32", r2Key: body.r2Key, etag: body.etag, offset: body.offset };
}

/**
 * Sends the messages in batches of at most 100 and returns how many were sent. Best effort, so it never throws: a send is a side effect of a write that has already committed, and a lost one
 * is repaired by the background Worker's hourly sweep. A failed batch is logged and the later ones are still tried.
 */
export async function enqueueObjectCrcMessages(env: ObjectCrcQueueEnv, messages: readonly ObjectCrcMessage[], source: string): Promise<number> {
  if (messages.length === 0) return 0;
  if (!env.OBJECT_CRC_QUEUE) { console.error("Object CRC enqueue skipped: no queue binding is configured", { count: messages.length, source }); return 0; }
  let sent = 0;
  for (let at = 0; at < messages.length; at += OBJECT_CRC_SEND_BATCH) {
    const batch = messages.slice(at, at + OBJECT_CRC_SEND_BATCH);
    try { await env.OBJECT_CRC_QUEUE.sendBatch(batch.map((body) => ({ body }))); sent += batch.length; }
    catch (error) { console.error("Object CRC enqueue failed; the hourly sweep queues it again", { count: batch.length, source, error }); }
  }
  return sent;
}

/** Start messages for the distinct R2 keys. */
export const enqueueObjectCrcs = (env: ObjectCrcQueueEnv, r2Keys: readonly string[], source: string): Promise<number> =>
  enqueueObjectCrcMessages(env, [...new Set(r2Keys)].map((r2Key): ObjectCrcMessage => ({ type: "object_crc32", r2Key })), source);
