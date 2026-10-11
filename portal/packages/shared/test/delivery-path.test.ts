import { describe, expect, it } from "vitest";
import { DELIVERY_SLUG_ALPHABET, deliverySlugOfPath, isDeliveryPagePath } from "../src";

describe("isDeliveryPagePath", () => {
  it("matches /d/<address>-<suffix> on the raw path and nothing else", () => {
    for (const ok of ["/d/12-test-street-23456b", "/d/a-bcdfgh", "/d/unit-4-9-smith-st-mznpqr"]) expect(isDeliveryPagePath(ok), ok).toBe(true);
  });

  it("refuses a trailing slash, an extra segment, a wrong suffix, other cases and the other guest paths", () => {
    const bad = ["/", "/d", "/d/", "/d/review", "/d/unsubscribe", "/d/12-test-street-23456b/", "/d/12-test-street-23456b/x", "/d/api/pages/12-test-street-23456b", "/D/12-test-street-23456b",
      "/d/12-test-street-23456a", "/d/12-test-street-2345b", "/d/12-test-street-23456bc", "/d/-test-street-23456b", "/d/12--street-23456b", "/d/12-Test-street-23456b", "/d/12-test-street-23456b?x=1", "/d/%31%32-test-street-23456b", "/d/12-test-street-23456b%2F", "/admin"];
    for (const path of bad) expect(isDeliveryPagePath(path), path).toBe(false);
  });

  it("does no decoding or normalising", () => {
    expect(isDeliveryPagePath("/d/%61bc-bcdfgh")).toBe(false);
    expect(isDeliveryPagePath("/d/abc-bcdfgh/../abc-bcdfgh")).toBe(false);
  });

  it("uses the suffix alphabet from the contract", () => {
    for (const char of DELIVERY_SLUG_ALPHABET) expect(isDeliveryPagePath(`/d/x-${char.repeat(6)}`), char).toBe(true);
    for (const char of "01alo") expect(isDeliveryPagePath(`/d/x-${char.repeat(6)}`), char).toBe(false);
  });
});

describe("deliverySlugOfPath", () => {
  it("returns the slug for a page path and null otherwise", () => {
    expect(deliverySlugOfPath("/d/12-test-street-23456b")).toBe("12-test-street-23456b");
    expect(deliverySlugOfPath("/d/review")).toBeNull();
    expect(deliverySlugOfPath("/d/12-test-street-23456b/")).toBeNull();
  });
});
