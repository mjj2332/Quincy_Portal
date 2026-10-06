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

/**
 * #551: Excalidraw draws a collaborator's NAME only on their cursor, so a peer who is selecting with no pointer to show
 * (a hidden tab, a touch device, the pointer left the board) outlined shapes nobody could attribute. Such a peer gets a
 * cursor at the top-left corner of what they selected, with the normal (readable) name tag, so their name and colour sit on the outline.
 * A peer with a pointer, or with nothing selected (or nothing of it on the board), is unchanged.
 */
export function withSelectionAnchor(
  person: WhiteboardCollaborator,
  scene: readonly { id: string; x: number; y: number; isDeleted?: boolean }[],
): WhiteboardCollaborator {
  if (person.pointer || !person.selectedIds?.length) return person;
  const picked = new Set(person.selectedIds);
  const held = scene.filter((element) => picked.has(element.id) && element.isDeleted !== true);
  if (held.length === 0) return person;
  return {
    ...person,
    pointer: { x: Math.min(...held.map((element) => element.x)), y: Math.min(...held.map((element) => element.y)) },
  };
}
