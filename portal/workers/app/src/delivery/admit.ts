import type { Context } from "hono";
import type { AppEnv } from "../env";
import { clientDeliveryGate } from "../lib/client-delivery-gate";

/** The page behind a slug, shared by the page read, the items and the photo zips. */
export const SLUG_MAX = 96;
/** Matches against the path exactly as the client sent it, never a decoded parameter. */
export const rawPath = (c: Context<AppEnv, string>): string => new URL(c.req.url).pathname;
export const slugOk = (slug: string | undefined): slug is string => slug !== undefined && slug.length <= SLUG_MAX;

/** The page behind a slug: enabled, its Client Delivery gate open, and the latest set. Null is every kind of miss. */
export async function admitPage(db: D1Database, slug: string): Promise<{ projectId: string; setId: string; setNumber: number } | null> {
  const page = await db.prepare(`SELECT p.project_id AS projectId, s.id AS setId, s.set_number AS setNumber FROM delivery_pages p
      JOIN delivery_sets s ON s.project_id = p.project_id AND s.set_number = p.latest_set_number WHERE p.slug = ?1 AND p.enabled = 1`).bind(slug).first<{ projectId: string; setId: string; setNumber: number }>();
  if (!page || !await clientDeliveryGate(db, page.projectId)) return null;
  return page;
}
