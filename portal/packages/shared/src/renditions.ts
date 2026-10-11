import { ANY_RENDITION_VARIANTS, RENDITION_VARIANT_SPEC, type AnyRenditionVariant } from "./media";

/** One message type for every asset rendition. `variants` picks which to build; absent means the QA pair (`thumb`, `web`), so every producer, in-flight message and DLQ replay from before #787 is unchanged. */
export type AssetRenditionMessage = { type: "generate_renditions"; assetId: string; variants?: readonly AnyRenditionVariant[] };
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

/** The slice of a D1 binding the enqueue reads through (declared structurally: this package is also compiled for the browser, which has no D1 types). */
type DerivativeDb = { prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } } };
type DeliveryDerivativeEnv = RenditionQueueEnv & { DB: DerivativeDb };
type DerivativeRow = { id: string; premium: number; inSet: number; hasDeliveryWeb: number; hasPremiumPreview: number };

/**
 * Enqueues the Client Delivery derivatives (#787 slice 4) an asset still needs, one `generate_renditions` message per photo with the missing `variants`. The rule is the same for every trigger
 * (Publish, marking premium, a supersede carry): a photo needs `premium_preview` when `delivery_premium = 1`, and `delivery_web` when it is a member of any Delivery set, each unless a row at the
 * variant's current spec exists. Only photos: a PDF or Video has neither. Best effort like `enqueueRenditionSafely`; the next trigger repairs a lost send. Returns how many messages were sent.
 */
export async function enqueueDeliveryDerivativesSafely(env: DeliveryDerivativeEnv, assetIds: readonly string[], source: string): Promise<number> {
  if (!renditionsEnabled(env) || assetIds.length === 0) return 0;
  if (!env.RENDITION_QUEUE) {
    console.error("Delivery derivative enqueue skipped: RENDITIONS_ENABLED is true but no queue binding is configured", { source });
    return 0;
  }
  let sent = 0;
  try {
    const rows = (await env.DB.prepare(`SELECT a.id AS id, a.delivery_premium AS premium,
        EXISTS (SELECT 1 FROM delivery_set_items i WHERE i.asset_id = a.id) AS inSet,
        EXISTS (SELECT 1 FROM asset_renditions r WHERE r.asset_id = a.id AND r.variant = 'delivery_web' AND r.spec_version = ?2) AS hasDeliveryWeb,
        EXISTS (SELECT 1 FROM asset_renditions r WHERE r.asset_id = a.id AND r.variant = 'premium_preview' AND r.spec_version = ?3) AS hasPremiumPreview
      FROM assets a WHERE a.kind = 'photo' AND a.id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify([...new Set(assetIds)]), RENDITION_VARIANT_SPEC.delivery_web, RENDITION_VARIANT_SPEC.premium_preview).all<DerivativeRow>()).results;
    for (const row of rows) {
      const variants: AnyRenditionVariant[] = [];
      if (row.inSet === 1 && row.hasDeliveryWeb === 0) variants.push("delivery_web");
      if (row.premium === 1 && row.hasPremiumPreview === 0) variants.push("premium_preview");
      if (variants.length === 0) continue;
      try {
        await env.RENDITION_QUEUE.send({ type: "generate_renditions", assetId: row.id, variants });
        sent += 1;
      } catch (error) {
        console.error("Delivery derivative enqueue failed; the next Publish, premium mark or carry re-enqueues it", { assetId: row.id, source, error });
      }
    }
  } catch (error) {
    console.error("Delivery derivative enqueue failed reading the assets", { source, error });
  }
  return sent;
}

/** Parses the optional `variants` of a queue body: absent is `undefined`, a well-formed non-empty list of distinct known names is itself, anything else is `null` (malformed). */
export function parseRenditionVariants(value: unknown): readonly AnyRenditionVariant[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) return null;
  return value.every((name): name is AnyRenditionVariant => (ANY_RENDITION_VARIANTS as readonly unknown[]).includes(name)) ? (value as AnyRenditionVariant[]) : null;
}
