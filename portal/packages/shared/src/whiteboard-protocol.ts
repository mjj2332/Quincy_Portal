import { z } from "zod";

/**
 * #498: the wire contract between a Project whiteboard's browser and its Durable Object
 * (ADR 0017). JSON text frames over one WebSocket per open board.
 *
 * Client -> server: `elements` (a batch of changed Excalidraw elements, with a `seq` the server
 * echoes so the client can resolve the matching save) and, from #499, `presence` (pointer, button
 * and selection; the server alone decides the sender's name and colour).
 * Server -> client: `init` (the whole stored scene, the connection's mode and its own `sessionId`,
 * plus the peers already present, sent once on connect), `ack` (the batch is durably stored),
 * `rejected` (it was not), and from #499 `elements` (other people's winning elements, or the stored
 * rows that beat the receiver's own batch), `presence`, `peer-left` and `mode` (archive/restore).
 *
 * Element reconciliation is Excalidraw's own rule (`shouldDiscardRemoteElement`): the incoming
 * element wins when its `version` is higher, or when versions are equal and its `versionNonce`
 * is lower. Deleted elements are kept as tombstones so a late edit cannot resurrect them.
 */

/** Close codes the Durable Object uses; 4xxx is the application range. */
export const WHITEBOARD_CLOSE = {
  /** The Project (and its board) was deleted. Terminal: never reconnect. */
  deleted: 4404,
  /** The client sent a frame the protocol does not allow. */
  malformed: 4400,
  /** #499: the person lost access to the Project (removed from it, deactivated, archived for an External editor). Terminal for this socket. */
  revoked: 4403,
} as const;

export const WHITEBOARD_MAX_MESSAGE_BYTES = 1024 * 1024;
export const WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE = 5000;
export const WHITEBOARD_MAX_ELEMENT_BYTES = 256 * 1024;

export const whiteboardModeSchema = z.enum(["edit", "view"]);
export type WhiteboardMode = z.infer<typeof whiteboardModeSchema>;

/** The fields reconciliation needs; everything else on an Excalidraw element passes through. */
export const whiteboardElementSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(32),
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  versionNonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  isDeleted: z.boolean(),
}).passthrough().refine((element) => element.type !== "image", {
  // Embedded media arrives with #501; until then nothing may reference a file the board cannot serve.
  message: "image elements are not supported yet",
});
export type WhiteboardElement = z.infer<typeof whiteboardElementSchema>;

export const whiteboardElementsMessageSchema = z.object({
  type: z.literal("elements"),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  elements: z.array(whiteboardElementSchema).max(WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE),
});
export type WhiteboardElementsMessage = z.infer<typeof whiteboardElementsMessageSchema>;

export const WHITEBOARD_MAX_SELECTED_IDS = 500;
/** A presence frame is tiny; this bounds a hostile one (500 ids of 64 characters is about 35 KB). */
export const WHITEBOARD_MAX_PRESENCE_BYTES = 64 * 1024;
/** Scene coordinates are bounded so a hostile client cannot send an astronomically large cursor. */
const coordinateSchema = z.number().finite().min(-1e9).max(1e9);

const presenceStateShape = {
  pointer: z.object({ x: coordinateSchema, y: coordinateSchema }).nullable(),
  button: z.enum(["up", "down"]),
  selectedIds: z.array(z.string().min(1).max(64)).max(WHITEBOARD_MAX_SELECTED_IDS),
};

/** Name and colour are never in a client frame: the server derives them from the connection's own user. */
export const whiteboardPresenceMessageSchema = z.object({ type: z.literal("presence"), ...presenceStateShape });
export type WhiteboardPresenceMessage = z.infer<typeof whiteboardPresenceMessageSchema>;

export const whiteboardClientMessageSchema = z.discriminatedUnion("type", [whiteboardElementsMessageSchema, whiteboardPresenceMessageSchema]);
export type WhiteboardClientMessage = z.infer<typeof whiteboardClientMessageSchema>;

export const whiteboardRejectionReasonSchema = z.enum(["view-only", "invalid"]);
export type WhiteboardRejectionReason = z.infer<typeof whiteboardRejectionReasonSchema>;

/** One other open connection on the board (two tabs of one person are two peers). */
export const whiteboardPeerSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string(),
  ...presenceStateShape,
});
export type WhiteboardPeer = z.infer<typeof whiteboardPeerSchema>;

export const whiteboardServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), mode: whiteboardModeSchema, sessionId: z.string().min(1), elements: z.array(z.record(z.string(), z.unknown())), peers: z.array(whiteboardPeerSchema) }),
  z.object({ type: z.literal("ack"), seq: z.number().int().min(0) }),
  z.object({ type: z.literal("rejected"), seq: z.number().int().min(0).optional(), reason: whiteboardRejectionReasonSchema }),
  z.object({ type: z.literal("elements"), elements: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ type: z.literal("presence"), ...whiteboardPeerSchema.shape }),
  z.object({ type: z.literal("peer-left"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("mode"), mode: whiteboardModeSchema }),
]);
export type WhiteboardServerMessage = z.infer<typeof whiteboardServerMessageSchema>;

/** How many colours the whiteboard assigns people. The hex values live with the canvas theme
 * (`whiteboard-theme.ts`): a canvas cannot read CSS tokens. */
export const WHITEBOARD_PRESENCE_PALETTE_SIZE = 8;

/** A person's presence colour, as an index into the palette: deterministic in the user id, so every
 * client shows the same person in the same colour without the server sending one. */
export function whiteboardPresenceColour(userId: string): number {
  let hash = 2166136261;                                  // FNV-1a
  for (let index = 0; index < userId.length; index += 1) hash = Math.imul(hash ^ userId.charCodeAt(index), 16777619);
  return (hash >>> 0) % WHITEBOARD_PRESENCE_PALETTE_SIZE;
}

/** Excalidraw's reconciliation rule: does `incoming` replace `stored`? */
export function whiteboardIncomingWins(
  stored: { version: number; versionNonce: number } | undefined,
  incoming: { version: number; versionNonce: number },
): boolean {
  if (!stored) return true;
  if (incoming.version !== stored.version) return incoming.version > stored.version;
  return incoming.versionNonce < stored.versionNonce;
}

/** The Project whiteboard's socket path (relative to the API origin). */
export function whiteboardSocketPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/whiteboard/socket`;
}
