export type AssetRenditionMessage = { type: "generate_renditions"; assetId: string };
/** The JPEG display copy of a HEIC embedded image (#495). Shares the rendition queue and its DLQ. */
export type EmbeddedDisplayMessage = {
  type: "embedded_display";
  mediaId: string;
  /** The row's `rendition_requested_at` when this message was sent: the generation of the run. Required. Only complete and a Retry write a new one, so a message from an older run (a stale DLQ redelivery) cannot touch the newer run. The recovery cron re-sends the SAME generation. */
  generation: number;
};
export type RenditionMessage = AssetRenditionMessage | EmbeddedDisplayMessage;

type RenditionQueue = { send(message: RenditionMessage): Promise<unknown> };
export type RenditionQueueEnv = { RENDITIONS_ENABLED?: boolean; RENDITION_QUEUE?: RenditionQueue };

/** The red-gate default: no automatic rendition work until configuration is explicitly enabled. */
export function renditionsEnabled(env: Pick<RenditionQueueEnv, "RENDITIONS_ENABLED">): boolean {
  return env.RENDITIONS_ENABLED === true;
}

/**
 * Queue handoff is a best-effort side effect after the immutable asset commit. Failures remain
 * observable in Worker logs and are repairable through the bounded backfill/reconciliation path.
 */
export async function enqueueRenditionSafely(env: RenditionQueueEnv, assetId: string, source: string): Promise<boolean> {
  if (!renditionsEnabled(env)) return false;
  if (!env.RENDITION_QUEUE) {
    console.error("Rendition enqueue skipped: RENDITIONS_ENABLED is true but no queue binding is configured", { assetId, source });
    return false;
  }
  try {
    await env.RENDITION_QUEUE.send({ type: "generate_renditions", assetId });
    return true;
  } catch (error) {
    console.error("Rendition enqueue failed; the asset remains eligible for backfill", { assetId, source, error });
    return false;
  }
}

/** Hands a HEIC row to the rendition queue. Best effort like `enqueueRenditionSafely`: a lost send is repaired by the minute cron's recovery of stale `pending` rows. */
export async function enqueueEmbeddedDisplaySafely(env: RenditionQueueEnv, mediaId: string, source: string, generation: number): Promise<boolean> {
  if (!renditionsEnabled(env)) return false;
  if (!env.RENDITION_QUEUE) {
    console.error("Embedded display enqueue skipped: RENDITIONS_ENABLED is true but no queue binding is configured", { mediaId, source });
    return false;
  }
  try {
    await env.RENDITION_QUEUE.send({ type: "embedded_display", mediaId, generation });
    return true;
  } catch (error) {
    console.error("Embedded display enqueue failed; the recovery cron re-sends a stale pending row", { mediaId, source, error });
    return false;
  }
}
