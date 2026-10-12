import { isEmbeddedHeicContentType, isEmbeddedMediaContentType } from "@quincy/shared";
import type { EmbeddedMediaRow } from "./embedded-media";

/**
 * Which object an embedded-media row serves, and with what type (#495, shared by the staff route and the guest one, #835 C). A HEIC image is served as its JPEG display copy and never as the
 * original: pending is 409 (a reader retries), failed is a final 404. Anything else serves its original. Pure: the caller has already decided the viewer may read the row.
 */
export type EmbeddedServeTarget = { key: string; contentType: string } | { status: 404 | 409; body: { error: string; code?: string }; retryAfter?: string };

export function embeddedServeTarget(row: Pick<EmbeddedMediaRow, "kind" | "contentType" | "originalKey" | "renditionStatus" | "displayKey" | "displayContentType">): EmbeddedServeTarget {
  // Defence in depth: a HEIC row that somehow says `not_required` would otherwise stream the original.
  if (row.kind === "image" && row.renditionStatus === "not_required" && isEmbeddedHeicContentType(row.contentType)) return { status: 404, body: { error: "Media not found" } };
  let key = row.originalKey; let stored = row.contentType;
  if (row.kind === "image" && row.renditionStatus !== "not_required") {
    if (row.renditionStatus === "pending") return { status: 409, body: { error: "This image is still being prepared", code: "rendition_pending" }, retryAfter: "5" };
    if (row.renditionStatus === "failed" || !row.displayKey || !row.displayContentType) return { status: 404, body: { error: "This image could not be prepared", code: "rendition_failed" } };
    key = row.displayKey; stored = row.displayContentType;
  }
  return { key, contentType: isEmbeddedMediaContentType(stored) ? stored : "application/octet-stream" };
}
