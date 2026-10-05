import { describe, expect, it, vi } from "vitest";
import { WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE, WHITEBOARD_MAX_MESSAGE_BYTES } from "@quincy/shared";
import { appliedFromRemote, createWhiteboardSaver, pasteIsUnsupported, withoutForeignMedia, withoutUnsupported, planSceneDrop, type SavedElement } from "./whiteboard-saver";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const media = (id: string, kind: "image" | "video" = "image", extra: Record<string, unknown> = {}) => ({ id: `el-${id}`, type: "image", fileId: id, customData: { quincyMedia: { kind } }, ...extra });

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

  it("never sends a malformed image element, tombstones included, and sends a well-formed media element like any other (#501)", async () => {
    const scene = [el("a", 1), el("img", 1, { type: "image", isDeleted: true }), el("foreign", 1, { type: "image", fileId: "abc123hash", customData: { quincyMedia: { kind: "image" } } }), { ...el("pic", 1), ...media(MEDIA_ID), id: "pic" }, { ...el("gone", 2), ...media(OTHER_ID, "video", { isDeleted: true }), id: "gone" }];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    await saver.flush();
    expect(sent.flat().map((e) => e.id).sort()).toEqual(["a", "gone", "pic"]);
  });

  it("refuses a paste that carries a malformed image, and media this board does not hold, but only where a `known` test is given", () => {
    expect(pasteIsUnsupported({ elements: [{ type: "rectangle" }, { type: "image" }] })).toBe(true);
    expect(pasteIsUnsupported({ elements: [{ type: "rectangle" }] })).toBe(false);
    expect(pasteIsUnsupported({})).toBe(false);
    const known = (id: string) => id === MEDIA_ID;
    expect(pasteIsUnsupported({ elements: [media(MEDIA_ID)] }, known)).toBe(false);          // this board's own media: copy and paste works
    expect(pasteIsUnsupported({ elements: [media(OTHER_ID)] }, known)).toBe(true);            // another board's media: refused at the local entry point
    expect(pasteIsUnsupported({ elements: [media(OTHER_ID)] })).toBe(false);                  // without a test (remote elements never pass here) it is a well-formed element
  });

  // File open, library insert and drag-drop all land in the scene, where the sweep removes what the server would refuse.
  it.each(["file open", "library insert", "drag-drop"])("sweeps a malformed image that arrived by %s", () => {
    const scene = [{ id: "r", type: "rectangle" }, { id: "i", type: "image" }];
    const { kept, removed } = withoutUnsupported(scene);
    expect(removed).toBe(1);
    expect(kept.map((e) => e.id)).toEqual(["r"]);
  });

  it("the change-event sweep NEVER removes a well-formed media element, even one whose fileId this client has never seen (a peer's new image)", () => {
    const scene = [{ id: "r", type: "rectangle" }, media(OTHER_ID), media(MEDIA_ID, "video")];
    expect(withoutUnsupported(scene)).toEqual({ kept: scene, removed: 0 });
  });

  it("the scene-file filter drops media this board does not hold and keeps the rest", () => {
    const scene = [{ id: "r", type: "rectangle" }, media(MEDIA_ID), media(OTHER_ID)];
    const { kept, removed } = withoutForeignMedia(scene, (id) => id === MEDIA_ID);
    expect(removed).toBe(1);
    expect(kept.map((e) => e.id)).toEqual(["r", `el-${MEDIA_ID}`]);
  });

  it("leaves a scene without images untouched, and ignores already-deleted images in the count", () => {
    const scene = [{ id: "r", type: "rectangle" }];
    expect(withoutUnsupported(scene)).toEqual({ kept: scene, removed: 0 });
    expect(withoutUnsupported([{ id: "i", type: "image", isDeleted: true }]).removed).toBe(0);
  });

  it("routes dropped files: a scene file loads, image and video files go to the media pipeline, anything else is Excalidraw's, view-only refuses all", () => {
    const f = (name: string, type = "") => new File(["x"], name, { type });
    expect(planSceneDrop([f("a.excalidraw")], false)).toEqual({ load: expect.any(File) });
    expect(planSceneDrop([f("a.png", "image/png"), f("b.mov"), f("c.pdf")], false)).toEqual({ media: [expect.any(File), expect.any(File)] });
    expect(planSceneDrop([f("c.pdf")], false)).toBe("ignore");
    expect(planSceneDrop([f("a.png", "image/png")], true)).toBe("refuse");
    expect(planSceneDrop([], true)).toBe("ignore");
  });

  it("never authors a deletion: an element absent from the scene sends nothing (vanish is the editor's, whiteboard-vanish.ts)", async () => {
    let scene = [el("a", 2), el("b", 1)];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed(scene);
    scene = [el("c", 1)];                 // a scene file replaced the canvas: A and B are simply gone
    await saver.flush();
    expect(sent.flat().map((e) => e.id)).toEqual(["c"]);
  });

  it("sends a deletion the scene holds exactly as the scene holds it, and a failed one again as it was", async () => {
    let scene = [el("a", 2)]; let fail = true; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); if (fail) { fail = false; throw new Error("x"); } } });
    saver.seed(scene);
    scene = [el("a", 3, { isDeleted: true, versionNonce: 31 })];
    await expect(saver.flush()).rejects.toThrow("x");
    await saver.flush();
    expect(sent).toHaveLength(2);
    for (const batch of sent) expect(batch).toMatchObject([{ id: "a", isDeleted: true, version: 3, versionNonce: 31 }]);
    await saver.flush();
    expect(sent).toHaveLength(2);         // acknowledged: nothing repeats
  });

  it("sends an older scene re-imported over a deletion exactly as the scene numbers it (the import authors its own revision)", async () => {
    let scene = [el("a", 5, { isDeleted: true })];
    const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.seed(scene);
    scene = [el("a", 1, { versionNonce: 99 })];
    await saver.flush();
    expect(sent).toEqual([[{ id: "a", version: 1, versionNonce: 99 }]]);   // never raised: the server decides by the rule the editor uses
  });

  it("refuses a scene drop in view-only mode and plans a load in edit mode", () => {
    const file = { name: "board.excalidraw" } as File;
    expect(planSceneDrop([file], true)).toBe("refuse");
    expect(planSceneDrop([file], false)).toEqual({ load: file });
    expect(planSceneDrop([{ name: "photo.png" } as File], true)).toBe("refuse");   // every file, any extension
    expect(planSceneDrop([{ name: "board.json" } as File], false)).toEqual({ load: { name: "board.json" } });
    expect(planSceneDrop([{ name: "lib.excalidrawlib" } as File], false)).toEqual({ load: { name: "lib.excalidrawlib" } });
    expect(planSceneDrop([{ name: "photo.png" } as File], false)).toEqual({ media: [{ name: "photo.png" }] });   // #501: an image goes to the media pipeline
  });

  it("re-sends a deletion whose ack was lost as it was, and an element that came back at its acked revision is sent again unchanged", async () => {
    let scene = [el("a", 2)]; const sent: SavedElement[][] = []; let lose = false;
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); if (lose) throw new Error("ack lost"); } });
    await saver.flush();                      // A v2 acked
    scene = [el("a", 3, { isDeleted: true })]; lose = true;
    await expect(saver.flush()).rejects.toThrow();   // deletion v3 transmitted, ack lost
    lose = false;
    scene = [el("a", 2)];                     // A is back, equal to its last ACKED state
    await saver.flush();
    expect(sent.at(-1)).toEqual([{ id: "a", version: 2, versionNonce: 14 }]);   // the scene's own revision: a conflict is the server's rule to decide
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

  it("B8: a remote arrival during an in-flight save is not clobbered by the older ack, and the next local edit is sent once", async () => {
    const scene = [el("a", 5)]; const sent: SavedElement[][] = []; const ack = deferred();
    const saver = createWhiteboardSaver({ getElements: () => scene, send: (batch) => { sent.push([...batch]); return sent.length === 1 ? ack.promise : Promise.resolve(); } });
    const first = saver.flush();                                     // local v5 in flight
    scene[0] = el("a", 6, { x: 99 }); saver.adoptRemote([scene[0]!]);   // the other person's v6 arrives meanwhile
    ack.resolve(); await first;                                      // the ack for v5 lands after v6 was adopted
    await saver.flush();
    expect(sent).toHaveLength(1);                                    // v6 stays recorded as stored; the ack did not make v5 the stored copy
    scene[0] = el("a", 7, { x: 1 });
    await saver.flush(); await saver.flush();
    expect(sent.slice(1).map((batch) => batch.map((entry) => entry.version))).toEqual([[7]]);
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
    expect(saver.mayHold("theirs")).toBe(false);
    expect(saver.mayHold("mine")).toBe(true);
  });

  it("knows the server holds an id it only heard of (a remote revision the local copy beat), without holding a revision of it", () => {
    const saver = createWhiteboardSaver({ getElements: () => [], send: async () => undefined });
    expect(saver.mayHold("beaten")).toBe(false);
    saver.serverHas(["beaten"]);
    expect(saver.mayHold("beaten")).toBe(true);
  });

  it("sends a local delete of a remote element, as the scene authored it", async () => {
    const scene = [el("theirs", 4)]; const sent: SavedElement[][] = [];
    const saver = createWhiteboardSaver({ getElements: () => scene, send: async (batch) => { sent.push([...batch]); } });
    saver.adoptRemote([el("theirs", 4)]);
    scene[0] = el("theirs", 5, { isDeleted: true });
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
