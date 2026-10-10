import { describe, expect, it } from "vitest";
import { isGuestReviewPath } from "./guest-path";

describe("isGuestReviewPath", () => {
  it("matches /d/review exactly", () => {
    expect(isGuestReviewPath("/d/review")).toBe(true);
    for (const other of ["/", "/d", "/d/review/", "/d/reviews", "/D/review", "/admin", "/d/review/x"]) expect(isGuestReviewPath(other)).toBe(false);
  });
});
