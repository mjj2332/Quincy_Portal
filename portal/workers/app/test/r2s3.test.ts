import { describe, expect, it } from "vitest";
import { encodedObjectPath, expectedPartCount, validateMultipartParts } from "../src/lib/r2s3";

describe("R2 S3 multipart helpers", () => {
  it("encodes every key segment without treating filenames as URL syntax", () => {
    expect(encodedObjectPath("projects/a/floor plan #2?.pdf")).toBe("projects/a/floor%20plan%20%232%3F.pdf");
  });

  it("requires the exact unique contiguous manifest for a small injected part size", () => {
    expect(expectedPartCount(9, 4)).toBe(3);
    expect(validateMultipartParts(9, [{ partNumber: 3, etag: "c" }, { partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }], 4).map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(() => validateMultipartParts(9, [{ partNumber: 1, etag: "a" }, { partNumber: 3, etag: "c" }, { partNumber: 3, etag: "d" }], 4)).toThrow(/contiguous/);
  });
});
