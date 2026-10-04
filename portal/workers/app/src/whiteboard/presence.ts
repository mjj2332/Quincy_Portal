import type { WhiteboardMode, WhiteboardPeer, WhiteboardPresenceMessage } from "@quincy/shared";

/** What each hibernatable socket remembers (the attachment is limited to 2 KB, so the name is cut
 * short and the pointer and selection, which are large and short-lived, stay in memory instead). */
export type Attachment = { userId: string; mode: WhiteboardMode; projectId: string; sessionId: string; name: string };

export const MAX_NAME_LENGTH = 64;
/** Pointer frames beyond this many per second, per socket, are dropped: a cursor is fresh or worthless. */
export const PRESENCE_LIMIT_PER_SECOND = 30;

/** The route sends the name URI-encoded (a header is a ByteString, so a non-Latin-1 name would throw). */
export function decodeName(header: string | null): string {
  let name = "";
  try { name = decodeURIComponent(header ?? ""); } catch { name = ""; }
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join("").trim() || "Someone";
}

type PresenceState = Pick<WhiteboardPresenceMessage, "pointer" | "button" | "selectedIds">;
const NO_PRESENCE: PresenceState = { pointer: null, button: "up", selectedIds: [] };

/**
 * In-memory presence for the open sockets: the last pointer and selection per session, and the
 * per-socket rate limit. Losing it when the object is evicted costs nothing: the next frame
 * from each client rebuilds it.
 */
export class PresenceBook {
  private readonly states = new Map<string, PresenceState>();
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly gone = new Set<string>();

  /** True when a frame from this session may be relayed now. */
  allow(sessionId: string, now = Date.now()): boolean {
    const window = this.windows.get(sessionId);
    if (!window || now - window.start >= 1000) { this.windows.set(sessionId, { start: now, count: 1 }); return true; }
    window.count += 1;
    return window.count <= PRESENCE_LIMIT_PER_SECOND;
  }

  set(sessionId: string, state: PresenceState): void { this.states.set(sessionId, state); }
  /** Forgets a session. True the first time only: a socket that is revoked is told gone once, though its close arrives later too. */
  forget(sessionId: string): boolean {
    this.states.delete(sessionId); this.windows.delete(sessionId);
    if (this.gone.has(sessionId)) return false;
    this.gone.add(sessionId);
    return true;
  }
  /** Nobody is connected, so no one is left to be told twice. */
  idle(): void { this.gone.clear(); }

  /** The peer entry for a connection, with whatever pointer and selection it last sent. */
  peer(attachment: Attachment): WhiteboardPeer {
    return { sessionId: attachment.sessionId, userId: attachment.userId, name: attachment.name, ...(this.states.get(attachment.sessionId) ?? NO_PRESENCE) };
  }
}
