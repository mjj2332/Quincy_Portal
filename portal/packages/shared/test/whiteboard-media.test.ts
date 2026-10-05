import { describe, expect, it } from "vitest";
import { whiteboardClientMessageSchema, whiteboardElementSchema } from "../src/whiteboard-protocol";
import { whiteboardMediaIds, whiteboardMediaRef } from "../src/whiteboard-media";

const A = "0b6f6d4e-2f0e-4c53-9d0e-111111111111";
const B = "5c0a1c2e-7d34-4a8e-8b6f-222222222222";
const C = "9a1d3f60-1b2c-4d5e-8f70-333333333333";
const media = (overrides: Record<string, unknown> = {}) => ({ id: "el", type: "image", version: 1, versionNonce: 5, isDeleted: false, x: 0, y: 0, status: "saved", fileId: A, customData: { quincyMedia: { kind: "image" } }, ...overrides });

describe("whiteboardMediaRef (#501)", () => {
  it("names the media of a well-formed Quincy media element", () => {
    expect(whiteboardMediaRef(media())).toEqual({ id: A, kind: "image" });
    expect(whiteboardMediaRef(media({ customData: { quincyMedia: { kind: "video" }, other: 1 } }))).toEqual({ id: A, kind: "video" });
  });

  it("is null for anything else: another type, a non-UUID or missing fileId, missing or unknown customData", () => {
    for (const bad of [
      media({ type: "rectangle" }), media({ fileId: "abc" }), media({ fileId: undefined }), media({ fileId: 5 }), media({ fileId: "data:image/png;base64,AAAA" }),
      media({ fileId: A.toUpperCase() + "x" }), media({ customData: undefined }), media({ customData: null }), media({ customData: {} }), media({ customData: { quincyMedia: null } }),
      media({ customData: { quincyMedia: {} } }), media({ customData: { quincyMedia: { kind: "audio" } } }), media({ customData: { quincyMedia: { kind: 1 } } }), media({ customData: "image" }),
    ]) expect(whiteboardMediaRef(bad), JSON.stringify(bad)).toBeNull();
  });

  it("does not look at status or isDeleted (a tombstone is still a media element)", () => {
    expect(whiteboardMediaRef(media({ status: "error", isDeleted: true }))).toEqual({ id: A, kind: "image" });
  });
});

describe("whiteboardMediaIds (#501)", () => {
  it("returns the sorted, unique ids of the non-deleted media elements, whatever their kind", () => {
    const rows = [media({ id: "1", fileId: B }), media({ id: "2", fileId: A, customData: { quincyMedia: { kind: "video" } } }), media({ id: "3", fileId: A }), { id: "4", type: "rectangle", isDeleted: false }];
    expect(whiteboardMediaIds(rows)).toEqual([A, B]);
  });

  it("leaves out tombstones and malformed elements, and a media id held by both a live and a deleted element counts once", () => {
    const rows = [media({ id: "1", fileId: C, isDeleted: true }), media({ id: "2", fileId: "junk" }), media({ id: "3", fileId: A, isDeleted: true }), media({ id: "4", fileId: A })];
    expect(whiteboardMediaIds(rows)).toEqual([A]);
    expect(whiteboardMediaIds([])).toEqual([]);
  });
});

describe("the element schema accepts media references (#501)", () => {
  it("accepts a well-formed media element, its other fields intact, and refuses a malformed one", () => {
    const parsed = whiteboardElementSchema.parse(media({ width: 100, height: 50, angle: 0.5 }));
    expect(parsed).toMatchObject({ fileId: A, width: 100, customData: { quincyMedia: { kind: "image" } } });
    for (const bad of [media({ fileId: "f" }), media({ customData: undefined }), media({ customData: { quincyMedia: { kind: "gif" } } })]) expect(whiteboardElementSchema.safeParse(bad).success).toBe(false);
  });

  it("does not validate Excalidraw's own status, and keeps refusing other element types' extra shape nowhere", () => {
    for (const status of ["pending", "saved", "error", undefined]) expect(whiteboardElementSchema.safeParse(media({ status })).success, String(status)).toBe(true);
    expect(whiteboardElementSchema.safeParse({ id: "r", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, fileId: "anything" }).success).toBe(true);
  });

  it("carries through a client batch", () => {
    const message = { type: "elements", seq: 1, generation: 1, elements: [media(), media({ id: "bad", fileId: "x" })] };
    expect(whiteboardClientMessageSchema.safeParse(message).success).toBe(false);
    expect(whiteboardClientMessageSchema.safeParse({ ...message, elements: [media()] }).success).toBe(true);
  });
});
