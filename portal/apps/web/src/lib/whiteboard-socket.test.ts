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

function setup(probe: WhiteboardSocketDeps["probeAccess"] = async () => ({})) {
  FakeSocket.instances = [];
  const handlers = { onInit: vi.fn(), onConnection: vi.fn(), onDeleted: vi.fn(), onAccessFailure: vi.fn() } satisfies WhiteboardSocketHandlers;
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
    current().open(); current().receive({ type: "init", mode: "edit", elements: [{ id: "a" }] });
    expect(handlers.onInit).toHaveBeenCalledWith({ mode: "edit", elements: [{ id: "a" }] }, false);
    expect(handlers.onConnection).toHaveBeenLastCalledWith("open");
    expect(whiteboardSocketUrl("p1", "http://localhost:5173")).toBe("ws://localhost:5173/api/projects/p1/whiteboard/socket");
  });

  it("resolves a send on its ack and rejects it when the board rejects", async () => {
    const { socket, current } = setup();
    current().open(); current().receive({ type: "init", mode: "edit", elements: [] });
    const saved = socket.send([{ id: "a" }]);
    expect(JSON.parse(current().sent[0]!)).toEqual({ type: "elements", seq: 0, elements: [{ id: "a" }] });
    current().receive({ type: "ack", seq: 0 });
    await expect(saved).resolves.toBeUndefined();
    const refused = socket.send([{ id: "b" }]);
    current().receive({ type: "rejected", seq: 1, reason: "view-only" });
    await expect(refused).rejects.toThrow("view-only");
  });

  it("rejects a send that is not confirmed in time, and one made while disconnected", async () => {
    const { socket, current } = setup();
    await expect(socket.send([])).rejects.toThrow("not connected");
    current().open(); current().receive({ type: "init", mode: "edit", elements: [] });
    const late = socket.send([]); const assertion = expect(late).rejects.toThrow("did not confirm");
    await vi.advanceTimersByTimeAsync(10_001); await assertion;
  });

  it("stops for good on the deleted close code", () => {
    const { handlers, current } = setup();
    current().open(); current().receive({ type: "init", mode: "edit", elements: [] });
    current().drop(4404);
    expect(handlers.onDeleted).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects after a drop and reports the new init as a reconnect", async () => {
    const { handlers, current } = setup();
    current().open(); current().receive({ type: "init", mode: "edit", elements: [] });
    current().drop(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    current().open(); current().receive({ type: "init", mode: "view", elements: [] });
    expect(handlers.onInit).toHaveBeenLastCalledWith({ mode: "view", elements: [] }, true);
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
    idle.current().open(); idle.current().receive({ type: "init", mode: "edit", elements: [] });
    idle.socket.close();
    expect(idle.current().closedWith).toBe(1000);

    const busy = setup();
    busy.current().open(); busy.current().receive({ type: "init", mode: "edit", elements: [] });
    const saved = busy.socket.send([{ id: "a" }]);
    busy.socket.close();
    expect(busy.current().closedWith).toBeNull();
    busy.current().receive({ type: "ack", seq: 0 });
    await saved;
    expect(busy.current().closedWith).toBe(1000);

    const stuck = setup();
    stuck.current().open(); stuck.current().receive({ type: "init", mode: "edit", elements: [] });
    const never = stuck.socket.send([]); const assertion = expect(never).rejects.toThrow();
    stuck.socket.close();
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS + 1);
    await assertion;
    expect(stuck.current().closedWith).toBe(1000);
  });
});
