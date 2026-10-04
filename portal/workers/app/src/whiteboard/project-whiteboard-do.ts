import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  WHITEBOARD_CLOSE,
  WHITEBOARD_MAX_ELEMENT_BYTES,
  WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE,
  WHITEBOARD_MAX_MESSAGE_BYTES,
  WHITEBOARD_MAX_PRESENCE_BYTES,
  whiteboardElementSchema,
  whiteboardModeSchema,
  whiteboardPresenceMessageSchema,
  type WhiteboardMode,
  type WhiteboardServerMessage,
} from "@quincy/shared";
import type { Env, SessionUser } from "../env";
import { hasProjectCollaborationAccessForUser } from "../middleware/capability";
import { PresenceBook, decodeName, type Attachment } from "./presence";
import { clearElements, ensureSchema, normaliseIndices, readElements, reconcile } from "./scene-store";

/** Trusted headers the app worker's route sets after it has authenticated and authorised the
 * caller. The route builds a fresh Request, so a browser can never inject these. */
export const WHITEBOARD_USER_HEADER = "x-wb-user";
export const WHITEBOARD_MODE_HEADER = "x-wb-mode";
export const WHITEBOARD_PROJECT_HEADER = "x-wb-project";
/** #499: the user's display name, URI-encoded by the route (a header is a ByteString). Presence is labelled from this, never from the client. */
export const WHITEBOARD_NAME_HEADER = "x-wb-name";

// The envelope is checked first so a frame that is not even shaped like a batch closes the
// socket (a buggy or hostile client), while a batch with one bad element is merely rejected.
const envelopeSchema = z.object({
  type: z.literal("elements"),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  elements: z.array(z.unknown()).max(WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE),
});

const encoder = new TextEncoder();
const OPEN = 1;

type Access = { exists: boolean; archived: boolean; access: boolean };

/**
 * One Durable Object per Project holds the Project whiteboard's current scene (ADR 0017) and
 * relays it live. Everything else lives beside it: `scene-store.ts` (the element table and
 * Excalidraw's reconciliation) and `presence.ts` (who is here and where their cursor is). This
 * object is the dispatch and the broadcast.
 *
 * Relay (#499): after a batch commits, the elements that won go to every OTHER socket (in the form that was stored: a
 * shape whose index was taken is re-keyed by the server, see `whiteboard-index.ts`), and the stored rows that beat the
 * sender's elements, with its own re-keyed ones, go back to the sender BEFORE its `ack`. Nothing else is echoed to it.
 *
 * Access (#499): the Project's archive/restore and membership routes call `refreshAccess()`, which
 * rereads the Project and each connected user's current access and then switches sockets to
 * view-only, back to edit, or closes them (4403). No stale booleans are passed in, so notifications
 * that arrive out of order converge. Every element batch re-checks the same state, so a lost
 * notification cannot let a write through.
 *
 * Uses the hibernation API: sockets are accepted through `ctx.acceptWebSocket`, so the object can
 * be evicted while clients stay connected. Versions arrive with #500 and media with #501.
 */
