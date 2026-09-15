import type { Env } from "../env";

/**
 * Tonomo lowercases the rawFolderPath it sends, but every payload also carries the property's
 * formatted address in its original casing, and Tonomo names the RAW folder from that address
 * with "/" replaced by "-" (verified against all 26 stored paths on 2026-09-15). This is the only
 * original-cased source that survives the folder itself being deleted.
 */
export async function latestTonomoFormattedAddress(env: Env, orderId: string | null): Promise<string | null> {
  if (!orderId) return null;
  const row = await env.DB.prepare(
    `SELECT formatted_address FROM (
       SELECT received_at, COALESCE(
         json_extract(payload_json, '$.order.property_address.formatted_address'),
         json_extract(payload_json, '$.property_address.formatted_address'),
         json_extract(payload_json, '$.order.manualPropertyAddress.formattedAddress'),
         json_extract(payload_json, '$.manualPropertyAddress.formattedAddress')
       ) AS formatted_address
       FROM webhook_events
       WHERE source = 'tonomo'
         AND COALESCE(
           json_extract(payload_json, '$.order.order_id'), json_extract(payload_json, '$.order.orderId'), json_extract(payload_json, '$.order.id'),
           json_extract(payload_json, '$.order_id'), json_extract(payload_json, '$.orderId'), json_extract(payload_json, '$.id')
         ) = ?
     )
     WHERE formatted_address IS NOT NULL
     ORDER BY received_at DESC LIMIT 1`,
  ).bind(orderId).first<{ formatted_address: string }>();
  const value = row?.formatted_address?.trim();
  return value ? value : null;
}
