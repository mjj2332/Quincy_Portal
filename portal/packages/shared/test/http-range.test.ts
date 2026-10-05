import { describe, expect, it } from "vitest";
import { ifRangeAllows, parseByteRange } from "../src/http-range";

const full = { kind: "full" } as const;
const unsatisfiable = { kind: "unsatisfiable" } as const;
const partial = (offset: number, length: number) => ({ kind: "partial", offset, length }) as const;

describe("parseByteRange (#494)", () => {
  const size = 1000;
  const table: Array<[string, string | null | undefined, ReturnType<typeof parseByteRange>]> = [
    ["no header", null, full],
    ["undefined header", undefined, full],
    ["empty header", "", full],
    ["a-b", "bytes=0-499", partial(0, 500)],
    ["a-b middle", "bytes=500-999", partial(500, 500)],
    ["single byte", "bytes=7-7", partial(7, 1)],
    ["a-b past the end is clamped", "bytes=900-5000", partial(900, 100)],
    ["a-", "bytes=500-", partial(500, 500)],
    ["a- from zero is the whole body as a 206", "bytes=0-", partial(0, 1000)],
    ["-n", "bytes=-100", partial(900, 100)],
    ["-n longer than the body is the whole body", "bytes=-5000", partial(0, 1000)],
    ["-n equal to the body", "bytes=-1000", partial(0, 1000)],
    ["unit is case-insensitive and spaces around the spec are ignored", "Bytes= 10-19 ", partial(10, 10)],
    ["first byte at the size is unsatisfiable", "bytes=1000-", unsatisfiable],
    ["first byte past the size is unsatisfiable", "bytes=2000-3000", unsatisfiable],
    ["-0 is unsatisfiable", "bytes=-0", unsatisfiable],
    ["absurdly large first byte is unsatisfiable, not an overflow", "bytes=99999999999999999999-", unsatisfiable],
    ["absurdly large last byte is clamped", "bytes=0-99999999999999999999", partial(0, 1000)],
    ["multiple ranges are not served: the whole body", "bytes=0-1,5-6", full],
    ["last before first is invalid, so ignored", "bytes=5-2", full],
    ["a bare dash is invalid", "bytes=-", full],
    ["no digits", "bytes=a-b", full],
    ["a negative first byte is a suffix, not a start", "bytes=--5", full],
    ["a hex number is invalid", "bytes=0x10-0x20", full],
    ["another unit", "items=0-1", full],
    ["no unit", "0-10", full],
    ["no equals sign", "bytes 0-10", full],
    ["a plus sign is invalid", "bytes=+1-5", full],
  ];
  for (const [name, header, expected] of table) it(name, () => { expect(parseByteRange(header, size)).toEqual(expected); });

  it("treats every range of an empty body as unsatisfiable, and still ignores a missing header", () => {
    expect(parseByteRange("bytes=0-", 0)).toEqual(unsatisfiable);
    expect(parseByteRange("bytes=-5", 0)).toEqual(unsatisfiable);
    expect(parseByteRange("bytes=0-0", 0)).toEqual(unsatisfiable);
    expect(parseByteRange(null, 0)).toEqual(full);
  });
});

describe("ifRangeAllows (#494)", () => {
  it("allows a range when there is no If-Range", () => {
    expect(ifRangeAllows(null, '"abc"')).toBe(true);
    expect(ifRangeAllows(undefined, '"abc"')).toBe(true);
  });
  it("allows it only on an exact strong ETag match", () => {
    expect(ifRangeAllows('"abc"', '"abc"')).toBe(true);
    expect(ifRangeAllows('"abd"', '"abc"')).toBe(false);
    expect(ifRangeAllows('"ABC"', '"abc"')).toBe(false);
  });
  it("refuses a weak ETag on either side, the date form, and a missing stored ETag", () => {
    expect(ifRangeAllows('W/"abc"', 'W/"abc"')).toBe(false);
    expect(ifRangeAllows('W/"abc"', '"abc"')).toBe(false);
    expect(ifRangeAllows('"abc"', 'W/"abc"')).toBe(false);
    expect(ifRangeAllows("Wed, 21 Oct 2015 07:28:00 GMT", '"abc"')).toBe(false);
    expect(ifRangeAllows('"abc"', undefined)).toBe(false);
    expect(ifRangeAllows('"abc"', "")).toBe(false);
  });
});
