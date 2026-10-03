import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  WHITEBOARD_CLOSE,
  WHITEBOARD_MAX_ELEMENT_BYTES,
  WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE,
  WHITEBOARD_MAX_MESSAGE_BYTES,
  whiteboardElementSchema,
  whiteboardIncomingWins,
  whiteboardModeSchema,
  type WhiteboardMode,
  type WhiteboardServerMessage,
} from "@quincy/shared";
import type { Env } from "../env";

/** Trusted headers the app worker's route sets after it has authenticated and authorised the
 * caller. The route builds a fresh Request, so a browser can never inject these. */
export const WHITEBOARD_USER_HEADER = "x-wb-user";
export const WHITEBOARD_MODE_HEADER = "x-wb-mode";

/** What each hibernatable socket remembers (the attachment is limited to 2 KB). */
type Attachment = { userId: string; mode: WhiteboardMode };

type ElementRow = { json: string };

// The envelope is checked first so a frame that is not even shaped like a batch closes the
// socket (a buggy or hostile client), while a batch with one bad element is merely rejected.
const envelopeSchema = z.object({
  type: z.literal("elements"),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  elements: z.array(z.unknown()).max(WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE),
});

const encoder = new TextEncoder();

/**
 * One Durable Object per Project holds the Project whiteboard's current scene (ADR 0017).
 *
 * #498 stores the scene one row per Excalidraw element (every row far below the 2 MB row limit)
 * and reconciles each incoming element against its stored row with Excalidraw's own rule, so two
 * people saving over each other can never replace the whole board -- only elements whose version
 * is newer. Live broadcast and presence arrive with #499, versions with #500 and media with #501.
 *
 * Uses the hibernation API: sockets are accepted through `ctx.acceptWebSocket`, so the object can
 * be evicted while clients stay connected.
 */
export class ProjectWhiteboardDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      version_nonce INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const userId = request.headers.get(WHITEBOARD_USER_HEADER);
    const mode = whiteboardModeSchema.safeParse(request.headers.get(WHITEBOARD_MODE_HEADER));
    if (!userId || !mode.success) return new Response("Missing connection identity", { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, mode: mode.data } satisfies Attachment);
    this.send(server, { type: "init", mode: mode.data, elements: this.readElements() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return this.reject(ws);
    // Cheap length bound first; the byte count only matters when the string could be near the cap.
    if (message.length > WHITEBOARD_MAX_MESSAGE_BYTES || (message.length * 3 > WHITEBOARD_MAX_MESSAGE_BYTES && encoder.encode(message).byteLength > WHITEBOARD_MAX_MESSAGE_BYTES)) return this.reject(ws);
    let json: unknown;
    try { json = JSON.parse(message); } catch { return this.reject(ws); }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return this.reject(ws);
    const { seq } = envelope.data;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.mode !== "edit") return this.send(ws, { type: "rejected", seq, reason: "view-only" });
    const elements = z.array(whiteboardElementSchema).safeParse(envelope.data.elements);
    if (!elements.success) return this.send(ws, { type: "rejected", seq, reason: "invalid" });
    const serialised = elements.data.map((element) => JSON.stringify(element));
    if (serialised.some((text) => encoder.encode(text).byteLength > WHITEBOARD_MAX_ELEMENT_BYTES)) return this.send(ws, { type: "rejected", seq, reason: "invalid" });
    this.reconcile(elements.data, serialised);
    this.send(ws, { type: "ack", seq });
  }

  webSocketClose(ws: WebSocket, code: number): void {
    // Echo the close so the runtime releases the socket; 1005/1006 are not sendable codes.
    try { ws.close(code === 1005 || code === 1006 || code < 1000 ? 1000 : code); } catch { /* already closed */ }
  }

  /** Hard delete (see `projects.ts`): disconnect everyone, then drop the board's storage. */
  async purge(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(WHITEBOARD_CLOSE.deleted, "Project deleted"); } catch { /* already closed */ }
    }
    this.ctx.storage.sql.exec("DELETE FROM elements");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private reject(ws: WebSocket): void {
    try { ws.close(WHITEBOARD_CLOSE.malformed, "Malformed message"); } catch { /* already closed */ }
  }

  private send(ws: WebSocket, message: WhiteboardServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  private readElements(): Array<Record<string, unknown>> {
    return this.ctx.storage.sql.exec<ElementRow>("SELECT json FROM elements ORDER BY rowid").toArray().map((row) => JSON.parse(row.json) as Record<string, unknown>);
  }

  /** Writes each incoming element that beats its stored row, all in one transaction. */
  private reconcile(elements: ReadonlyArray<z.infer<typeof whiteboardElementSchema>>, serialised: readonly string[]): void {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      elements.forEach((element, index) => {
        const stored = sql.exec<{ version: number; version_nonce: number }>("SELECT version, version_nonce FROM elements WHERE id = ?", element.id).toArray()[0];
        if (!whiteboardIncomingWins(stored ? { version: stored.version, versionNonce: stored.version_nonce } : undefined, element)) return;
        sql.exec(
          `INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version = excluded.version, version_nonce = excluded.version_nonce, is_deleted = excluded.is_deleted, json = excluded.json, updated_at = excluded.updated_at`,
          element.id, element.version, element.versionNonce, element.isDeleted ? 1 : 0, serialised[index]!, now,
        );
      });
    });
  }
}
