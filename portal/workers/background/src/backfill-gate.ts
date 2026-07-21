import { renditionsEnabled } from "@quincy/shared";

export type BackfillGateEnv = { APP_ENV: string; ALLOW_PRODUCTION_RENDITION_BACKFILL?: string; RENDITIONS_ENABLED?: boolean };
export type BackfillGateInput = { confirmProduction?: boolean };

/** Dry runs do not call this gate. Mutating production requires two independently controlled
 * switches: deployment configuration and an intentional operator request body. */
export function canMutateRenditionBackfill(env: BackfillGateEnv, input: BackfillGateInput): string | null {
  if (!renditionsEnabled(env)) return "Renditions are disabled until the multi-PoP gate is green and RENDITIONS_ENABLED is enabled";
  if (env.APP_ENV === "production" && env.ALLOW_PRODUCTION_RENDITION_BACKFILL !== "1") return "Production rendition backfill requires ALLOW_PRODUCTION_RENDITION_BACKFILL=1";
  if (env.APP_ENV === "production" && input.confirmProduction !== true) return "Production rendition backfill requires confirmProduction: true";
  return null;
}
