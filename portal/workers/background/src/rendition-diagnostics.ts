export type SafeRenditionFailure = {
  stage: "issue-signature" | "transform-fetch" | "validate-response" | "read-body" | "validate-body" | "write-r2" | "write-d1" | "unknown";
  code: string;
  variant?: "thumb" | "web";
  status?: number;
  contentType?: "image/webp" | "image/jpeg" | "text/plain" | "missing" | "other";
  hasInternalOk?: boolean;
  hasTransformError?: boolean;
  transformErrorCode?: number;
};

function safeContentType(contentType: string): SafeRenditionFailure["contentType"] {
  if (contentType === "image/webp" || contentType === "image/jpeg" || contentType === "text/plain" || contentType === "missing") {
    return contentType;
  }
  return "other";
}

/**
 * Converts known rendition failures into log-safe metadata. In particular, it intentionally
 * excludes signed URLs, query strings, R2 keys, response bodies, error text, and arbitrary
 * error-object fields from lower layers that may contain credentials or source details.
 */
export function safeRenditionFailure(error: unknown): SafeRenditionFailure {
  const message = error instanceof Error ? error.message : "";
  if (message === "TRANSFORM_SOURCE_SECRET is required for rendition generation") {
    return { stage: "issue-signature", code: "missing-transform-source-secret" };
  }

  const invalidResponse = /^Invalid transform response for [^/]+\/(thumb|web): status=(\d+) content-type=([^\s]+) cf-resized=(.+)$/.exec(message);
  if (invalidResponse) {
    const variant = invalidResponse[1]!;
    const status = invalidResponse[2]!;
    const contentType = invalidResponse[3]!;
    const resized = invalidResponse[4]!;
    const transformError = /(?:^|[;,\s])err=(\d+)(?:$|[;,\s])/.exec(resized);
    return {
      stage: "validate-response",
      code: "invalid-transform-response",
      variant: variant as "thumb" | "web",
      status: Number(status),
      contentType: safeContentType(contentType),
      hasInternalOk: /(?:^|[;,\s])internal=ok(?:$|[;,\s])/.test(resized),
      hasTransformError: Boolean(transformError),
      ...(transformError ? { transformErrorCode: Number(transformError[1]) } : {}),
    };
  }

  const variant = /\/(thumb|web)(?::|$)/.exec(message)?.[1] as "thumb" | "web" | undefined;
  if (/^Transformation response has no body$|^Transformation output is empty$|^Transformation output exceeds /.test(message)) {
    return { stage: "read-body", code: "invalid-transform-body", ...(variant ? { variant } : {}) };
  }
  if (/^Invalid (?:WebP dimensions|JPEG output) for /.test(message)) {
    return { stage: "validate-body", code: "invalid-image-output", ...(variant ? { variant } : {}) };
  }
  if (/^fetch failed(?:$|:)|^NetworkError/.test(message)) {
    return { stage: "transform-fetch", code: "transform-fetch-failed" };
  }
  if (/^D1|Failed query:|SQLITE_/.test(message)) {
    return { stage: "write-d1", code: "rendition-metadata-write-failed" };
  }
  if (/^R2|^Unable to put|^Storage/.test(message)) {
    return { stage: "write-r2", code: "rendition-object-write-failed" };
  }
  return { stage: "unknown", code: "unclassified-rendition-failure" };
}