export class ProjectWhiteboardDO extends DurableObject<Env> {
  private readonly presence = new PresenceBook();
  /** Serialises `refreshAccess`, so a later call always rereads after an earlier one has applied. */
  private refreshQueue: Promise<unknown> = Promise.resolve();
  /**
   * Advanced SYNCHRONOUSLY when `refreshAccess()` is invoked, before it is queued, even when no mode will change. A
   * write authorizes from reads it makes itself; if the epoch moved while it read, a refresh was invoked (so something
   * committed that the read may not show) and the read cannot be trusted. Writes are never put on the refresh queue
   * (that would add a D1 round-trip to every ack); they wait for its tail only when the epoch moved.
   *
   * Correctness assumes D1 PRIMARY reads (no Sessions API / read replication), and that every route that changes
   * archive state or membership calls `refreshAccess()` AFTER its change has committed.
   */
  private accessEpoch = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Before anything is served or accepted, a table written before indices were unique is brought to the invariant, and
    // every socket that survived the wake (hibernation keeps them) is told what changed. An already-unique table is a scan.
    ctx.blockConcurrencyWhile(async () => {
      ensureSchema(this.ctx.storage);
      const changed = normaliseIndices(this.ctx.storage);
      if (changed.length > 0) this.broadcast({ type: "elements", elements: changed }, "");
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const userId = request.headers.get(WHITEBOARD_USER_HEADER);
    const mode = whiteboardModeSchema.safeParse(request.headers.get(WHITEBOARD_MODE_HEADER));
    if (!userId || !mode.success) return new Response("Missing connection identity", { status: 400 });
    const projectId = request.headers.get(WHITEBOARD_PROJECT_HEADER);
    if (!projectId) return new Response("Missing connection identity", { status: 400 });
    const name = decodeName(request.headers.get(WHITEBOARD_NAME_HEADER));
    // The route authorised this person a moment ago, and a membership removal or an archive may have landed since
    // (and its refresh already run). Admission therefore rereads the Project and the person's access under the SAME
    // epoch rule as a write (`authorize`): a read overtaken by a `refreshAccess()` invocation is not trusted; admission
    // waits for the refresh queue's tail and rereads with a fresh epoch capture, and if that is overtaken too it is
    // refused (no 101, no init). Admission is never put on the refresh queue (it would deadlock on that tail). Nothing
    // awaits between the trusted read and the socket's registration below, so a later refresh always sees the socket.
    // The mode comes from this read, not from the route's header.
    const state = await this.authorize({ userId, projectId });
    if (state === "stale") return new Response("Forbidden", { status: 403 });
    if (!state.exists) return new Response("Project not found", { status: 404 });
    if (!state.access) return new Response("Forbidden", { status: 403 });
    ensureSchema(this.ctx.storage);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { userId, mode: state.archived ? "view" : "edit", projectId, sessionId: crypto.randomUUID(), name };
    server.serializeAttachment(attachment);
    const peers = this.attachments().filter((other) => other.attachment.sessionId !== attachment.sessionId).map((other) => this.presence.peer(other.attachment));
    this.send(server, { type: "init", mode: attachment.mode, sessionId: attachment.sessionId, elements: readElements(this.ctx.storage), peers });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return this.reject(ws);
    // Cheap length bound first; the byte count only matters when the string could be near the cap.
    if (message.length > WHITEBOARD_MAX_MESSAGE_BYTES || (message.length * 3 > WHITEBOARD_MAX_MESSAGE_BYTES && encoder.encode(message).byteLength > WHITEBOARD_MAX_MESSAGE_BYTES)) return this.reject(ws);
    let json: unknown;
    try { json = JSON.parse(message); } catch { return this.reject(ws); }
    if (typeof json === "object" && json !== null && (json as { type?: unknown }).type === "presence") return this.onPresence(ws, message, json);
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return this.reject(ws);
    const { seq } = envelope.data;
    const attachment = readAttachment(ws);
    if (!attachment) return this.send(ws, { type: "rejected", seq, reason: "view-only" });
    // A socket only ever moves to edit through `refreshAccess` (and admission): a write's own read can be overtaken by
    // an archive or a restore while it awaits, so it must never upgrade. A view-only socket is refused without a read.
    if (attachment.mode !== "edit") return this.send(ws, { type: "rejected", seq, reason: "view-only" });
    // For an edit socket the Project and the person's access are reread on EVERY batch, as the backstop for a
    // notification that never arrived. The read is trusted only if no `refreshAccess()` was invoked while it ran
    // (`accessEpoch`). If one was, wait for the refresh queue's tail (every refresh invoked so far has then applied) and
    // read once more; if the epoch moves again the write is refused (`stale`) and the client sends it again.
    const state = await this.authorize(attachment);
    // From here to the ack nothing awaits: the reconcile, the broadcast and the ack run in one turn, so no refresh can
    // interleave with the commit.
    if (ws.readyState !== OPEN) return;
    if (state === "stale") return this.send(ws, { type: "rejected", seq, reason: "stale" });
    if (!state.exists) return this.close(ws, WHITEBOARD_CLOSE.deleted, "Project deleted");
    if (!state.access) return this.revoke(ws);
    // Fail closed: an archived read (or a refresh that moved this socket meanwhile) refuses the write.
    const current = readAttachment(ws);
    if (!current || current.mode !== "edit") return this.send(ws, { type: "rejected", seq, reason: "view-only" });
    if (state.archived) {
      ws.serializeAttachment({ ...current, mode: "view" } satisfies Attachment);
      this.send(ws, { type: "mode", mode: "view" });
      return this.send(ws, { type: "rejected", seq, reason: "view-only" });
    }
    const elements = z.array(whiteboardElementSchema).safeParse(envelope.data.elements);
    if (!elements.success) return this.send(ws, { type: "rejected", seq, reason: "invalid" });
    if (elements.data.some((element) => encoder.encode(JSON.stringify(element)).byteLength > WHITEBOARD_MAX_ELEMENT_BYTES)) return this.send(ws, { type: "rejected", seq, reason: "invalid" });
    const { winners, losers, rewritten } = reconcile(this.ctx.storage, elements.data);
    if (winners.length > 0) this.broadcast({ type: "elements", elements: winners }, attachment.sessionId);
    const back = [...losers, ...rewritten];
    if (back.length > 0) this.send(ws, { type: "elements", elements: back });
    this.send(ws, { type: "ack", seq });
  }

  /** A trustworthy read of the person's access for a write, or "stale" when refreshes kept overtaking it. */
  private async authorize(attachment: Pick<Attachment, "userId" | "projectId">): Promise<Access | "stale"> {
    const epoch = this.accessEpoch;
    const first = await this.access(attachment);
    if (epoch === this.accessEpoch) return first;
    await this.refreshQueue;
    const again = this.accessEpoch;
    const second = await this.access(attachment);
    return again === this.accessEpoch ? second : "stale";
  }

  webSocketClose(ws: WebSocket, code: number): void {
    this.departed(ws);
    // Echo the close so the runtime releases the socket; 1005/1006 are not sendable codes.
    try { ws.close(code === 1005 || code === 1006 || code < 1000 ? 1000 : code); } catch { /* already closed */ }
  }

  webSocketError(ws: WebSocket): void {
    this.departed(ws);
    try { ws.close(1011, "Socket error"); } catch { /* already closed */ }
  }

  /** Hard delete (see `projects.ts`): disconnect everyone, then drop the board's storage. */
  async purge(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(WHITEBOARD_CLOSE.deleted, "Project deleted"); } catch { /* already closed */ }
    }
    ensureSchema(this.ctx.storage);
    clearElements(this.ctx.storage);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * #499: the Project's archived state or someone's membership changed. Rereads both, then switches
   * each socket to view-only or back, or closes the ones that lost access with 4403. Called after
   * the change has committed (never inside its SQL batch), including when the change was already
   * done, so a retry heals a notification that failed the first time.
   */
  refreshAccess(): Promise<void> {
    this.accessEpoch += 1;                                   // before queueing: it must invalidate reads already in flight
    return this.enqueue(() => this.applyAccessNow());
  }

