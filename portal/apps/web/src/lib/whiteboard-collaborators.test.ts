import { describe, expect, it } from "vitest";
import { WHITEBOARD_PRESENCE_PALETTE_SIZE, whiteboardPresenceColour, type WhiteboardPeer } from "@quincy/shared";
import { WHITEBOARD_PRESENCE_COLOURS, toCollaborator } from "./whiteboard-collaborators";

const peer = (overrides: Partial<WhiteboardPeer> = {}): WhiteboardPeer => ({ sessionId: "s2", userId: "u2", name: "Ana", pointer: { x: 4, y: 5 }, button: "up", selectedIds: ["a", "b"], ...overrides });

describe("whiteboard collaborators (#499)", () => {
  it("labels a peer by its connection (so two tabs of one person are two cursors) with the person's colour", () => {
    expect(toCollaborator(peer())).toEqual({ id: "s2", name: "Ana", pointer: { x: 4, y: 5 }, selectedIds: ["a", "b"], pressed: false, color: WHITEBOARD_PRESENCE_COLOURS[whiteboardPresenceColour("u2")] });
    expect(toCollaborator(peer({ sessionId: "s3" })).color).toEqual(toCollaborator(peer()).color);
  });

  it("hides the cursor when there is no pointer, and shows a pressed button", () => {
    expect(toCollaborator(peer({ pointer: null })).pointer).toBeUndefined();
    expect(toCollaborator(peer({ button: "down" })).pressed).toBe(true);
  });

  it("has exactly as many colours as the shared palette assigns", () => {
    expect(WHITEBOARD_PRESENCE_COLOURS).toHaveLength(WHITEBOARD_PRESENCE_PALETTE_SIZE);
  });
});
