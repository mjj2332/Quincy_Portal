import { videoRemovalImpactSchema, type VideoRemovalImpact } from "@quincy/shared";
import { ApiError } from "./api";

/**
 * Which refusal a Video Trash write is (#776 E), and the sentence a person reads for it. The routes answer 409 with a `code` (`impact_changed` and `last_version` carry the impact as it
 * is now), and a 404 with plain text: "Version not found" / "Video not found" (and "... in Trash") mean the row is gone, any other 404 is the gate or the Project.
 */
export type VideoTrashErrorKind = "impact_changed" | "last_version" | "upload_in_progress" | "video_in_trash" | "archived" | "gone" | "access" | "network" | "uncertain" | "other";
export type ClassifiedVideoTrashError = { kind: VideoTrashErrorKind; /** `impact_changed` / `last_version`: the impact as the server holds it now. */ impact?: VideoRemovalImpact; /** What the person reads. */ message: string };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

export const MAY_HAVE_BEEN_APPLIED = "may have been applied";
const RETRY = "That didn't go through. Try again.";

export function classifyVideoTrashError(error: unknown, op: "remove" | "restore"): ClassifiedVideoTrashError {
  if (!(error instanceof ApiError)) return { kind: "uncertain", message: `Something went wrong. The change ${MAY_HAVE_BEEN_APPLIED}; check Trash before trying again.` };
  const details = detailsOf(error);
  const code = details.code;
  if (error.status === 0) return { kind: "network", message: `Couldn't reach the server. The change ${MAY_HAVE_BEEN_APPLIED}; check Trash before trying again.` };
  if (error.status >= 500) return { kind: "uncertain", message: `Something went wrong on the server. The change ${MAY_HAVE_BEEN_APPLIED}; check Trash before trying again.` };
  if (error.status === 409) {
    if (code === "project_archived") return { kind: "archived", message: "This project is archived, so films can't be removed or restored." };
    if (code === "upload_in_progress") return { kind: "upload_in_progress", message: "A new version is being uploaded to this film. Wait for the upload to finish or cancel it, then try again." };
    if (code === "video_in_trash") return { kind: "video_in_trash", message: "This version's film is in Trash. Restore the film first." };
    if (code === "impact_changed" || code === "last_version") {
      const impact = videoRemovalImpactSchema.safeParse(details.impact);
      if (!impact.success) return { kind: "other", message: RETRY };
      return code === "impact_changed"
        ? { kind: "impact_changed", impact: impact.data, message: "This version changed since you looked. Check what removing it affects, then confirm again." }
        : { kind: "last_version", impact: impact.data, message: "The versions of this film changed since you looked. Check what removing it affects, then confirm again." };
    }
    return { kind: "other", message: RETRY };
  }
  if (error.status === 404 && /^(Version|Video) not found/.test(error.message)) {
    return { kind: "gone", message: op === "remove" ? "This version was already removed or no longer exists. The list is refreshed." : "That was already restored or deleted. The list is refreshed." };
  }
  if (error.status === 403 || error.status === 404) return { kind: "access", message: "You no longer have access to this. It has been refreshed." };
  return { kind: "other", message: RETRY };
}
