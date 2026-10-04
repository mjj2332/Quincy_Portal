import { describe, expect, it } from "vitest";
import {
  WHITEBOARD_CLOSE,
  WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE,
  WHITEBOARD_MAX_SELECTED_IDS,
  WHITEBOARD_PRESENCE_PALETTE_SIZE,
  whiteboardClientMessageSchema,
  whiteboardIncomingWins,
  whiteboardPresenceColour,
  whiteboardServerMessageSchema,
  whiteboardSocketPath,
} from "../src/whiteboard-protocol";

const element = (overrides: Record<string, unknown> = {}) => ({ id: "a", type: "rectangle", version: 1, versionNonce: 5, isDeleted: false, x: 0, y: 0, ...overrides });
const message = (elements: unknown[], seq = 1) => ({ type: "elements", seq, elements });

describe("whiteboard protocol", () => {
  it("accepts a batch and keeps the element's other fields", () => {
    const parsed = whiteboardClientMessageSchema.parse(message([element()]));
    if (parsed.type !== "elements") throw new Error("expected an elements frame");
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

  it("closes a revoked connection with 4403, distinct from deleted and malformed", () => {
    expect(WHITEBOARD_CLOSE.revoked).toBe(4403);
    expect(new Set(Object.values(WHITEBOARD_CLOSE)).size).toBe(Object.keys(WHITEBOARD_CLOSE).length);
  });

  describe("presence frames", () => {
    const presence = (overrides: Record<string, unknown> = {}) => ({ type: "presence", pointer: { x: 1.5, y: -20 }, button: "up", selectedIds: ["a"], ...overrides });

    it("accepts a pointer, a hidden pointer and a selection", () => {
      expect(whiteboardClientMessageSchema.safeParse(presence()).success).toBe(true);
      expect(whiteboardClientMessageSchema.safeParse(presence({ pointer: null, selectedIds: [] })).success).toBe(true);
      expect(whiteboardClientMessageSchema.safeParse(presence({ button: "down" })).success).toBe(true);
    });

    it("rejects non-finite coordinates, an unknown button, over-long selections and oversized ids", () => {
      for (const bad of [
        presence({ pointer: { x: Number.NaN, y: 0 } }),
        presence({ pointer: { x: 1, y: "2" } }),
        presence({ pointer: { x: 1e30, y: 0 } }),
        presence({ button: "middle" }),
        presence({ selectedIds: Array.from({ length: WHITEBOARD_MAX_SELECTED_IDS + 1 }, (_, index) => `e${index}`) }),
        presence({ selectedIds: ["x".repeat(65)] }),
        presence({ selectedIds: [""] }),
      ]) expect(whiteboardClientMessageSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
      expect(WHITEBOARD_MAX_SELECTED_IDS).toBe(500);
    });

    it("never lets a client name itself, colour itself or pick a session: extra identity fields are stripped", () => {
      const parsed = whiteboardClientMessageSchema.parse(presence({ name: "Admin", userId: "u", sessionId: "s", color: "red" }));
      expect(parsed).not.toHaveProperty("name"); expect(parsed).not.toHaveProperty("userId"); expect(parsed).not.toHaveProperty("sessionId"); expect(parsed).not.toHaveProperty("color");
    });
  });

  describe("server frames", () => {
    it("init carries the connection's own sessionId and the peers already present", () => {
      const init = { type: "init", mode: "edit", sessionId: "s1", elements: [], peers: [{ sessionId: "s2", userId: "u2", name: "Ana", pointer: { x: 1, y: 2 }, button: "up", selectedIds: ["a"] }] };
      expect(whiteboardServerMessageSchema.safeParse(init).success).toBe(true);
      expect(whiteboardServerMessageSchema.safeParse({ ...init, sessionId: undefined }).success).toBe(false);
    });

    it("parses relayed elements, presence, peer-left and mode frames", () => {
      for (const frame of [
        { type: "elements", elements: [{ id: "a", version: 2 }] },
        { type: "presence", sessionId: "s2", userId: "u2", name: "Ana", pointer: null, button: "up", selectedIds: [] },
        { type: "peer-left", sessionId: "s2" },
        { type: "mode", mode: "view" },
      ]) expect(whiteboardServerMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
      expect(whiteboardServerMessageSchema.safeParse({ type: "mode", mode: "admin" }).success).toBe(false);
    });
  });

  it("assigns a person the same presence colour in every client, always inside the palette", () => {
    const ids = ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111", "x", ""];
    for (const id of ids) {
      const colour = whiteboardPresenceColour(id);
      expect(colour).toBe(whiteboardPresenceColour(id));
      expect(Number.isInteger(colour) && colour >= 0 && colour < WHITEBOARD_PRESENCE_PALETTE_SIZE).toBe(true);
    }
    expect(new Set(Array.from({ length: 200 }, (_, index) => whiteboardPresenceColour(`user-${index}`))).size).toBeGreaterThan(WHITEBOARD_PRESENCE_PALETTE_SIZE / 2);
  });
});
