import { z } from "zod";

/**
 * #498: the wire contract between a Project whiteboard's browser and its Durable Object
 * (ADR 0017). JSON text frames over one WebSocket per open board.
 *
 * Client -> server: `elements` (a batch of changed Excalidraw elements, with a `seq` the server
 * echoes so the client can resolve the matching save).
 * Server -> client: `init` (the whole stored scene plus the connection's mode, sent once on
 * connect), `ack` (the batch is durably stored), `rejected` (it was not).
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

export const whiteboardClientMessageSchema = z.object({
  type: z.literal("elements"),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  elements: z.array(whiteboardElementSchema).max(WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE),
});
export type WhiteboardClientMessage = z.infer<typeof whiteboardClientMessageSchema>;

export const whiteboardRejectionReasonSchema = z.enum(["view-only", "invalid"]);
export type WhiteboardRejectionReason = z.infer<typeof whiteboardRejectionReasonSchema>;

export const whiteboardServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), mode: whiteboardModeSchema, elements: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ type: z.literal("ack"), seq: z.number().int().min(0) }),
  z.object({ type: z.literal("rejected"), seq: z.number().int().min(0).optional(), reason: whiteboardRejectionReasonSchema }),
]);
export type WhiteboardServerMessage = z.infer<typeof whiteboardServerMessageSchema>;

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
