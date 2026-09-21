/**
 * fix-220-sol1 #3 — `shouldFetchNextProjectPage` is the pure decision behind
 * `ProductionGantt.tsx`'s scroll-driven project pagination, exported specifically so this file can
 * unit-test it without a real render: a purely horizontal scroll on a vertically non-overflowing
 * container must never fire the next-page fetch, even though the naive `scrollHeight - scrollTop -
 * clientHeight` distance reads as "0, i.e. at the bottom" in exactly that case.
 */
import { describe, expect, it } from "vitest";
import { shouldFetchNextProjectPage } from "./ProductionGantt";

const NOT_TOO_MANY = { tooManyToDraw: false, hasNextPage: true };

describe("shouldFetchNextProjectPage", () => {
  it("fetches when a vertically-overflowing container is within the near-bottom threshold", () => {
    expect(shouldFetchNextProjectPage({ scrollHeight: 1000, scrollTop: 800, clientHeight: 400 }, NOT_TOO_MANY)).toBe(true);
  });

  it("does not fetch when a vertically-overflowing container is far from the bottom", () => {
    expect(shouldFetchNextProjectPage({ scrollHeight: 1000, scrollTop: 0, clientHeight: 400 }, NOT_TOO_MANY)).toBe(false);
  });

  // fix-220-sol1 #3's own finding: a horizontally-scrollable descendant with NO vertical overflow
  // (scrollHeight === clientHeight) reports a distance-to-bottom of exactly 0 for every scroll
  // event it fires, including a purely horizontal one — the naive distance check alone would treat
  // that as "at the bottom" and fire pagination on horizontal scroll.
  it("never fetches for a container with no vertical overflow at all, regardless of scrollTop", () => {
    expect(shouldFetchNextProjectPage({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 }, NOT_TOO_MANY)).toBe(false);
    expect(shouldFetchNextProjectPage({ scrollHeight: 400, scrollTop: 250, clientHeight: 400 }, NOT_TOO_MANY)).toBe(false);
  });

  it("never fetches while tooManyToDraw is true, even if otherwise near the bottom", () => {
    expect(shouldFetchNextProjectPage({ scrollHeight: 1000, scrollTop: 800, clientHeight: 400 }, { tooManyToDraw: true, hasNextPage: true })).toBe(false);
  });

  it("never fetches when there is no next page, even if otherwise near the bottom", () => {
    expect(shouldFetchNextProjectPage({ scrollHeight: 1000, scrollTop: 800, clientHeight: 400 }, { tooManyToDraw: false, hasNextPage: false })).toBe(false);
  });

  it("fetches exactly at the threshold boundary (distance strictly less than the threshold), not past it", () => {
    // scrollHeight - scrollTop - clientHeight = 240 == NEAR_BOTTOM_THRESHOLD_PX: not yet close enough.
    expect(shouldFetchNextProjectPage({ scrollHeight: 1000, scrollTop: 360, clientHeight: 400 }, NOT_TOO_MANY)).toBe(false);
    // One pixel closer: now close enough.
    expect(shouldFetchNextProjectPage({ scrollHeight: 1000, scrollTop: 361, clientHeight: 400 }, NOT_TOO_MANY)).toBe(true);
  });
});
