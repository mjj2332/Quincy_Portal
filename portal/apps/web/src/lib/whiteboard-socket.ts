import {
  WHITEBOARD_CLOSE,
  WHITEBOARD_MAX_SELECTED_IDS,
  whiteboardServerMessageSchema,
  whiteboardSocketPath,
  type WhiteboardMode,
  type WhiteboardPeer,
  type WhiteboardPresenceMessage,
} from "@quincy/shared";
import { ApiError, apiGet } from "./api";

/**
 * #498: the browser side of a Project whiteboard's WebSocket (ADR 0017). One instance per open
 * board. It connects, hands the first `init` to the board, turns `send` into a promise that
 * settles on the server's `ack`/`rejected`, reconnects with backoff, and stops for good on the
 * deleted close code.
 *
 * #499 makes it live: the server relays other people's winning elements (`onElements`), their cursors
 * (`onPresence`, `onPeerLeft`) and archive/restore (`onMode`), and this side sends the local cursor with
 * `sendPresence` (throttled, fire-and-forget: a cursor frame is fresh or worthless, so it is never queued).
 * Close 4403 means the person lost access: the socket asks the API why (the same probe a refused upgrade
 * gets) and ends the session instead of reconnecting.
 *
 * A browser never sees the HTTP status of a refused upgrade, only a failed connection. So when a
 * connect fails before it ever opened, the socket asks the ordinary collaboration-summary route
 * what the answer was and hands THAT error to `onAccessFailure`, which is the same handler every
 * other Project read feeds (a revoked member, a deleted Project, an expired session).
 */

export type WhiteboardConnection = "connecting" | "open" | "reconnecting" | "closed";
export type WhiteboardInit = { mode: WhiteboardMode; elements: Array<Record<string, unknown>>; sessionId: string; peers: WhiteboardPeer[] };
export type WhiteboardPresenceState = Omit<WhiteboardPresenceMessage, "type" | "selectedIds"> & { selectedIds: readonly string[] };

export type WhiteboardSocketHandlers = {
  /** Every `init`: the first is the scene to load; a reconnect's carries the current mode. */
  onInit: (init: WhiteboardInit, reconnect: boolean) => void;
  onConnection: (state: WhiteboardConnection) => void;
  /** The Project's board was deleted (close 4404): terminal. */
  onDeleted: () => void;
  /** A connect failed, or the server closed the socket as revoked, and the access probe says why: terminal, owned by the caller. */
  onAccessFailure: (error: unknown) => void;
  /** #499: other people's winning elements, or stored rows that beat this client's own batch. */
  onElements: (elements: Array<Record<string, unknown>>) => void;
  /** #499: another connection's pointer and selection (name and session are the server's). */
  onPresence: (peer: WhiteboardPeer) => void;
  onPeerLeft: (sessionId: string) => void;
  /** #499: the Project was archived or restored (view-only or editable), with no reconnect. */
  onMode: (mode: WhiteboardMode) => void;
};

export type WhiteboardSocket = {
  /** Resolves once the server has durably stored the batch; rejects if it could not. */
  send: (elements: readonly unknown[]) => Promise<void>;
  /** #499: shares this client's pointer and selection; dropped unless the socket is open. */
  sendPresence: (state: WhiteboardPresenceState) => void;
  /** Waits (briefly) for in-flight saves, then closes. Safe to call more than once. */
  close: () => void;
};

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (type: "open" | "message" | "close" | "error", listener: (event: never) => void) => void;
};

export type WhiteboardSocketDeps = {
  createSocket: (url: string) => SocketLike;
  probeAccess: (projectId: string) => Promise<unknown>;
  origin: () => string;
};

const OPEN = 1;
export const SEND_TIMEOUT_MS = 10_000;
export const CLOSE_GRACE_MS = 3_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** One presence frame per this many ms (the server drops past ~30 a second). */
export const PRESENCE_INTERVAL_MS = 50;

const defaultDeps: WhiteboardSocketDeps = {
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  probeAccess: (projectId) => apiGet(`/api/projects/${encodeURIComponent(projectId)}/collaboration-summary`),
  origin: () => window.location.origin,
};

