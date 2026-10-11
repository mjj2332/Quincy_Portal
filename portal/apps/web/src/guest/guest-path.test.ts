import { describe, expect, it } from "vitest";
import { isGuestReviewPath, isGuestUnsubscribePath } from "./guest-path";

describe("isGuestReviewPath", () => {
  it("matches /d/review exactly", () => {
    expect(isGuestReviewPath("/d/review")).toBe(true);
    for (const other of ["/", "/d", "/d/review/", "/d/reviews", "/D/review", "/admin", "/d/review/x"]) expect(isGuestReviewPath(other)).toBe(false);
  });
});

describe("isGuestUnsubscribePath", () => {
  it("matches /d/unsubscribe exactly", () => {
    expect(isGuestUnsubscribePath("/d/unsubscribe")).toBe(true);
    for (const other of ["/", "/d", "/d/unsubscribe/", "/d/unsubscribes", "/D/unsubscribe", "/d/review", "/d/unsubscribe/x"]) expect(isGuestUnsubscribePath(other)).toBe(false);
  });
});
