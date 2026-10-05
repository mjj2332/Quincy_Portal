import { EMBEDDED_DISPLAY_MAX_EDGE } from "@quincy/shared";
import { generateEmbeddedDisplay, type EmbeddedDisplayOutcome } from "@quincy/db";
import type { Env } from "./env";
import { resolveTransformPrincipal, signedTransformUrl } from "./renditions";

/** A 4096 px JPEG at quality 85 with all metadata (EXIF, GPS, XMP) dropped. The consumer checks the output for it, so this is not trusted on its own. */
const DISPLAY_OPTIONS = `width=${EMBEDDED_DISPLAY_MAX_EDGE},height=${EMBEDDED_DISPLAY_MAX_EDGE},fit=scale-down,quality=85,format=jpeg,metadata=none`;

type DisplayEnv = Pick<Env, "APP_ORIGIN" | "TRANSFORM_SOURCE_SECRET" | "TRANSFORM_SOURCE_PRINCIPAL_ID" | "TRANSFORM_SOURCE_AUTHORIZATION_EPOCH" | "MEDIA" | "DB">;

/**
 * Makes a HEIC embedded image's JPEG display copy (#495): the shared lifecycle in `@quincy/db` with this Worker's signing wired in.
 * Each attempt signs a fresh source URL, so each is one billed transformation: the attempt cap bounds that.
 * `fetch` is wrapped, never passed bare (an unbound `fetch` throws "Illegal invocation").
 */
export function generateEmbeddedDisplayCopy(env: DisplayEnv, mediaId: string, fetchImpl: typeof fetch = (...args) => fetch(...args), generation?: number): Promise<EmbeddedDisplayOutcome> {
  return generateEmbeddedDisplay(env, mediaId, {
    fetch: fetchImpl,
    generation,
    transformUrl: async (key) => {
      const principal = await resolveTransformPrincipal(env);
      return signedTransformUrl(env.APP_ORIGIN, key, DISPLAY_OPTIONS, env.TRANSFORM_SOURCE_SECRET, principal.id, principal.authorizationEpoch);
    },
  });
}
