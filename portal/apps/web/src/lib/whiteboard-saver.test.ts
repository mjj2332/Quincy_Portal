import { describe, expect, it, vi } from "vitest";
import { WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE, WHITEBOARD_MAX_MESSAGE_BYTES } from "@quincy/shared";
import { appliedFromRemote, createWhiteboardSaver, pasteIsUnsupported, withoutUnsupported, planSceneDrop, type SavedElement } from "./whiteboard-saver";

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

  it("tombstones a vanished element above a newer version still in flight", async () => {
    let scene = [el("a", 2)];
    const acks: Array<ReturnType<typeof deferred>> = []; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: (batch) => { sent.push([...batch]); const d = deferred(); acks.push(d); return d.promise; } });
    saver.seed(scene);
    scene = [el("a", 5)];
    const first = saver.flush();          // v5 in flight
    scene = [];                           // then the canvas is replaced
    const second = saver.flush();         // joins the first, then diffs
    acks[0]!.resolve(); await first;
    await Promise.resolve(); await Promise.resolve();
    acks[1]!.resolve(); await second;
    expect(sent.map((batch) => batch.map((e) => `${e.id}:${e.version}:${e.isDeleted === true}`))).toEqual([["a:5:false"], ["a:6:true"]]);
  });

  it("tombstones an element that was created and removed before its ack", async () => {
    let scene = [el("n", 1)];
    const acks: Array<ReturnType<typeof deferred>> = []; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: (batch) => { sent.push([...batch]); const d = deferred(); acks.push(d); return d.promise; } });
    const first = saver.flush();
    scene = [];
    const second = saver.flush();
    acks[0]!.resolve(); await first;
    await Promise.resolve(); await Promise.resolve();
    acks[1]!.resolve(); await second;
    expect(sent[1]).toMatchObject([{ id: "n", isDeleted: true, version: 2 }]);
  });

  it("re-sends an element re-imported at an old version above its synthetic tombstone", async () => {
    let scene = [el("a", 4)];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed(scene);
    scene = [];
    await saver.flush();                   // synthetic tombstone v5
    scene = [el("a", 1, { versionNonce: 99 })];
    await saver.flush();                   // older import must still win
    expect(sent[0]).toMatchObject([{ id: "a", isDeleted: true, version: 5 }]);
    expect(sent[1]).toMatchObject([{ id: "a", version: 6 }]);
    expect(sent[1]![0]!.isDeleted).toBeUndefined();
  });

  it("retries a failed synthetic tombstone", async () => {
    let scene = [el("a", 2)]; let fail = true; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); if (fail) { fail = false; throw new Error("x"); } } });
    saver.seed(scene); scene = [];
    await expect(saver.flush()).rejects.toThrow("x");
    await saver.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject([{ id: "a", isDeleted: true, version: 3 }]);
  });

  it("refuses a scene drop in view-only mode and plans a load in edit mode", () => {
    const file = { name: "board.excalidraw" } as File;
    expect(planSceneDrop([file], true)).toBe("refuse");
    expect(planSceneDrop([file], false)).toEqual({ load: file });
    expect(planSceneDrop([{ name: "photo.png" } as File], true)).toBe("refuse");   // every file, any extension
    expect(planSceneDrop([{ name: "board.json" } as File], false)).toEqual({ load: { name: "board.json" } });
    expect(planSceneDrop([{ name: "lib.excalidrawlib" } as File], false)).toEqual({ load: { name: "lib.excalidrawlib" } });
    expect(planSceneDrop([{ name: "photo.png" } as File], false)).toBe("ignore");
  });

  it("re-sends an element that reappears after a tombstone whose ack was lost", async () => {
    let scene = [el("a", 2)]; const sent: SavedElement[][] = []; let lose = false;
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); if (lose) throw new Error("ack lost"); } });
    await saver.flush();                      // A v2 acked
    scene = []; lose = true;
    await expect(saver.flush()).rejects.toThrow();   // tombstone v3 transmitted, ack lost
    lose = false;
    scene = [el("a", 2)];                     // A is back, equal to its last ACKED state
    await saver.flush();
    expect(sent.at(-1)).toMatchObject([{ id: "a", version: 4 }]);
    expect(sent.at(-1)![0]!.isDeleted).toBeUndefined();
  });
});

describe("remote elements (#499)", () => {
  it("does not echo an element that arrived from another person", async () => {
    const scene = [el("mine", 1), el("theirs", 3)];
    const send = vi.fn().mockResolvedValue(undefined);
    const saver = createWhiteboardSaver({ getElements: () => scene, send });
    saver.seed([el("mine", 1)]);
    saver.adoptRemote([el("theirs", 3)]);
    await saver.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not escalate a version when a remote edit lands over a local one still in flight", async () => {
    const scene = [el("a", 5)]; const sent: SavedElement[][] = []; const ack = deferred();
    const saver = createWhiteboardSaver({ getElements: () => scene, send: (batch) => { sent.push([...batch]); return ack.promise; } });
    const first = saver.flush();                                     // local v5 in flight
    scene[0] = el("a", 6, { x: 99 });                                // the other person's v6 wins and is applied
    saver.adoptRemote([scene[0]!]);
    ack.resolve(); await first;
    await saver.flush();
    expect(sent.map((batch) => batch.map((entry) => entry.version))).toEqual([[5]]);   // v6 is never re-sent as v7
  });

  it("sends the next local edit above the remote version without further escalation", async () => {
    const scene = [el("a", 2)]; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed([el("a", 2)]);
    scene[0] = el("a", 6); saver.adoptRemote([scene[0]!]);
    scene[0] = el("a", 7, { x: 1 });                                  // a local edit on top of the remote v6
    await saver.flush();
    expect(sent).toEqual([[expect.objectContaining({ id: "a", version: 7 })]]);
  });

  it("writes no tombstone for a remote element it was never given", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const saver = createWhiteboardSaver({ getElements: () => [el("mine", 1)], send });
    saver.seed([el("mine", 1)]);                                      // "theirs" is not in the scene and was never adopted
    await saver.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("still sends a local delete of a remote element as a tombstone above the remote version", async () => {
    const scene = [el("theirs", 4)]; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.adoptRemote([el("theirs", 4)]);
    scene.length = 0;                                                  // removed from the scene without a tombstone
    await saver.flush();
    expect(sent[0]![0]).toMatchObject({ id: "theirs", isDeleted: true, version: 5 });
  });
});

describe("appliedFromRemote (#499)", () => {
  it("returns the scene elements that came from the remote batch, not the ones the local copy beat", () => {
    const remote = [el("won", 3), el("lost", 2), el("absent", 1)];
    const scene = [el("won", 3), el("lost", 5), el("mine", 1)];
    expect(appliedFromRemote(remote, scene).map((entry) => entry.id)).toEqual(["won"]);
  });
  it("treats an equal version with a different nonce as not applied", () => {
    expect(appliedFromRemote([{ id: "a", version: 2, versionNonce: 1 }], [{ id: "a", version: 2, versionNonce: 2 }])).toEqual([]);
  });
});