  /** Runs `task` after every earlier refresh or admission has finished. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.refreshQueue.then(task);
    this.refreshQueue = run.catch(() => undefined);
    return run;
  }

  private async applyAccessNow(): Promise<void> {
    const sockets = this.attachments();
    // A refresh answers only for the sockets that were here when it started. A socket admitted while its reads were in
    // flight was authorised by its own fresh read under the epoch rule; this refresh's answer may predate the change
    // that admitted it, so applying it would close (4403) or downgrade a socket it never read for. The refresh that
    // change queued covers the newcomer.
    const snapshot = new Set(sockets.map((entry) => entry.attachment.sessionId));
    const first = sockets[0];
    if (!first) return;
    const projectId = first.attachment.projectId;
    const project = await this.env.DB.prepare("SELECT archived_at AS archivedAt FROM projects WHERE id = ?").bind(projectId).first<{ archivedAt: number | null }>();
    const archived = project === null || project.archivedAt !== null;
    const access = new Map<string, boolean>();
    if (project) for (const userId of new Set(sockets.map((entry) => entry.attachment.userId))) access.set(userId, await this.userHasAccess(userId, projectId));
    // Apply to the sockets still connected NOW that were in the snapshot: the awaits above let sockets come and go.
    for (const { ws, attachment } of this.attachments()) {
      if (ws.readyState !== OPEN) continue;                     // closing or closed: nothing to tell it, and a send would throw
      try {
        if (!project) { this.close(ws, WHITEBOARD_CLOSE.deleted, "Project deleted"); continue; }   // a deleted Project is final: it covers everyone
        if (!snapshot.has(attachment.sessionId)) continue;      // admitted after this refresh began: not covered by its reads
        const allowed = access.get(attachment.userId);
        if (allowed === undefined) continue;
        if (!allowed) { this.revoke(ws); continue; }
        this.settleMode(ws, attachment, archived ? "view" : "edit");
      } catch (error) {
        // One socket failing must never leave the sockets after it on a stale mode.
        console.error("whiteboard refreshAccess: a socket failed", error);
      }
    }
  }

  private async access(attachment: Pick<Attachment, "userId" | "projectId">): Promise<Access> {
    const project = await this.env.DB.prepare("SELECT archived_at AS archivedAt FROM projects WHERE id = ?").bind(attachment.projectId).first<{ archivedAt: number | null }>();
    if (!project) return { exists: false, archived: true, access: false };
    return { exists: true, archived: project.archivedAt !== null, access: await this.userHasAccess(attachment.userId, attachment.projectId) };
  }

  /** Current collaboration access, by the same rule the routes use (`hasProjectCollaborationAccessForUser`). */
  private async userHasAccess(userId: string, projectId: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT role, active FROM user WHERE id = ?").bind(userId).first<{ role: SessionUser["role"]; active: number | boolean }>();
    if (!row) return false;
    return hasProjectCollaborationAccessForUser(this.env, { id: userId, role: row.role, active: row.active === true || row.active === 1 }, projectId);
  }

