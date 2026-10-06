import { describe, expect, it } from "vitest";
import type { WhiteboardPeer } from "@quincy/shared";
import { toCollaborator, withSelectionAnchor } from "./whiteboard-collaborators";

const peer = (overrides: Partial<WhiteboardPeer> = {}): WhiteboardPeer => ({ sessionId: "s2", userId: "u2", name: "Ana", pointer: { x: 4, y: 5 }, button: "up", selectedIds: ["a", "b"], ...overrides });

describe("whiteboard collaborators (#499)", () => {
  it("keys a peer by its connection (so two tabs of one person are two cursors)", () => {
    expect(toCollaborator(peer())).toMatchObject({ id: "s2", name: "Ana", pointer: { x: 4, y: 5 }, selectedIds: ["a", "b"], pressed: false });
  });

  it("colours by the PERSON: Excalidraw 0.18.1 hashes `collaborator.id` for cursor, label and selection, so that field is the user id, never the session", () => {
    expect(toCollaborator(peer()).colorKey).toBe("u2");
    expect(toCollaborator(peer({ sessionId: "other-tab" })).colorKey).toBe(toCollaborator(peer()).colorKey);
    expect(toCollaborator(peer({ userId: "u3" })).colorKey).not.toBe(toCollaborator(peer()).colorKey);
    expect(toCollaborator(peer())).not.toHaveProperty("color");     // a supplied palette is ignored by 0.18.1; do not pretend
  });

  it("hides the cursor when there is no pointer, and shows a pressed button", () => {
    expect(toCollaborator(peer({ pointer: null })).pointer).toBeUndefined();
    expect(toCollaborator(peer({ button: "down" })).pressed).toBe(true);
  });
});

describe("a selection with no cursor still names who is selecting (#551)", () => {
  const scene = [{ id: "a", x: 10, y: 30 }, { id: "b", x: 4, y: 50 }, { id: "gone", x: -9, y: -9, isDeleted: true }];
  const person = (over: Partial<ReturnType<typeof toCollaborator>> = {}) => ({ ...toCollaborator(peer({ pointer: null })), ...over });

  it("anchors an idle cursor at the top-left of the selected shapes", () => {
    expect(withSelectionAnchor(person(), scene)).toMatchObject({ pointer: { x: 4, y: 30 }, state: "idle", name: "Ana" });
  });
  it("leaves a peer with a pointer, with no selection, or whose selection is not on the board alone", () => {
    const withPointer = toCollaborator(peer());
    expect(withSelectionAnchor(withPointer, scene)).toBe(withPointer);
    const nothing = person({ selectedIds: [] });
    expect(withSelectionAnchor(nothing, scene)).toBe(nothing);
    const missing = person({ selectedIds: ["nope", "gone"] });
    expect(withSelectionAnchor(missing, scene)).toBe(missing);
  });
});
