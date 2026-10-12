import { describe, expect, it } from "vitest";
import { DELIVERY_ZIP_MAX_BYTES, DELIVERY_ZIP_MAX_PHOTOS, DELIVERY_ZIP_SIZES, deliveryZipManifestSchema, deliveryZipPrepareInputSchema, deliveryZipPrepareResponseSchema } from "../src/client-delivery";

/** The wire shapes of the public photo zips (#787 slice 7). */
const manifest = { size: "web", setNumber: 2, photos: 3, totalBytes: 1234, tooLarge: false, leftOut: [{ label: "Photo 04", reason: "premium_locked" }], archive: { state: "ready", pending: 0 } };

describe("delivery zip schemas", () => {
  it("names the two sizes and the caps", () => {
    expect([...DELIVERY_ZIP_SIZES]).toEqual(["web", "full"]);
    expect(DELIVERY_ZIP_MAX_PHOTOS).toBe(300);
    expect(DELIVERY_ZIP_MAX_BYTES).toBe(8 * 1024 ** 3);
  });
  it("parses a manifest and refuses an unknown key, size, state or reason", () => {
    expect(deliveryZipManifestSchema.parse(manifest)).toEqual(manifest);
    expect(deliveryZipManifestSchema.parse({ ...manifest, archive: { state: "preparing", pending: 2, retryAfterSeconds: 30 } }).archive.retryAfterSeconds).toBe(30);
    for (const bad of [{ ...manifest, extra: 1 }, { ...manifest, size: "huge" }, { ...manifest, archive: { state: "done", pending: 0 } }, { ...manifest, leftOut: [{ label: "Photo 04", reason: "other" }] }, { ...manifest, leftOut: [{ label: "Photo 04", reason: "premium_locked", id: "x" }] }, { ...manifest, archive: { state: "ready", pending: -1 } }])
      expect(deliveryZipManifestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("prepare takes exactly {} and answers the archive state", () => {
    expect(deliveryZipPrepareInputSchema.safeParse({}).success).toBe(true);
    for (const bad of [{ a: 1 }, null, [], "x"]) expect(deliveryZipPrepareInputSchema.safeParse(bad).success).toBe(false);
    expect(deliveryZipPrepareResponseSchema.parse({ state: "preparing", pending: 1, retryAfterSeconds: 30 })).toEqual({ state: "preparing", pending: 1, retryAfterSeconds: 30 });
    expect(deliveryZipPrepareResponseSchema.safeParse({ state: "ready", pending: 0, retryAfterSeconds: 0 }).success).toBe(false);
  });
});
