import { enqueueRenditionSafely } from "@quincy/shared";
import type { Env } from "./env";

/**
 * Do not let a Dropbox-published asset complete its job until its rendition work is durable.
 * The caller leaves publish_status ready so a retry only repeats this idempotent handoff.
 */
export async function enqueueManualEditedRenditions(env: Env, assetId: string): Promise<void> {
  if (!await enqueueRenditionSafely(env, assetId, "manual-edited-publish")) {
    throw new Error(`Rendition queue handoff failed for manual edited upload ${assetId}`);
  }
}