export function whiteboardSocketUrl(projectId: string, origin: string): string {
  const url = new URL(whiteboardSocketPath(projectId), origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function openWhiteboardSocket(projectId: string, handlers: WhiteboardSocketHandlers, deps: WhiteboardSocketDeps = defaultDeps): WhiteboardSocket {
  let socket: SocketLike | null = null;
  let everOpened = false;       // this connection attempt
  let initCount = 0;
  let attempt = 0;
  let stopped = false;
  let closing = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  let presenceWaiting: WhiteboardPresenceState | null = null;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const settleAll = (error: Error) => {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); pending.delete(id); }
  };
  const stopPresence = () => { clearTimeout(presenceTimer); presenceTimer = undefined; presenceWaiting = null; };
  const finishIfDrained = () => { if (closing && pending.size === 0) hardClose(); };
  const hardClose = () => {
    stopped = true;
    clearTimeout(reconnectTimer); clearTimeout(closeTimer);
    stopPresence();
    settleAll(new Error("The whiteboard was closed before the save finished."));
    try { socket?.close(1000); } catch { /* already closed */ }
    handlers.onConnection("closed");
  };

  const connect = () => {
    if (stopped) return;
    everOpened = false;
    handlers.onConnection(initCount === 0 ? "connecting" : "reconnecting");
    const current = deps.createSocket(whiteboardSocketUrl(projectId, deps.origin()));
    socket = current;
    current.addEventListener("open", () => { if (socket === current) { everOpened = true; attempt = 0; } });
    current.addEventListener("message", ((event: { data: unknown }) => {
      if (socket !== current || typeof event.data !== "string") return;
      let parsed;
      try { parsed = whiteboardServerMessageSchema.safeParse(JSON.parse(event.data)); } catch { return; }
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "init") {
        handlers.onConnection("open");
        handlers.onInit({ mode: message.mode, elements: message.elements, sessionId: message.sessionId, peers: message.peers }, initCount > 0);
        initCount += 1;
      } else if (message.type === "elements") {
        handlers.onElements(message.elements);
      } else if (message.type === "presence") {
        const { type: _type, ...peer } = message;
        handlers.onPresence(peer);
      } else if (message.type === "peer-left") {
        handlers.onPeerLeft(message.sessionId);
      } else if (message.type === "mode") {
        handlers.onMode(message.mode);
      } else if (message.type === "ack") {
        const entry = pending.get(message.seq);
        if (entry) { clearTimeout(entry.timer); pending.delete(message.seq); entry.resolve(); finishIfDrained(); }
      } else if (message.seq !== undefined) {
        const entry = pending.get(message.seq);
        if (entry) { clearTimeout(entry.timer); pending.delete(message.seq); entry.reject(new Error(message.reason === "view-only" ? "This board is view-only." : "The board rejected the change.")); finishIfDrained(); }
      }
    }) as (event: never) => void);
    current.addEventListener("close", ((event: { code: number }) => {
      if (socket !== current || stopped) return;
      socket = null;
      stopPresence();
      settleAll(new Error("The whiteboard connection closed before the save finished."));
      if (event.code === WHITEBOARD_CLOSE.revoked) { void afterRevoked(); return; }
      if (event.code === WHITEBOARD_CLOSE.deleted) { stopped = true; handlers.onConnection("closed"); handlers.onDeleted(); return; }
      if (closing) { hardClose(); return; }
      void afterDrop(everOpened);
    }) as (event: never) => void);
  };

  const afterDrop = async (hadOpened: boolean) => {
    handlers.onConnection("reconnecting");
    if (!hadOpened) {
      // Never opened: a refused upgrade looks exactly like a network failure from here, so ask the API.
      try { await deps.probeAccess(projectId); }
      catch (error) {
        if (stopped) return;
        // A transport error (status 0) is a network drop, not an answer: keep trying.
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status === "number" && status !== 0) { stopped = true; handlers.onConnection("closed"); handlers.onAccessFailure(error); return; }
      }
      if (stopped) return;
    }
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  };

  /** The server closed this socket because the person lost access. Never reconnect on that alone: ask the API
   * (the same probe a refused upgrade gets) and end the session with its answer. Only a network failure keeps trying. */
  const afterRevoked = async () => {
    handlers.onConnection("reconnecting");
    let failure: unknown = new ApiError("You no longer have access to this project's whiteboard.", 403);
    try { await deps.probeAccess(projectId); }
    catch (error) {
      if (stopped) return;
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status !== "number" || status === 0) {
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
        return;
      }
      failure = error;
    }
    if (stopped) return;
    stopped = true; handlers.onConnection("closed"); handlers.onAccessFailure(failure);
  };

  const transmitPresence = (state: WhiteboardPresenceState) => {
    const current = socket;
    if (stopped || closing || !current || current.readyState !== OPEN) return;
    try { current.send(JSON.stringify({ type: "presence", ...state, selectedIds: state.selectedIds.slice(0, WHITEBOARD_MAX_SELECTED_IDS) })); } catch { /* a cursor is never worth an error */ }
  };

  connect();

  return {
    sendPresence(state) {
      // Leading edge now, trailing edge after the interval, the latest state only: never a queue.
      if (presenceTimer === undefined) {
        transmitPresence(state);
        presenceTimer = setTimeout(function release() {
          const waiting = presenceWaiting; presenceWaiting = null;
          if (waiting) { transmitPresence(waiting); presenceTimer = setTimeout(release, PRESENCE_INTERVAL_MS); }
          else presenceTimer = undefined;
        }, PRESENCE_INTERVAL_MS);
      } else presenceWaiting = state;
    },
    send(elements) {
      const current = socket;
      if (stopped || closing || !current || current.readyState !== OPEN) return Promise.reject(new Error("The whiteboard is not connected."));
      const id = seq++;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("The whiteboard did not confirm the save.")); }, SEND_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try { current.send(JSON.stringify({ type: "elements", seq: id, elements })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error instanceof Error ? error : new Error("The whiteboard could not send.")); }
      });
    },
    close() {
      if (stopped || closing) return;
      closing = true;
      // The board's own unmount save is sent just before this: give its ack a moment to land.
      if (pending.size === 0) { hardClose(); return; }
      closeTimer = setTimeout(hardClose, CLOSE_GRACE_MS);
    },
  };
}
