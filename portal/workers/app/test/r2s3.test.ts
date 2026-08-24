import { describe, expect, it } from "vitest";
import { encodedObjectPath, expectedPartCount, validateMultipartParts, createMultipartPresign } from "../src/lib/r2s3";
import type { Env } from "../src/env";

describe("R2 S3 multipart helpers", () => {
  it("encodes every key segment without treating filenames as URL syntax", () => {
    expect(encodedObjectPath("projects/a/floor plan #2?.pdf")).toBe("projects/a/floor%20plan%20%232%3F.pdf");
  });

  it("requires the exact unique contiguous manifest for a small injected part size", () => {
    expect(expectedPartCount(9, 4)).toBe(3);
    expect(validateMultipartParts(9, [{ partNumber: 3, etag: "c" }, { partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }], 4).map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(() => validateMultipartParts(9, [{ partNumber: 1, etag: "a" }, { partNumber: 3, etag: "c" }, { partNumber: 3, etag: "d" }], 4)).toThrow(/contiguous/);
  });

  it("keeps local uploads on the binding-backed path even when S3 credentials are present", async () => {
    const env = { APP_ENV: "dev", R2_ACCOUNT_ID: "account", R2_S3_ACCESS_KEY_ID: "access", R2_S3_SECRET_ACCESS_KEY: "secret" } as Env;
    await expect(createMultipartPresign(env, "projects/demo/raw/asset/frame.jpg", 1)).resolves.toBeNull();
  });
});
