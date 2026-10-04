import type { WhiteboardPeer } from "@quincy/shared";
import type { WhiteboardCollaborator } from "../components/reui/whiteboard/whiteboard";

/**
 * #499: a peer on the board as Excalidraw's collaborator (cursor, name label, selection outline). The map key is the
 * CONNECTION's session id, so one person in two tabs shows as two cursors. Colour is the PERSON's: Excalidraw 0.18.1
 * ignores a supplied `color` and derives cursor, label and selection colours from a hash of `collaborator.id`, so
 * `colorKey` (which the controller writes to that field) is the user id. Every client therefore shows one person in one
 * colour across tabs and reconnects. Name is the server's, never a client's own claim.
 */
export function toCollaborator(peer: WhiteboardPeer): WhiteboardCollaborator {
  return {
    id: peer.sessionId,
    colorKey: peer.userId,
    name: peer.name,
    pointer: peer.pointer ?? undefined,
    selectedIds: peer.selectedIds,
    pressed: peer.button === "down",
  };
}
