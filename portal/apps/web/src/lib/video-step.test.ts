import { describe, expect, it } from "vitest";
import { stepTargets } from "./video-step";

const a = { id: "a" }; const b = { id: "b" }; const c = { id: "c" };

describe("stepTargets (#936)", () => {
  it("places the open film in the shown order, with its neighbours", () => {
    expect(stepTargets({ shown: [a, b, c], openId: "b" })).toEqual({ position: 1, total: 3, prev: a, next: c });
  });
  it("has no previous at the first film and no next at the last", () => {
    expect(stepTargets({ shown: [a, b, c], openId: "a" })).toEqual({ position: 0, total: 3, prev: null, next: b });
    expect(stepTargets({ shown: [a, b, c], openId: "c" })).toEqual({ position: 2, total: 3, prev: b, next: null });
  });
  it("gives a film the list does not show no position and no step either way (#933 S1)", () => {
    expect(stepTargets({ shown: [a, c], openId: "b" })).toEqual({ position: null, total: 2, prev: null, next: null });
  });
  it("has nothing open: no position, no step", () => {
    expect(stepTargets({ shown: [a, b], openId: null })).toEqual({ position: null, total: 2, prev: null, next: null });
  });
});
