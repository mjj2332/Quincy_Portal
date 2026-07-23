import type { Context } from "hono";
import type { AppEnv } from "../env";

/**
 * Manual Edited uploads are private pipeline records until Dropbox publication succeeds.
 * Other collection kinds do not use this lifecycle and must remain directly accessible.
 */
export function isUserVisibleAsset(
  collectionKind: string,
  publishStatus: string,
): boolean {
  return collectionKind !== "edited" || publishStatus === "ready";
}

/** Return an indistinguishable not-found response so unpublished asset IDs cannot be probed. */
export function unpublishedAssetResponse(c: Context<AppEnv>): Response {
  return c.json({ error: "Asset not found" }, 404);
}
