import { describe, expect, it } from "vitest";
import { DELIVERY_VIDEO_LAYOUT_KEY, GUEST_VIDEO_LAYOUT_KEY, normalizeVideoLayout } from "./video-layout-pref";

describe("normalizeVideoLayout", () => {
  it("keeps tiles and rows", () => {
    expect(normalizeVideoLayout("tiles")).toBe("tiles");
    expect(normalizeVideoLayout("rows")).toBe("rows");
  });
  it.each([undefined, null, "list", "grid", 1, {}, []])("falls back to tiles for %j", (raw) => {
    expect(normalizeVideoLayout(raw)).toBe("tiles");
  });
  it("keys the guest and delivery screens per browser, with no user id", () => {
    expect(GUEST_VIDEO_LAYOUT_KEY).toBe("quincy:ui:video-layout:guest");
    expect(DELIVERY_VIDEO_LAYOUT_KEY).toBe("quincy:ui:video-layout:delivery");
  });
});
