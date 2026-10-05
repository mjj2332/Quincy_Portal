import { describe, expect, it } from "vitest";
import {
  WHITEBOARD_CLOSE,
  WHITEBOARD_SNAPSHOT_INTERVAL_MS,
  WHITEBOARD_VERSIONS_RETAINED,
  whiteboardRestoreRequestSchema,
  whiteboardVersionsResponseSchema,
  WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE,
  WHITEBOARD_MAX_SELECTED_IDS,
  whiteboardClientMessageSchema,
  whiteboardIncomingWins,
  whiteboardServerMessageSchema,
  whiteboardSocketPath,
  WHITEBOARD_PROTOCOL,
  isSupportedWhiteboardProtocol,
} from "../src/whiteboard-protocol";

const element = (overrides: Record<string, unknown> = {}) => ({ id: "a", type: "rectangle", version: 1, versionNonce: 5, isDeleted: false, x: 0, y: 0, ...overrides });
const message = (elements: unknown[], seq = 1, generation: number | undefined = 1) => ({ type: "elements", seq, generation, elements });

describe("whiteboard protocol", () => {
  it("accepts a batch and keeps the element's other fields", () => {
    const parsed = whiteboardClientMessageSchema.parse(message([element()]));
    if (parsed.type !== "elements") throw new Error("expected an elements frame");
    expect(parsed.elements[0]).toMatchObject({ id: "a", x: 0, y: 0 });
  });

  it("rejects image elements that reference no media (#501), bad versions, empty or oversized ids, and over-long batches", () => {
    for (const bad of [element({ type: "image" }), element({ version: 1.5 }), element({ version: -1 }), element({ versionNonce: "x" }), element({ isDeleted: "no" }), element({ id: "" }), element({ id: "x".repeat(65) })]) {
      expect(whiteboardClientMessageSchema.safeParse(message([bad])).success).toBe(false);
    }
    expect(whiteboardClientMessageSchema.safeParse(message(Array.from({ length: WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE + 1 }, (_, index) => element({ id: `e${index}` })))).success).toBe(false);
    expect(whiteboardClientMessageSchema.safeParse({ type: "other", seq: 1, elements: [] }).success).toBe(false);
  });

  it("requires the board generation on every batch (#500): absent, negative and fractional ones are refused", () => {
    expect(whiteboardClientMessageSchema.safeParse(message([element()], 1, 3)).success).toBe(true);
    for (const bad of [undefined, -1, 1.5, "1", null]) expect(whiteboardClientMessageSchema.safeParse({ ...message([element()]), generation: bad }).success, String(bad)).toBe(false);
    const { generation: _generation, ...withoutGeneration } = message([element()]);
    expect(whiteboardClientMessageSchema.safeParse(withoutGeneration).success).toBe(false);
  });

  it("reconciles by version, then by the lower nonce", () => {
    expect(whiteboardIncomingWins(undefined, { version: 1, versionNonce: 9 })).toBe(true);
    expect(whiteboardIncomingWins({ version: 2, versionNonce: 9 }, { version: 3, versionNonce: 99 })).toBe(true);
    expect(whiteboardIncomingWins({ version: 3, versionNonce: 9 }, { version: 2, versionNonce: 1 })).toBe(false);
    expect(whiteboardIncomingWins({ version: 2, versionNonce: 9 }, { version: 2, versionNonce: 8 })).toBe(true);
    expect(whiteboardIncomingWins({ version: 2, versionNonce: 9 }, { version: 2, versionNonce: 9 })).toBe(false);
  });

  it("builds the socket path, always declaring the client's protocol (#501)", () => {
    expect(whiteboardSocketPath("p1")).toBe("/api/projects/p1/whiteboard/socket?protocol=2");
    expect(whiteboardSocketPath("a b")).toBe("/api/projects/a%20b/whiteboard/socket?protocol=2");
    expect(WHITEBOARD_PROTOCOL).toBe(2);
  });

  it("accepts only a declared protocol of at least the current one (#501)", () => {
    for (const ok of ["2", "3", "02", "99"]) expect(isSupportedWhiteboardProtocol(ok), ok).toBe(true);
    for (const bad of [undefined, null, "", "1", "0", "-2", "1.9", "2abc", " 2", "abc", "9999999"]) expect(isSupportedWhiteboardProtocol(bad), String(bad)).toBe(false);
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
      const init = { type: "init", mode: "edit", generation: 1, sessionId: "s1", elements: [], peers: [{ sessionId: "s2", userId: "u2", name: "Ana", pointer: { x: 1, y: 2 }, button: "up", selectedIds: ["a"] }] };
      expect(whiteboardServerMessageSchema.safeParse(init).success).toBe(true);
      expect(whiteboardServerMessageSchema.safeParse({ ...init, sessionId: undefined }).success).toBe(false);
      expect(whiteboardServerMessageSchema.safeParse({ ...init, generation: undefined }).success).toBe(false);
    });

    it("parses relayed elements, presence, peer-left and mode frames", () => {
      for (const frame of [
        { type: "elements", generation: 1, elements: [{ id: "a", version: 2 }] },
        { type: "presence", sessionId: "s2", userId: "u2", name: "Ana", pointer: null, button: "up", selectedIds: [] },
        { type: "peer-left", sessionId: "s2" },
        { type: "mode", mode: "view" },
      ]) expect(whiteboardServerMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
      expect(whiteboardServerMessageSchema.safeParse({ type: "mode", mode: "admin" }).success).toBe(false);
    });

    it("carries the generation on relays, acks, rejections and the new reset frame (#500)", () => {
      for (const frame of [
        { type: "ack", seq: 3, generation: 2 },
        { type: "rejected", seq: 3, reason: "generation", generation: 2 },
        { type: "rejected", reason: "stale", generation: 2 },
        { type: "reset", generation: 2, elements: [{ id: "a", version: 1 }] },
      ]) expect(whiteboardServerMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
      for (const frame of [
        { type: "elements", elements: [] },
        { type: "ack", seq: 3 },
        { type: "rejected", seq: 3, reason: "generation" },
        { type: "reset", elements: [] },
        { type: "reset", generation: 0.5, elements: [] },
      ]) expect(whiteboardServerMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(false);
    });
  });

  describe("version history (#500)", () => {
    it("fixes the cadence and the retention", () => {
      expect(WHITEBOARD_SNAPSHOT_INTERVAL_MS).toBe(30_000);
      expect(WHITEBOARD_VERSIONS_RETAINED).toBe(30);
    });

    it("validates a restore request: a generation and a UUID request id, nothing else", () => {
      const good = { expectedGeneration: 1, requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
      expect(whiteboardRestoreRequestSchema.safeParse(good).success).toBe(true);
      for (const bad of [{}, { ...good, expectedGeneration: 0 }, { ...good, expectedGeneration: 1.5 }, { ...good, requestId: "nope" }, { expectedGeneration: 1 }, { ...good, extra: true }]) expect(whiteboardRestoreRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    });

    it("validates the versions listing", () => {
      const version = { id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", createdAt: 1, createdBy: { id: "u", name: "Ana" }, reason: "interval", elementCount: 2, byteCount: 10 };
      expect(whiteboardVersionsResponseSchema.safeParse({ generation: 1, versions: [version, { ...version, createdBy: null, reason: "pre_restore" }] }).success).toBe(true);
      expect(whiteboardVersionsResponseSchema.safeParse({ generation: 1, versions: [{ ...version, reason: "manual" }] }).success).toBe(false);
      expect(whiteboardVersionsResponseSchema.safeParse({ versions: [] }).success).toBe(false);
    });
  });
});
