import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { CLOSE_GRACE_MS, openWhiteboardSocket, whiteboardSocketUrl, type WhiteboardSocketDeps, type WhiteboardSocketHandlers } from "./whiteboard-socket";

type Listener = (event: never) => void;
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0; sent: string[] = []; closedWith: number | null = null;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string) { this.sent.push(data); }
  close(code?: number) { this.closedWith = code ?? 1000; this.readyState = 3; }
  open() { this.readyState = 1; this.emit("open", {}); }
  receive(message: unknown) { this.emit("message", { data: JSON.stringify(message) }); }
  drop(code: number) { this.readyState = 3; this.emit("close", { code }); }
  private emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event as never); }
}

const init = (mode: "edit" | "view" = "edit", elements: unknown[] = [], peers: unknown[] = []) => ({ type: "init", mode, generation: 1, sessionId: "s1", elements, peers });

function setup(probe: WhiteboardSocketDeps["probeAccess"] = async () => ({})) {
  FakeSocket.instances = [];
  const handlers = { onInit: vi.fn(), onConnection: vi.fn(), onDeleted: vi.fn(), onAccessFailure: vi.fn(), onElements: vi.fn(), onPresence: vi.fn(), onPeerLeft: vi.fn(), onMode: vi.fn() } satisfies WhiteboardSocketHandlers;
  const probeAccess = vi.fn(probe);
  const socket = openWhiteboardSocket("p1", handlers, { createSocket: (url) => new FakeSocket(url), probeAccess, origin: () => "https://portal.example" });
  return { socket, handlers, probeAccess, current: () => FakeSocket.instances.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("whiteboard socket", () => {
  it("connects to the wss route and hands the first init to the board", () => {
    const { handlers, current } = setup();
    expect(current().url).toBe("wss://portal.example/api/projects/p1/whiteboard/socket");
    current().open(); current().receive(init("edit", [{ id: "a" }]));
    expect(handlers.onInit).toHaveBeenCalledWith({ mode: "edit", generation: 1, elements: [{ id: "a" }], sessionId: "s1", peers: [] }, false);
    expect(handlers.onConnection).toHaveBeenLastCalledWith("open");
    expect(whiteboardSocketUrl("p1", "http://localhost:5173")).toBe("ws://localhost:5173/api/projects/p1/whiteboard/socket");
  });

  it("resolves a send on its ack and rejects it when the board rejects", async () => {
    const { socket, current } = setup();
    current().open(); current().receive(init());
    const saved = socket.send([{ id: "a" }]);
    expect(JSON.parse(current().sent[0]!)).toEqual({ type: "elements", seq: 0, generation: 1, elements: [{ id: "a" }] });
    current().receive({ type: "ack", seq: 0, generation: 1 });
    await expect(saved).resolves.toBeUndefined();
    const refused = socket.send([{ id: "b" }]);
    current().receive({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
    await expect(refused).rejects.toThrow("view-only");
  });

  it("rejects a send that is not confirmed in time, and one made while disconnected", async () => {
    const { socket, current } = setup();
    await expect(socket.send([])).rejects.toThrow("not connected");
    current().open(); current().receive(init());
    const late = socket.send([]); const assertion = expect(late).rejects.toThrow("did not confirm");
    await vi.advanceTimersByTimeAsync(10_001); await assertion;
  });

  it("stamps every batch with the board's generation, and follows a reset to the new one (#500)", async () => {
    const { socket, current } = setup();
    current().open(); current().receive({ ...init(), generation: 4 });
    void socket.send([{ id: "a" }]);
    expect(JSON.parse(current().sent[0]!)).toMatchObject({ seq: 0, generation: 4 });
    current().receive({ type: "reset", generation: 5, elements: [{ id: "z", version: 1 }] });
    void socket.send([{ id: "b" }]);
    expect(JSON.parse(current().sent[1]!)).toMatchObject({ seq: 1, generation: 5 });
  });

  it("hands a reset to the board's onReset handler with the new generation and the authoritative scene (#500)", () => {
    FakeSocket.instances = [];
    const onReset = vi.fn();
    const handlers = { onInit: vi.fn(), onConnection: vi.fn(), onDeleted: vi.fn(), onAccessFailure: vi.fn(), onElements: vi.fn(), onPresence: vi.fn(), onPeerLeft: vi.fn(), onMode: vi.fn(), onReset } satisfies WhiteboardSocketHandlers;
    openWhiteboardSocket("p1", handlers, { createSocket: (url) => new FakeSocket(url), probeAccess: async () => ({}), origin: () => "https://portal.example" });
    const socket = FakeSocket.instances.at(-1)!;
    socket.open(); socket.receive(init());
    socket.receive({ type: "reset", generation: 2, elements: [{ id: "z", version: 1 }] });
    expect(onReset).toHaveBeenCalledWith({ generation: 2, elements: [{ id: "z", version: 1 }] });
  });

  it("tells the board a generation rejection means the board was restored, and does not retry silently (#500)", async () => {
    const { socket, current } = setup();
    current().open(); current().receive(init());
    const refused = socket.send([{ id: "a" }]);
    current().receive({ type: "rejected", seq: 0, reason: "generation", generation: 2 });
    await expect(refused).rejects.toThrow("restored");
  });

  it("stops for good on the deleted close code", () => {
    const { handlers, current } = setup();
    current().open(); current().receive(init());
    current().drop(4404);
    expect(handlers.onDeleted).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects after a drop and reports the new init as a reconnect", async () => {
    const { handlers, current } = setup();
    current().open(); current().receive(init());
    current().drop(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    current().open(); current().receive(init("view"));
    expect(handlers.onInit).toHaveBeenLastCalledWith({ mode: "view", generation: 1, elements: [], sessionId: "s1", peers: [] }, true);
  });

  it("asks the API why a connect that never opened failed, and hands the answer on", async () => {
    const refusal = new ApiError("Forbidden", 403);
    const { handlers, probeAccess, current } = setup(async () => { throw refusal; });
    current().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(probeAccess).toHaveBeenCalledWith("p1");
    expect(handlers.onAccessFailure).toHaveBeenCalledWith(refusal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("keeps retrying when the probe shows only a network failure or the Project is fine", async () => {
    const { handlers, current } = setup(async () => { throw new ApiError("offline", 0); });
    current().drop(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handlers.onAccessFailure).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("closes at once when nothing is in flight, and waits for an in-flight save's ack otherwise", async () => {
    const idle = setup();
    idle.current().open(); idle.current().receive(init());
    idle.socket.close();
    expect(idle.current().closedWith).toBe(1000);

    const busy = setup();
    busy.current().open(); busy.current().receive(init());
    const saved = busy.socket.send([{ id: "a" }]);
    busy.socket.close();
    expect(busy.current().closedWith).toBeNull();
    busy.current().receive({ type: "ack", seq: 0, generation: 1 });
    await saved;
    expect(busy.current().closedWith).toBe(1000);

    const stuck = setup();
    stuck.current().open(); stuck.current().receive(init());
    const never = stuck.socket.send([]); const assertion = expect(never).rejects.toThrow();
    stuck.socket.close();
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS + 1);
    await assertion;
    expect(stuck.current().closedWith).toBe(1000);
  });

  it("hands relayed elements, presence, departures and mode changes to the board, in order", () => {
    const { handlers, current } = setup();
    current().open(); current().receive(init());
    current().receive({ type: "elements", generation: 1, elements: [{ id: "b", version: 2 }] });
    const peer = { sessionId: "s2", userId: "u2", name: "Ana", pointer: { x: 1, y: 2 }, button: "up", selectedIds: ["b"] };
    current().receive({ type: "presence", ...peer });
    current().receive({ type: "peer-left", sessionId: "s2" });
    current().receive({ type: "mode", mode: "view" });
    expect(handlers.onElements).toHaveBeenCalledWith([{ id: "b", version: 2 }]);
    expect(handlers.onPresence).toHaveBeenCalledWith(peer);
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("s2");
    expect(handlers.onMode).toHaveBeenCalledWith("view");
  });

  it("ignores a frame from a socket it has already replaced, and a frame it cannot parse", () => {
    const { handlers, current } = setup();
    const first = current(); first.open(); first.receive(init());
    first.drop(1006);
    first.receive({ type: "elements", elements: [{ id: "late" }] });
    current().receive({ type: "elements", elements: "nope" });
    expect(handlers.onElements).not.toHaveBeenCalled();
  });

  describe("presence", () => {
    const cursor = (x: number) => ({ pointer: { x, y: 0 }, button: "up" as const, selectedIds: [] as string[] });
    const sentPresence = (socket: FakeSocket) => socket.sent.map((text) => JSON.parse(text)).filter((message) => message.type === "presence");

    it("sends a pointer at once, then at most one frame per 50 ms, the latest last, never queued", () => {
      const { socket, current } = setup();
      current().open(); current().receive(init());
      socket.sendPresence(cursor(1));
      expect(sentPresence(current())).toEqual([{ type: "presence", ...cursor(1) }]);
      socket.sendPresence(cursor(2)); socket.sendPresence(cursor(3)); socket.sendPresence(cursor(4));
      expect(sentPresence(current())).toHaveLength(1);
      vi.advanceTimersByTime(50);
      expect(sentPresence(current()).map((message) => message.pointer.x)).toEqual([1, 4]);
      vi.advanceTimersByTime(500);
      expect(sentPresence(current())).toHaveLength(2);                 // nothing pending: nothing more
    });

    it("sends at most the protocol's 500 selected ids, so a large selection never makes every pointer frame invalid", () => {
      const { socket, current } = setup();
      current().open(); current().receive(init());
      socket.sendPresence({ pointer: { x: 1, y: 1 }, button: "up", selectedIds: Array.from({ length: 600 }, (_, index) => `e${index}`) });
      const [frame] = sentPresence(current());
      expect(frame.selectedIds).toHaveLength(500);
      expect(frame.selectedIds[0]).toBe("e0");
    });

    it("drops presence while the socket is not open, without throwing and without queueing it for later", () => {
      const { socket, current } = setup();
      socket.sendPresence(cursor(1));                                  // connecting
      current().open();
      vi.advanceTimersByTime(200);
      expect(sentPresence(current())).toEqual([]);
      current().receive(init());
      current().drop(1006); socket.sendPresence(cursor(2));
      vi.advanceTimersByTime(1_000);
      expect(FakeSocket.instances.flatMap(sentPresence)).toEqual([]);
    });

    it("does not let a pending trailing frame leak onto the next connection", async () => {
      const { socket, current } = setup();
      current().open(); current().receive(init());
      socket.sendPresence(cursor(1)); socket.sendPresence(cursor(2));
      const first = current(); first.drop(1006);
      await vi.advanceTimersByTimeAsync(1_000);
      current().open(); current().receive(init());
      vi.advanceTimersByTime(200);
      expect(sentPresence(current())).toEqual([]);
      expect(sentPresence(first)).toHaveLength(1);
    });
  });

  describe("revoked access (4403)", () => {
    it("asks the API why and hands the answer on, without ever reconnecting", async () => {
      const refusal = new ApiError("Forbidden", 403);
      const { handlers, probeAccess, current } = setup(async () => { throw refusal; });
      current().open(); current().receive(init());
      current().drop(4403);
      await vi.advanceTimersByTimeAsync(0);
      expect(probeAccess).toHaveBeenCalledWith("p1");
      expect(handlers.onAccessFailure).toHaveBeenCalledWith(refusal);
      expect(handlers.onConnection).toHaveBeenLastCalledWith("closed");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it("still ends the session when the probe finds nothing wrong: the server's close is the answer", async () => {
      const { handlers, current } = setup(async () => ({}));
      current().open(); current().receive(init());
      current().drop(4403);
      await vi.advanceTimersByTimeAsync(0);
      expect(handlers.onAccessFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it("treats a network failure during the probe as a drop and reconnects", async () => {
      const { handlers, current } = setup(async () => { throw new ApiError("offline", 0); });
      current().open(); current().receive(init());
      current().drop(4403);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handlers.onAccessFailure).not.toHaveBeenCalled();
      expect(FakeSocket.instances).toHaveLength(2);
    });
  });
});
