import { z } from "zod";
import { whiteboardMediaRef } from "./whiteboard-media";

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
 * #500 adds the board GENERATION: a persisted counter the server bumps when a version is restored. It is on `init`, on every
 * element batch in both directions, on `ack` and `rejected`, and on the new `reset` frame (the restored scene, sent to every
 * socket). A batch whose generation is absent or not the current one is refused (`rejected`, reason `generation`), because a
 * restored scene must never be merged with an older tab's edits through the version/nonce rule below.
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

/** #500: a changed board is snapshotted this long after its first change (a fixed deadline, never pushed back by later edits). */
export const WHITEBOARD_SNAPSHOT_INTERVAL_MS = 30_000;
/** #500: the newest this many ready versions are kept per Project. */
export const WHITEBOARD_VERSIONS_RETAINED = 30;

/** #500: the board generation. Starts at 1 and only a restore moves it. */
export const whiteboardGenerationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const whiteboardModeSchema = z.enum(["edit", "view"]);
export type WhiteboardMode = z.infer<typeof whiteboardModeSchema>;

/** The fields reconciliation needs; everything else on an Excalidraw element passes through. */
export const whiteboardElementSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(32),
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  versionNonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  isDeleted: z.boolean(),
}).passthrough().superRefine((element, context) => {
  // #501: an image element is a reference to embedded media (see whiteboard-media.ts). Its `status` is Excalidraw's own and is not validated.
  if (element.type === "image" && !whiteboardMediaRef(element)) context.addIssue({ code: "custom", message: "an image element must reference embedded media (a UUID fileId and customData.quincyMedia.kind)" });
});
export type WhiteboardElement = z.infer<typeof whiteboardElementSchema>;

export const whiteboardElementsMessageSchema = z.object({
  type: z.literal("elements"),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  generation: whiteboardGenerationSchema,
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

export const whiteboardRejectionReasonSchema = z.enum(["view-only", "invalid", "stale", "generation"]);
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
  z.object({ type: z.literal("init"), mode: whiteboardModeSchema, generation: whiteboardGenerationSchema, sessionId: z.string().min(1), elements: z.array(z.record(z.string(), z.unknown())), peers: z.array(whiteboardPeerSchema) }),
  z.object({ type: z.literal("ack"), seq: z.number().int().min(0), generation: whiteboardGenerationSchema }),
  z.object({ type: z.literal("rejected"), seq: z.number().int().min(0).optional(), reason: whiteboardRejectionReasonSchema, generation: whiteboardGenerationSchema }),
  z.object({ type: z.literal("elements"), generation: whiteboardGenerationSchema, elements: z.array(z.record(z.string(), z.unknown())) }),
  /** #500: a version was restored. The authoritative scene of the NEW generation, sent to every socket; a client discards its own edits and loads it. */
  z.object({ type: z.literal("reset"), generation: whiteboardGenerationSchema, elements: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ type: z.literal("presence"), ...whiteboardPeerSchema.shape }),
  z.object({ type: z.literal("peer-left"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("mode"), mode: whiteboardModeSchema }),
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

/**
 * #501: the wire protocol a client speaks. A tab loaded before images and videos existed sweeps every image element it sees and
 * would author their deletion for everyone, so the upgrade route refuses a socket that does not declare `?protocol=` at least this.
 * Bump it when an older client could damage the board by joining.
 */
export const WHITEBOARD_PROTOCOL = 2;

/** The Project whiteboard's socket path (relative to the API origin). It always carries the client's protocol. */
export function whiteboardSocketPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/whiteboard/socket?protocol=${WHITEBOARD_PROTOCOL}`;
}

/** True when the `protocol` query value a socket upgrade declared is one this server accepts. */
export function isSupportedWhiteboardProtocol(value: string | undefined | null): boolean {
  return typeof value === "string" && /^\d{1,6}$/.test(value) && Number(value) >= WHITEBOARD_PROTOCOL;
}

// ---- #500: version history over HTTP --------------------------------------------------------------------------------

export const whiteboardVersionReasonSchema = z.enum(["interval", "last_leave", "pre_restore"]);
export type WhiteboardVersionReason = z.infer<typeof whiteboardVersionReasonSchema>;

/** One ready version, newest first. `elementCount` counts the elements a person can see (deleted ones are not counted). */
export const whiteboardVersionSummarySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().min(0),
  createdBy: z.object({ id: z.string().min(1), name: z.string() }).nullable(),
  reason: whiteboardVersionReasonSchema,
  elementCount: z.number().int().min(0),
  byteCount: z.number().int().min(0),
});
export type WhiteboardVersionSummary = z.infer<typeof whiteboardVersionSummarySchema>;

/** `GET /api/projects/:projectId/whiteboard/versions`: the board's current generation (what a restore must expect) and its ready versions. */
export const whiteboardVersionsResponseSchema = z.object({
  generation: whiteboardGenerationSchema,
  versions: z.array(whiteboardVersionSummarySchema),
});
export type WhiteboardVersionsResponse = z.infer<typeof whiteboardVersionsResponseSchema>;

/** `POST .../versions/:versionId/restore`: `requestId` makes a retry idempotent, `expectedGeneration` refuses a restore the person has not seen the board for. */
export const whiteboardRestoreRequestSchema = z.object({
  expectedGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(),
}).strict();
export type WhiteboardRestoreRequest = z.infer<typeof whiteboardRestoreRequestSchema>;

/** The versions listing's path (relative to the API origin). */
export function whiteboardVersionsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/whiteboard/versions`;
}
export function whiteboardRestorePath(projectId: string, versionId: string): string {
  return `${whiteboardVersionsPath(projectId)}/${encodeURIComponent(versionId)}/restore`;
}
