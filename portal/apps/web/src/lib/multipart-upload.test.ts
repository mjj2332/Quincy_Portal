import { describe, expect, it } from "vitest";
import { multipartSlices } from "./multipart-upload";

describe("multipart slices", () => {
  it("covers below, exactly at, and above an injected small part boundary", () => {
    expect(multipartSlices(3, 4)).toEqual([{ start: 0, end: 3 }]);
    expect(multipartSlices(4, 4)).toEqual([{ start: 0, end: 4 }]);
    expect(multipartSlices(9, 4)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 9 }]);
  });
});