  /** Moves the socket to `wanted` and tells it, unless a refresh already moved it while the caller was reading
   * (that newer answer stands). Returns the mode now in force. */
  private settleMode(ws: WebSocket, before: Attachment, wanted: WhiteboardMode): WhiteboardMode {
    const current = readAttachment(ws);
    if (!current) return before.mode;
    if (current.mode !== before.mode) return current.mode;
    if (current.mode === wanted) return wanted;
    ws.serializeAttachment({ ...current, mode: wanted } satisfies Attachment);
    this.send(ws, { type: "mode", mode: wanted });
    return wanted;
  }

  private onPresence(ws: WebSocket, raw: string, json: unknown): void {
    const attachment = readAttachment(ws);
    // A malformed, oversized or too-frequent cursor frame is dropped, not punished: it is ephemeral.
    if (!attachment || raw.length > WHITEBOARD_MAX_PRESENCE_BYTES) return;
    const parsed = whiteboardPresenceMessageSchema.safeParse(json);
    if (!parsed.success || !this.presence.allow(attachment.sessionId)) return;
    const { pointer, button, selectedIds } = parsed.data;
    this.presence.set(attachment.sessionId, { pointer, button, selectedIds });
    this.broadcast({ type: "presence", ...this.presence.peer(attachment) }, attachment.sessionId);
  }

  /** Closes a socket whose person lost access to the Project. */
  private revoke(ws: WebSocket): void {
    this.departed(ws);
    this.close(ws, WHITEBOARD_CLOSE.revoked, "Access revoked");
  }

  /** Tells everyone else this connection is gone, and forgets its cursor. */
  private departed(ws: WebSocket): void {
    const attachment = readAttachment(ws);
    if (!attachment) return;
    if (!this.presence.forget(attachment.sessionId)) return;
    this.broadcast({ type: "peer-left", sessionId: attachment.sessionId }, attachment.sessionId);
    if (this.attachments().every((other) => other.attachment.sessionId === attachment.sessionId)) this.presence.idle();
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private reject(ws: WebSocket): void {
    this.close(ws, WHITEBOARD_CLOSE.malformed, "Malformed message");
  }

  private attachments(): Array<{ ws: WebSocket; attachment: Attachment }> {
    return this.ctx.getWebSockets().flatMap((ws) => { const attachment = readAttachment(ws); return attachment ? [{ ws, attachment }] : []; });
  }

  /** To every open socket except the sender's own (view-only sockets included: they watch). */
  private broadcast(message: WhiteboardServerMessage, exceptSessionId: string): void {
    const text = JSON.stringify(message);
    for (const { ws, attachment } of this.attachments()) {
      if (attachment.sessionId === exceptSessionId || ws.readyState !== OPEN) continue;
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  private send(ws: WebSocket, message: WhiteboardServerMessage): void {
    ws.send(JSON.stringify(message));
  }
}

function readAttachment(ws: WebSocket): Attachment | null {
  return ws.deserializeAttachment() as Attachment | null;
}
