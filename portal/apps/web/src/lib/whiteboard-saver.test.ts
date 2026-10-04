import { describe, expect, it, vi } from "vitest";
import { WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE, WHITEBOARD_MAX_MESSAGE_BYTES } from "@quincy/shared";
import { createWhiteboardSaver, pasteIsUnsupported, withoutUnsupported, type SavedElement } from "./whiteboard-saver";

const el = (id: string, version: number, extra: Record<string, unknown> = {}): SavedElement => ({ id, version, versionNonce: version * 7, ...extra });
const deferred = () => { let resolve!: () => void; let reject!: (e: Error) => void; const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

describe("whiteboard saver", () => {
  it("records the versions that were transmitted, so an edit made before the ack is still sent", async () => {
    const scene = [el("a", 2)];
    const acks: Array<ReturnType<typeof deferred>> = []; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: (batch) => { sent.push([...batch]); const d = deferred(); acks.push(d); return d.promise; } });
    const first = saver.flush();
    expect(sent).toHaveLength(1);
    scene[0] = el("a", 3);               // edited while v2 is in flight
    acks[0]!.resolve(); await first;
    const second = saver.flush();
    expect(sent.map((batch) => batch[0]!.version)).toEqual([2, 3]);
    acks[1]!.resolve(); await second;
    await saver.flush();
    expect(sent).toHaveLength(2);        // v3 is now recorded; nothing left to send
  });

  it("does not resend an element that is already in flight", async () => {
    const scene = [el("a", 1)]; const send = vi.fn(() => new Promise<void>(() => {}));
    const saver = createWhiteboardSaver({ getElements: () => scene, send });
    void saver.flush(); void saver.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed batch unrecorded so the next flush retries it", async () => {
    const scene = [el("a", 1)]; const send = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const saver = createWhiteboardSaver({ getElements: () => scene, send });
    await expect(saver.flush()).rejects.toThrow("down");
    await saver.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("starts from the loaded scene: seeded elements are not sent", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const saver = createWhiteboardSaver({ getElements: () => [el("a", 1)], send });
    saver.seed([el("a", 1)]);
    await saver.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("splits more than 5,000 changed elements across batches and records each after its own ack", async () => {
    const scene = Array.from({ length: WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE * 2 + 1 }, (_, i) => el(`e${i}`, 1));
    const sizes: number[] = []; const failSecond = vi.fn();
    const send = vi.fn(async (batch: readonly SavedElement[]) => { sizes.push(batch.length); if (sizes.length === 2 && !failSecond.mock.calls.length) { failSecond(); throw new Error("batch 2 failed"); } });
    const saver = createWhiteboardSaver({ getElements: () => scene, send });
    await expect(saver.flush()).rejects.toThrow("batch 2 failed");
    expect(sizes).toEqual([5000, 5000, 1]);
    sizes.length = 0;
    await saver.flush();                  // only the failed batch is resent
    expect(sizes).toEqual([5000]);
  });

  it("splits by serialized size under the 1 MiB message cap", async () => {
    const big = "x".repeat(200 * 1024);
    const scene = Array.from({ length: 8 }, (_, i) => el(`e${i}`, 1, { text: big }));
    const bytes: number[] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { bytes.push(new TextEncoder().encode(JSON.stringify({ type: "elements", seq: 999999, elements: batch })).byteLength); } });
    await saver.flush();
    expect(bytes.length).toBeGreaterThan(1);
    for (const size of bytes) expect(size).toBeLessThanOrEqual(WHITEBOARD_MAX_MESSAGE_BYTES);
  });

  it("flush waits for a save already in flight and rejects if that save fails", async () => {
    const scene = [el("a", 2)]; const d = deferred(); let calls = 0;
    const saver = createWhiteboardSaver({ getElements: () => scene, send: () => { calls += 1; return d.promise; } });
    const autosave = saver.flush(); autosave.catch(() => undefined);
    let settled = "pending";
    const close = saver.flush().then(() => { settled = "ok"; }, () => { settled = "failed"; });
    await Promise.resolve();
    expect(settled).toBe("pending");       // not skipped: it waits on the in-flight save
    d.reject(new Error("dropped")); await close;
    expect(settled).toBe("failed");
    expect(calls).toBe(1);
  });

  it("never sends an image element, tombstones included", async () => {
    const scene = [el("a", 1), el("img", 1, { type: "image", isDeleted: true })];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    await saver.flush();
    expect(sent.flat().map((e) => e.id)).toEqual(["a"]);
  });

  it("refuses a paste that carries an image", () => {
    expect(pasteIsUnsupported({ elements: [{ type: "rectangle" }, { type: "image" }] })).toBe(true);
    expect(pasteIsUnsupported({ elements: [{ type: "rectangle" }] })).toBe(false);
    expect(pasteIsUnsupported({})).toBe(false);
  });

  // File open, library insert and drag-drop all land in the scene, where the sweep removes them.
  it.each(["file open", "library insert", "drag-drop"])("sweeps an image that arrived by %s", () => {
    const scene = [{ id: "r", type: "rectangle" }, { id: "i", type: "image" }];
    const { kept, removed } = withoutUnsupported(scene);
    expect(removed).toBe(1);
    expect(kept.map((e) => e.id)).toEqual(["r"]);
  });

  it("leaves a scene without images untouched, and ignores already-deleted images in the count", () => {
    const scene = [{ id: "r", type: "rectangle" }];
    expect(withoutUnsupported(scene)).toEqual({ kept: scene, removed: 0 });
    expect(withoutUnsupported([{ id: "i", type: "image", isDeleted: true }]).removed).toBe(0);
  });

  it("sends a tombstone for an element that vanished from the scene without one", async () => {
    let scene = [el("a", 2), el("b", 1)];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed(scene);
    scene = [el("c", 1)];                 // a scene file replaced the canvas: A and B are simply gone
    await saver.flush();
    const sentById = new Map(sent.flat().map((e) => [e.id, e]));
    expect(sentById.get("a")).toMatchObject({ isDeleted: true, version: 3 });
    expect(sentById.get("b")).toMatchObject({ isDeleted: true, version: 2 });
    expect(sentById.get("c")?.isDeleted).toBeUndefined();
    sent.length = 0;
    await saver.flush();                  // tombstones are recorded: nothing repeats
    expect(sent).toHaveLength(0);
  });
});
