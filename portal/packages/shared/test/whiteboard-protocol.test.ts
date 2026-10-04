import { describe, expect, it } from "vitest";
import {
  WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE,
  whiteboardClientMessageSchema,
  whiteboardIncomingWins,
  whiteboardSocketPath,
} from "../src/whiteboard-protocol";

const element = (overrides: Record<string, unknown> = {}) => ({ id: "a", type: "rectangle", version: 1, versionNonce: 5, isDeleted: false, x: 0, y: 0, ...overrides });
const message = (elements: unknown[], seq = 1) => ({ type: "elements", seq, elements });

describe("whiteboard protocol", () => {
  it("accepts a batch and keeps the element's other fields", () => {
    const parsed = whiteboardClientMessageSchema.parse(message([element()]));
    expect(parsed.elements[0]).toMatchObject({ id: "a", x: 0, y: 0 });
  });

  it("rejects image elements, bad versions, empty or oversized ids, and over-long batches", () => {
    for (const bad of [element({ type: "image" }), element({ version: 1.5 }), element({ version: -1 }), element({ versionNonce: "x" }), element({ isDeleted: "no" }), element({ id: "" }), element({ id: "x".repeat(65) })]) {
      expect(whiteboardClientMessageSchema.safeParse(message([bad])).success).toBe(false);
    }
    expect(whiteboardClientMessageSchema.safeParse(message(Array.from({ length: WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE + 1 }, (_, index) => element({ id: `e${index}` })))).success).toBe(false);
    expect(whiteboardClientMessageSchema.safeParse({ type: "other", seq: 1, elements: [] }).success).toBe(false);
  });

  it("reconciles by version, then by the lower nonce", () => {
    expect(whiteboardIncomingWins(undefined, { version: 1, versionNonce: 9 })).toBe(true);
    expect(whiteboardIncomingWins({ version: 2, versionNonce: 9 }, { version: 3, versionNonce: 99 })).toBe(true);
    expect(whiteboardIncomingWins({ version: 3, versionNonce: 9 }, { version: 2, versionNonce: 1 })).toBe(false);
    expect(whiteboardIncomingWins({ version: 2, versionNonce: 9 }, { version: 2, versionNonce: 8 })).toBe(true);
    expect(whiteboardIncomingWins({ version: 2, versionNonce: 9 }, { version: 2, versionNonce: 9 })).toBe(false);
  });

  it("builds the socket path", () => {
    expect(whiteboardSocketPath("p1")).toBe("/api/projects/p1/whiteboard/socket");
  });
});
