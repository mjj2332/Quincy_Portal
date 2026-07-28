import { describe, expect, it } from "vitest";
import { computeInsertPosition } from "./board-position";

describe("computeInsertPosition", () => {
  it.each([
    [null, null, 0],
    [null, 2048, 1024],
    [2048, null, 3072],
    [1024, 2048, 1536],
    [1, 1, 1],
  ])("computes (%s, %s) as %s", (before, after, expected) => {
    expect(computeInsertPosition(before, after)).toBe(expected);
  });
});
