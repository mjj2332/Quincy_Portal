export type RenditionMessage = { type: "generate_renditions"; assetId: string };

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
