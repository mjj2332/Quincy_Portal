import { describe, expect, it } from "vitest";
import { reviewLinkDtoSchema } from "../src/review-links";
import { deliveryItemDtoSchema } from "../src/client-delivery";

/** The wire shapes the Delivery review link (#847) adds. */
const id = "11111111-1111-4111-8111-111111111111";
const link = { id, label: "Delivery", status: "active", createdAt: "2026-01-01T00:00:00.000Z", createdBy: null, expiresAt: null, delivery: true, revokedAt: null, revokedBy: null, hasPasscode: false, url: "https://x.test/d/review?link=a#t=b", allow: { comments: true, approve: true, download: true }, videos: [], activity: { openSessions: 0, lastOpenedAt: null, verifiedGuests: [] } };

describe("reviewLinkDtoSchema", () => {
  it("accepts a null expiry and carries the delivery flag", () => {
    expect(reviewLinkDtoSchema.parse(link)).toMatchObject({ expiresAt: null, delivery: true });
    expect(reviewLinkDtoSchema.safeParse({ ...link, expiresAt: "2026-02-01T00:00:00.000Z", delivery: false }).success).toBe(true);
  });
  it("requires delivery and refuses an unknown key", () => {
    const { delivery: _delivery, ...without } = link;
    expect(reviewLinkDtoSchema.safeParse(without).success).toBe(false);
    expect(reviewLinkDtoSchema.safeParse({ ...link, extra: 1 }).success).toBe(false);
  });
});

describe("deliveryItemDtoSchema.review", () => {
  const shape = deliveryItemDtoSchema.shape.review;
  it("is a strict { url } or null", () => {
    expect(shape.safeParse(null).success).toBe(true);
    expect(shape.safeParse({ url: "/d/review?link=a#t=b&v=c" }).success).toBe(true);
    expect(shape.safeParse({ url: "/x", linkId: "a" }).success).toBe(false);
    expect(shape.safeParse(undefined).success).toBe(false);
  });
});
