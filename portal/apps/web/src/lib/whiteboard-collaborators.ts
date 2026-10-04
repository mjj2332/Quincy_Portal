import { whiteboardPresenceColour, type WhiteboardPeer } from "@quincy/shared";
import type { WhiteboardCollaborator } from "../components/reui/whiteboard/whiteboard";

/**
 * The colours the Project whiteboard gives the people on it. A canvas cannot read CSS tokens, so these are literal
 * (Quincy's own, not part of the vendored block); they are deep enough for the white label text and cursor outline
 * Excalidraw draws over them (each is at least 4.5:1 against white). `whiteboardPresenceColour(userId)` in
 * `@quincy/shared` picks the index, so every client shows one person in one colour.
 */
export const WHITEBOARD_PRESENCE_COLOURS = [
  { background: "#b4232a", stroke: "#ffffff" },
  { background: "#b45309", stroke: "#ffffff" },
  { background: "#15803d", stroke: "#ffffff" },
  { background: "#0e7490", stroke: "#ffffff" },
  { background: "#1d4ed8", stroke: "#ffffff" },
  { background: "#6d28d9", stroke: "#ffffff" },
  { background: "#be185d", stroke: "#ffffff" },
  { background: "#475569", stroke: "#ffffff" },
] as const;

/**
 * #499: a peer on the board as Excalidraw's collaborator (cursor, name label, selection outline). The id is the
 * CONNECTION's, so one person in two tabs shows as two cursors; the colour is the PERSON's, from the shared
 * palette index every client computes the same way. Name and colour are the server's and the palette's, never a
 * client's own claim.
 */
export function toCollaborator(peer: WhiteboardPeer): WhiteboardCollaborator {
  return {
    id: peer.sessionId,
    name: peer.name,
    pointer: peer.pointer ?? undefined,
    selectedIds: peer.selectedIds,
    pressed: peer.button === "down",
    color: WHITEBOARD_PRESENCE_COLOURS[whiteboardPresenceColour(peer.userId)],
  };
}
