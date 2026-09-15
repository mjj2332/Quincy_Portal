import type { Env } from "../env";

/**
 * Tonomo lowercases the rawFolderPath it sends, but every payload also carries the property's
 * formatted address in its original casing, and Tonomo names the RAW folder from that address
 * with "/" replaced by "-" (verified against all 26 stored paths on 2026-09-15). This is the only
 * original-cased source that survives the folder itself being deleted.
 */
export async function latestTonomoFormattedAddress(env: Env, orderId: string | null): Promise<string | null> {
  if (!orderId) return null;
  // Tonomo posts either one order object or a one-element array of it (parseTonomoOrder unwraps
  // the same way), and the "changed" envelope nests the order under $.order.
  const row = await env.DB.prepare(
    `WITH events AS (
       SELECT received_at,
         CASE WHEN json_type(payload_json) = 'array' THEN json_extract(payload_json, '$[0]') ELSE payload_json END AS body
       FROM webhook_events WHERE source = 'tonomo' AND json_valid(payload_json)
     ), orders AS (
       SELECT received_at,
         COALESCE(
           json_extract(body, '$.order.property_address.formatted_address'),
           json_extract(body, '$.property_address.formatted_address'),
           json_extract(body, '$.order.manualPropertyAddress.formattedAddress'),
           json_extract(body, '$.manualPropertyAddress.formattedAddress')
         ) AS formatted_address,
         COALESCE(
           json_extract(body, '$.order.order_id'), json_extract(body, '$.order.orderId'), json_extract(body, '$.order.id'),
           json_extract(body, '$.order_id'), json_extract(body, '$.orderId'), json_extract(body, '$.id')
         ) AS order_id
       FROM events
     )
     SELECT formatted_address FROM orders
     WHERE CAST(order_id AS TEXT) = ? AND formatted_address IS NOT NULL
     ORDER BY received_at DESC LIMIT 1`,
  ).bind(orderId).first<{ formatted_address: string }>();
  const value = row?.formatted_address?.trim();
  return value ? value : null;
}
