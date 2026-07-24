import { describe, expect, it } from "vitest";

import { safeRenditionFailure } from "../src/rendition-diagnostics";

describe("rendition failure diagnostics", () => {
  it("classifies a missing transform signing secret without exposing error text", () => {
    const secret = "production-secret-must-not-appear";
    const diagnostic = safeRenditionFailure(new Error("TRANSFORM_SOURCE_SECRET is required for rendition generation"));
    expect(diagnostic).toEqual({
      stage: "issue-signature",
      code: "missing-transform-source-secret",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(JSON.stringify(diagnostic)).not.toContain("TRANSFORM_SOURCE_SECRET");
  });

  it("classifies Cloudflare transform rejection without leaking source URLs", () => {
    const url = "https://quincy.flamingfire.my/__transform-source/projects/a/Image%204.jpg?sig=not-safe-to-log";
    const diagnostic = safeRenditionFailure(new Error("Invalid transform response for asset-1/thumb: status=403 content-type=text/plain cf-resized=err=9401"));
    expect(diagnostic).toEqual({
      stage: "validate-response",
      code: "invalid-transform-response",
      variant: "thumb",
      status: 403,
      contentType: "text/plain",
      hasInternalOk: false,
      hasTransformError: true,
      transformErrorCode: 9401,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(url);
    expect(JSON.stringify(diagnostic)).not.toContain("sig=");
  });

  it("redacts unrecognized response content types", () => {
    const diagnostic = safeRenditionFailure(
      new Error("Invalid transform response for asset-1/web: status=502 content-type=text/html;body=private cf-resized=missing"),
    );

    expect(diagnostic).toMatchObject({
      stage: "validate-response",
      variant: "web",
      status: 502,
      contentType: "other",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });

  it("records conflicting success and error transform headers as a failure", () => {
    expect(safeRenditionFailure(new Error("Invalid transform response for asset-1/web: status=200 content-type=image/webp cf-resized=internal=ok; err=9401"))).toMatchObject({
      stage: "validate-response",
      variant: "web",
      status: 200,
      hasInternalOk: true,
      hasTransformError: true,
      transformErrorCode: 9401,
    });
  });

  it("does not serialize arbitrary nested error content", () => {
    const diagnostic = safeRenditionFailure(new Error("fetch failed: https://host.example/?sig=sensitive&body=private"));
    expect(diagnostic).toEqual({
      stage: "transform-fetch",
      code: "transform-fetch-failed",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sensitive");
    expect(JSON.stringify(diagnostic)).not.toContain("host.example");
  });
});
