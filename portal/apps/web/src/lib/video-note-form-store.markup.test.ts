import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_MARKUP_MAX_BYTES, type MarkupItem, type VideoNoteThreadDto } from "@quincy/shared";
import { createNoteFormStore, FRAME_CONFIRM_TIMEOUT_MS, type NoteClock, type NoteFormStore } from "./video-note-form-store";

const V2 = "77777777-7777-4777-8777-777777777777";
const V1 = "66666666-6666-4666-8666-666666666666";

let n = 0;
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
const note = (over: Record<string, unknown> = {}): VideoNoteThreadDto => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, assetId: V2, parentId: null, author: { kind: "staff", person }, authorRole: "editor", copiedFrom: null, visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "A note", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;

function fakeClock(frame = 12) {
  let state = { frame, targetFrame: null as number | null, playing: false };
  const waiters: Array<{ resolve: (frame: number) => void; reject: (reason: unknown) => void }> = [];
  const clock = {
    getState: () => state,
    seekToFrame: vi.fn((target: number) => { state = { ...state, targetFrame: target }; }),
    awaitConfirmedFrame: vi.fn(() => new Promise<number>((resolve, reject) => { waiters.push({ resolve, reject }); })),
  };
  return {
    clock: clock as unknown as NoteClock, raw: clock,
    confirm(at: number) { state = { ...state, frame: at, targetFrame: null }; waiters.splice(0).forEach((w) => { w.resolve(at); }); },
    abort() { waiters.splice(0).forEach((w) => { w.reject(new DOMException("disposed", "AbortError")); }); },
  };
}
const gate = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

const stroke = (x = 0.1): MarkupItem => ({ color: "#e64b3c", width: 4, points: [{ x, y: 0.2 }, { x: x + 0.1, y: 0.3 }] });
const arrow = (): MarkupItem => ({ type: "arrow", color: "#2f6df0", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] });

let store: NoteFormStore;
beforeEach(() => { store = createNoteFormStore("user:project"); });
afterEach(() => { vi.useRealTimers(); });

/** Enters draw mode on `form` and lands the frame; resolves once the phase is "drawing". */
async function drawing(form: "composer" | "edit" = "composer", at = 12, frameCount = 300) {
  const fc = fakeClock(at);
  const entered = store.enterDraw(V2, { clock: fc.clock, form, frameCount });
  const frame = store.slot(V2).draw?.frame ?? at;
  fc.confirm(frame);
  await entered;
  return fc;
}

describe("enterDraw (#741 6b-ui form store)", () => {
  it("pauses on the frame on screen, waits for exactly that frame, then opens the drawing phase with the frame frozen", async () => {
    const fc = fakeClock(12);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    expect(fc.raw.seekToFrame).toHaveBeenCalledWith(12);
    expect(store.slot(V2).draw).toMatchObject({ form: "composer", phase: "confirming", frame: 12 });
    fc.confirm(12);
    await entered;
    expect(store.slot(V2).draw).toMatchObject({ form: "composer", phase: "drawing", frame: 12 });
  });

  it("a frame other than the one asked for lands: no drawing phase, and the composer says why", async () => {
    const fc = fakeClock(12);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    fc.confirm(13);
    await entered;
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).composer.problem?.text).toMatch(/frame moved/i);
  });

  it("cancelling the confirmation (Escape, dismissal) leaves no drawing phase and no problem; the frame landing later does nothing", async () => {
    const fc = fakeClock(12);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    store.cancelConfirmation(V2);
    expect(store.slot(V2).draw).toBeNull();
    fc.confirm(12);
    await entered;
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).composer.problem).toBeNull();
  });

  it("a frame that never lands in 10 seconds gives the composer a retry problem and no drawing phase", async () => {
    vi.useFakeTimers();
    const fc = fakeClock(12);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    await vi.advanceTimersByTimeAsync(FRAME_CONFIRM_TIMEOUT_MS);
    await entered;
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).composer.problem).toMatchObject({ retry: true });
  });

  it("a clock disposed mid-confirmation (Version change, close) goes back to idle with no problem", async () => {
    const fc = fakeClock(12);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    fc.abort();
    await entered;
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).composer.problem).toBeNull();
  });

  it("with In/Out marks it enters on the frame on screen when that is inside them, else on the range start", async () => {
    const inside = fakeClock(20);
    store.mark(V2, "in", 15, inside.clock); store.mark(V2, "out", 30, inside.clock);
    const a = store.enterDraw(V2, { clock: inside.clock, form: "composer", frameCount: 300 });
    expect(store.slot(V2).draw?.frame).toBe(20);
    inside.confirm(20); await a;
    store.exitDraw(V2);
    // The playhead moved outside the range: the drawing goes to the start of it.
    inside.confirm(100);
    const b = store.enterDraw(V2, { clock: inside.clock, form: "composer", frameCount: 300 });
    expect(store.slot(V2).draw?.frame).toBe(15);
    expect(inside.raw.seekToFrame).toHaveBeenLastCalledWith(15);
    inside.confirm(15); await b;
  });

  it("re-entering after strokes were drawn seeks back to the frozen drawing frame, not the frame on screen", async () => {
    const first = await drawing("composer", 12);
    store.setItems(V2, "composer", [stroke()]);
    expect(store.slot(V2).markup.drawingFrame).toBe(12);
    store.exitDraw(V2);
    const later = fakeClock(200);
    const entered = store.enterDraw(V2, { clock: later.clock, form: "composer", frameCount: 300 });
    expect(later.raw.seekToFrame).toHaveBeenCalledWith(12);
    later.confirm(12);
    await entered;
    expect(store.slot(V2).draw).toMatchObject({ phase: "drawing", frame: 12 });
    void first;
  });

  it("draw mode belongs to its own Version's slot", async () => {
    await drawing("composer", 12);
    const other = fakeClock(5);
    const entered = store.enterDraw(V1, { clock: other.clock, form: "composer", frameCount: 300 });
    other.confirm(5);
    await entered;
    expect(store.slot(V1).draw).toMatchObject({ phase: "drawing", frame: 5 });
    expect(store.slot(V2).draw).toMatchObject({ phase: "drawing", frame: 12 });
  });
});

describe("the draft strokes (#741 6b-ui form store)", () => {
  it("every committed list advances the markup revision and is kept as the very array it was given, so the hook's history stays valid", async () => {
    await drawing();
    const before = store.slot(V2).markup.revision;
    const list = [stroke()];
    store.setItems(V2, "composer", list);
    expect(store.slot(V2).markup.items).toBe(list);
    expect(store.slot(V2).markup.revision).toBe(before + 1);
    store.setItems(V2, "composer", (current) => [...current, arrow()]);
    expect(store.slot(V2).markup.items).toHaveLength(2);
    expect(store.slot(V2).markup.revision).toBe(before + 2);
  });

  it("the first stroke freezes the drawing frame; clearing every stroke releases it", async () => {
    await drawing("composer", 40);
    expect(store.slot(V2).markup.drawingFrame).toBeNull();
    store.setItems(V2, "composer", [stroke()]);
    expect(store.slot(V2).markup.drawingFrame).toBe(40);
    store.setItems(V2, "composer", []);
    expect(store.slot(V2).markup.drawingFrame).toBeNull();
  });

  it("leaving draw mode keeps the strokes; switching Version keeps them and ends the draw phase", async () => {
    await drawing();
    store.setItems(V2, "composer", [stroke()]);
    store.exitDraw(V2);
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).markup.items).toHaveLength(1);
    await drawing();
    store.leave(V2);
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).markup.items).toHaveLength(1);
    expect(store.slot(V1).markup.items).toHaveLength(0);
  });

  it("a stroke makes the composer dirty (Escape holds it) and the pen survives a Version switch", async () => {
    await drawing();
    store.setItems(V2, "composer", [stroke()]);
    store.exitDraw(V2);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
    store.setTool(V2, { color: "#2f6df0", width: 7 });
    store.leave(V2);
    expect(store.slot(V2).tool).toMatchObject({ kind: "freehand", color: "#2f6df0", width: 7 });
  });

  it("In and Out marks are refused while drawing (the frame must not move under the pen)", async () => {
    const fc = await drawing();
    store.mark(V2, "in", 50, fc.clock);
    expect(store.slot(V2).marks.touched).toBe(false);
    store.exitDraw(V2);
    store.mark(V2, "in", 50, fc.clock);
    expect(store.slot(V2).marks.touched).toBe(true);
  });
});

describe("Escape order with a drawing (#741 6b-ui form store)", () => {
  it("the first Escape cancels a draw confirmation, the next leaves nothing to cancel", async () => {
    const fc = fakeClock(12);
    void store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "draw" });
    expect(store.slot(V2).draw).toBeNull();
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: false, focus: null });
  });

  it("the first Escape leaves draw mode and KEEPS the strokes; the next is the dirty-form hold; the third is the viewer's", async () => {
    await drawing();
    store.setItems(V2, "composer", [stroke()]);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "draw" });
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).markup.items).toHaveLength(1);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: false, focus: null });
  });
});

describe("post with a drawing (#741 6b-ui form store)", () => {
  async function drawn(at = 12) {
    store.setBody(V2, "Look here", at);
    const fc = await drawing("composer", at);
    store.setItems(V2, "composer", [stroke(), arrow()]);
    store.exitDraw(V2);
    return fc;
  }

  it("confirms the drawing frame again (story 31), then sends the strokes with that frame, as a point at it", async () => {
    const fc = await drawn(12);
    const sent = gate<unknown>();
    const send = vi.fn(() => sent.promise);
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send });
    expect(fc.raw.seekToFrame).toHaveBeenLastCalledWith(12);
    expect(send).not.toHaveBeenCalled();
    fc.confirm(12);
    await tick();
    expect(send).toHaveBeenCalledWith({ startFrame: 12, visibility: "internal", body: "Look here", markup: store.slot(V2).markup.items, drawingFrame: 12 });
    sent.resolve({}); await done;
    expect(store.slot(V2).markup.items).toHaveLength(0);
    expect(store.slot(V2).composer.body).toBe("");
  });

  it("the drawing frame wins over the frame composing began on", async () => {
    store.setBody(V2, "Text first", 5);
    const fc = await drawing("composer", 80);
    store.setItems(V2, "composer", [stroke()]);
    store.exitDraw(V2);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send });
    fc.confirm(80);
    await done;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ startFrame: 80, drawingFrame: 80 }));
  });

  it("with an In/Out range the drawing must be inside it; one that is not sends nothing and says so", async () => {
    const fc = await drawn(12);
    store.mark(V2, "in", 20, fc.clock); store.mark(V2, "out", 40, fc.clock);
    const send = vi.fn(() => Promise.resolve({}));
    await store.post(V2, { clock: fc.clock, frameCount: 300, send });
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer.problem?.text).toMatch(/outside/i);
    expect(store.slot(V2).markup.items).toHaveLength(2);
  });

  it("with a range that includes the drawing, the range is sent with the drawing frame", async () => {
    const fc = await drawn(25);
    store.mark(V2, "in", 20, fc.clock); store.mark(V2, "out", 40, fc.clock);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send });
    expect(fc.raw.seekToFrame).toHaveBeenLastCalledWith(25);
    fc.confirm(25);
    await done;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ startFrame: 20, endFrame: 41, drawingFrame: 25 }));
  });

  it("a frame that moved before the post lands sends nothing and keeps the strokes", async () => {
    const fc = await drawn(12);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send });
    fc.confirm(13);
    await done;
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer.problem?.text).toMatch(/frame moved/i);
    expect(store.slot(V2).markup.items).toHaveLength(2);
  });

  it("a drawing over the byte cap is refused before anything is sent", async () => {
    store.setBody(V2, "Too much", 12);
    const fc = await drawing("composer", 12);
    const heavy: MarkupItem = { color: "#e64b3c", width: 4, points: Array.from({ length: 20_000 }, (_, i) => ({ x: i / 20_000, y: 0.123456 })) };
    store.setItems(V2, "composer", [heavy, heavy, heavy, heavy]);
    store.exitDraw(V2);
    const send = vi.fn(() => Promise.resolve({}));
    await store.post(V2, { clock: fc.clock, frameCount: 300, send });
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer.problem?.text).toMatch(/too large/i);
    expect(VIDEO_MARKUP_MAX_BYTES).toBe(524_288);
  });

  it("a success after more drawing keeps the newer strokes (the draft is compared by revision, not by content)", async () => {
    const fc = await drawn(12);
    const sent = gate<unknown>();
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send: () => sent.promise });
    fc.confirm(12);
    await tick();
    const newer = [stroke(0.6)];
    store.setItems(V2, "composer", newer);
    sent.resolve({}); await done;
    expect(store.slot(V2).markup.items).toBe(newer);
    expect(store.slot(V2).composer.body).toBe("");
  });

  it("a failure keeps the strokes", async () => {
    const fc = await drawn(12);
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send: () => Promise.reject(new Error("boom")) });
    fc.confirm(12);
    await done;
    expect(store.slot(V2).markup.items).toHaveLength(2);
    expect(store.slot(V2).composer.problem?.text).toBe("boom");
  });

  it("with the markup part off the note posts without its drawing, and the draft is cleared", async () => {
    const fc = await drawn(12);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send, markup: false });
    fc.confirm(12);
    await done;
    expect(send).toHaveBeenCalledWith({ startFrame: 12, visibility: "internal", body: "Look here" });
    expect(store.slot(V2).markup.items).toHaveLength(0);
  });

  it("posting while still in draw mode ends the draw phase and posts", async () => {
    store.setBody(V2, "Still drawing", 12);
    const fc = await drawing("composer", 12);
    store.setItems(V2, "composer", [stroke()]);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send });
    expect(store.slot(V2).draw).toBeNull();
    fc.confirm(12);
    await done;
    expect(send).toHaveBeenCalled();
  });
});

describe("editing a drawing (#741 6b-ui form store)", () => {
  const withDrawing = () => note({ startFrame: 10, endFrame: 60, drawingFrame: 30, hasMarkup: true, revision: 4 });

  it("opening an edit of a note with a drawing shows no frame controls and sends no markup unless it was touched", async () => {
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    store.setOpenText(V2, "New words");
    const send = vi.fn(() => Promise.resolve({}));
    await store.save(V2, { clock: null, frameCount: 300, send });
    expect(send).toHaveBeenCalledWith(target.id, { expectedRevision: 4, body: "New words" });
  });

  it("a drawing that was never loaded cannot be entered (the editor is never seeded with an empty list)", async () => {
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    const fc = fakeClock(30);
    await store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 300 });
    expect(store.slot(V2).draw).toBeNull();
    expect(store.slot(V2).open?.problem?.text).toMatch(/loaded/i);
  });

  it("loading the saved drawing then entering seeks to its frame; replacing it saves markup and the drawing frame after confirming that frame, never frames", async () => {
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    const saved = [stroke()];
    store.loadDrawing(V2, target.id, saved, 30);
    const fc = fakeClock(200);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 300 });
    expect(fc.raw.seekToFrame).toHaveBeenCalledWith(30);
    fc.confirm(30); await entered;
    expect(store.slot(V2).open?.drawing.touched).toBe(false);
    const next = [...saved, arrow()];
    store.setItems(V2, "edit", next);
    expect(store.slot(V2).open?.drawing).toMatchObject({ touched: true, items: next });
    store.exitDraw(V2);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.save(V2, { clock: fc.clock, frameCount: 300, send });
    expect(fc.raw.seekToFrame).toHaveBeenLastCalledWith(30);
    expect(send).not.toHaveBeenCalled();
    fc.confirm(30);
    await done;
    expect(send).toHaveBeenCalledWith(target.id, { expectedRevision: 4, markup: next, drawingFrame: 30 });
    expect(store.slot(V2).open).toBeNull();
  });

  it("adding a drawing to a plain note: the frame is clamped into the note's frames and the frame controls lock", async () => {
    const target = note({ startFrame: 100, endFrame: 120 });
    store.openEdit(V2, target, target.id);
    const fc = fakeClock(300);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 400 });
    expect(fc.raw.seekToFrame).toHaveBeenCalledWith(119);
    fc.confirm(119); await entered;
    store.setItems(V2, "edit", [stroke()]);
    expect(store.slot(V2).open?.drawing).toMatchObject({ touched: true, drawingFrame: 119 });
    store.exitDraw(V2);
    store.mark(V2, "in", 105, fc.clock);
    expect(store.slot(V2).marks.touched).toBe(false);
  });

  it("a point note's drawing can only be on its frame", async () => {
    const target = note({ startFrame: 100, endFrame: null });
    store.openEdit(V2, target, target.id);
    const fc = fakeClock(250);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 400 });
    expect(fc.raw.seekToFrame).toHaveBeenCalledWith(100);
    fc.confirm(100); await entered;
  });

  it("removing the drawing saves markup: null, with no frame and no confirmation", async () => {
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    store.removeDrawing(V2);
    const send = vi.fn(() => Promise.resolve({}));
    await store.save(V2, { clock: null, frameCount: 300, send });
    expect(send).toHaveBeenCalledWith(target.id, { expectedRevision: 4, markup: null });
  });

  it("clearing every stroke of an edited drawing removes it; clearing a drawing the note never had sends nothing", async () => {
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    store.loadDrawing(V2, target.id, [stroke()], 30);
    store.setItems(V2, "edit", []);
    const send = vi.fn(() => Promise.resolve({}));
    await store.save(V2, { clock: null, frameCount: 300, send });
    expect(send).toHaveBeenCalledWith(target.id, { expectedRevision: 4, markup: null });
    store.close(V2);
    const plain = note({ startFrame: 10 });
    store.openEdit(V2, plain, plain.id);
    store.setItems(V2, "edit", []);
    send.mockClear();
    await store.save(V2, { clock: null, frameCount: 300, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("an edit with a drawing change is dirty: the first Escape is held", () => {
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    store.removeDrawing(V2);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
  });

  it("a drawing refused by the server keeps the draft and says why", async () => {
    const { ApiError } = await import("./api");
    const target = withDrawing();
    store.openEdit(V2, target, target.id);
    store.removeDrawing(V2);
    await store.save(V2, { clock: null, frameCount: 300, send: () => Promise.reject(new ApiError("Too big", 413, { code: "markup_too_large" })) });
    expect(store.slot(V2).open?.problem?.text).toMatch(/too large/i);
    expect(store.slot(V2).open?.drawing.remove).toBe(true);
  });

  it("closing the edit ends its draw phase", async () => {
    const target = note({ startFrame: 100, endFrame: 120 });
    store.openEdit(V2, target, target.id);
    const fc = fakeClock(110);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 400 });
    fc.confirm(110); await entered;
    store.close(V2);
    expect(store.slot(V2).draw).toBeNull();
  });
});

describe("review fixes (#741 6b-ui form store)", () => {
  it("strokes drawn after the old drawing was removed freeze their own confirmed frame, and Save sends it", async () => {
    const target = note({ startFrame: 10, endFrame: 60, drawingFrame: 30, hasMarkup: true, revision: 4 });
    store.openEdit(V2, target, target.id);
    store.loadDrawing(V2, target.id, [stroke()], 30);
    store.removeDrawing(V2);
    const fc = fakeClock(45);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 300 });
    fc.confirm(45); await entered;
    store.setItems(V2, "edit", [arrow()]);
    expect(store.slot(V2).open?.drawing.drawingFrame).toBe(45);
    store.exitDraw(V2);
    const send = vi.fn(() => Promise.resolve({}));
    const done = store.save(V2, { clock: fc.clock, frameCount: 300, send });
    fc.confirm(45); await done;
    expect(send).toHaveBeenCalledWith(target.id, expect.objectContaining({ drawingFrame: 45 }));
  });

  it("strokes drawn after every stroke was cleared also take the new frame", async () => {
    const target = note({ startFrame: 10, endFrame: 60, drawingFrame: 30, hasMarkup: true, revision: 4 });
    store.openEdit(V2, target, target.id);
    store.loadDrawing(V2, target.id, [stroke()], 30);
    store.setItems(V2, "edit", []);
    await (async () => { const fc = fakeClock(45); const e = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 300 }); fc.confirm(45); await e; })();
    store.setItems(V2, "edit", [arrow()]);
    expect(store.slot(V2).open?.drawing.drawingFrame).toBe(45);
  });

  it("Remove drawing on a plain note drops its unsaved additions and releases their frame", async () => {
    const plain = note({ startFrame: 10, endFrame: 60 });
    store.openEdit(V2, plain, plain.id);
    const fc = fakeClock(20);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "edit", frameCount: 300 });
    fc.confirm(20); await entered;
    store.setItems(V2, "edit", [stroke()]);
    store.exitDraw(V2);
    store.removeDrawing(V2);
    expect(store.slot(V2).open?.drawing).toMatchObject({ items: null, drawingFrame: null, touched: false });
    const send = vi.fn(() => Promise.resolve({}));
    await store.save(V2, { clock: null, frameCount: 300, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("Clear marks is refused while drawing", async () => {
    const fc = fakeClock(12);
    store.mark(V2, "in", 5, fc.clock); store.mark(V2, "out", 30, fc.clock);
    const entered = store.enterDraw(V2, { clock: fc.clock, form: "composer", frameCount: 300 });
    fc.confirm(12); await entered;
    expect(store.slot(V2).draw?.phase).toBe("drawing");
    store.clearMarks(V2);
    expect(store.slot(V2).marks.touched).toBe(true);
    store.exitDraw(V2);
    store.clearMarks(V2);
    expect(store.slot(V2).marks.touched).toBe(false);
  });

  describe("saving after the markup part went off", () => {
    const edited = () => {
      const target = note({ startFrame: 10, endFrame: 60, drawingFrame: 30, hasMarkup: true, revision: 4 });
      store.openEdit(V2, target, target.id);
      store.loadDrawing(V2, target.id, [stroke()], 30);
      store.setItems(V2, "edit", [stroke(), arrow()]);
      store.setOpenText(V2, "New words");
      return target;
    };

    it("sends the text only, drops the pending drawing change, and says so", async () => {
      const target = edited();
      const send = vi.fn(() => Promise.resolve({}));
      await store.save(V2, { clock: null, frameCount: 300, send, markup: false });
      expect(send).toHaveBeenCalledWith(target.id, { expectedRevision: 4, body: "New words" });
      expect(store.slot(V2).open).toBeNull();
      expect(store.slot(V2).notice).toMatchObject({ text: "Drawing changes were dropped: drawing is turned off", rootId: target.id });
    });

    it("a failed text save keeps the text, with the drawing change already discarded", async () => {
      edited();
      const send = vi.fn(() => Promise.reject(new Error("offline")));
      await store.save(V2, { clock: null, frameCount: 300, send, markup: false });
      expect(store.slot(V2).open?.text).toBe("New words");
      expect(store.slot(V2).open?.drawing.touched).toBe(false);
    });

    it("with nothing else to save the form closes and still says so", async () => {
      const target = note({ startFrame: 10, endFrame: 60, drawingFrame: 30, hasMarkup: true, revision: 4 });
      store.openEdit(V2, target, target.id);
      store.loadDrawing(V2, target.id, [stroke()], 30);
      store.setItems(V2, "edit", [stroke(), arrow()]);
      const send = vi.fn(() => Promise.resolve({}));
      await store.save(V2, { clock: null, frameCount: 300, send, markup: false });
      expect(send).not.toHaveBeenCalled();
      expect(store.slot(V2).open).toBeNull();
      expect(store.slot(V2).notice?.text).toMatch(/dropped/);
    });
  });

  describe("the note moved on while its drawing was being read", () => {
    const fresh = (over: Record<string, unknown> = {}) => note({ startFrame: 10, endFrame: null, drawingFrame: 40, hasMarkup: true, revision: 5, body: "Remote", ...over });
    const opened = () => { const target = note({ startFrame: 10, endFrame: null, drawingFrame: 30, hasMarkup: true, revision: 4 }); store.openEdit(V2, target, target.id); return target; };

    it("an untouched form adopts the current revision, text and drawing baseline", () => {
      const target = opened();
      expect(store.adoptCurrentNote(V2, fresh({ id: target.id }) as VideoNoteThreadDto)).toBe("adopted");
      expect(store.slot(V2).open).toMatchObject({ text: "Remote", base: { revision: 5, body: "Remote" }, conflict: null, drawing: { hadDrawing: true, baseFrame: 40, touched: false } });
    });

    it("typed text is a change: the conflict choice is shown, the baseline stays, and Save sends nothing until the person chooses", async () => {
      const target = opened();
      store.setOpenText(V2, "Mine");
      expect(store.adoptCurrentNote(V2, fresh({ id: target.id }) as VideoNoteThreadDto)).toBe("conflict");
      expect(store.slot(V2).open).toMatchObject({ text: "Mine", base: { revision: 4 }, conflict: { revision: 5, body: "Remote" } });
      expect(store.slot(V2).open?.problem?.text).toMatch(/changed since you opened/i);
    });

    it("a changed frame is a change too", () => {
      const plain = note({ startFrame: 10, endFrame: 60, revision: 4 });
      store.openEdit(V2, plain, plain.id);
      store.mark(V2, "in", 20, fakeClock(20).clock);
      expect(store.adoptCurrentNote(V2, note({ id: plain.id, startFrame: 10, endFrame: 60, revision: 5, body: "Remote" }))).toBe("conflict");
    });

    it("with a drawing change pending it takes the 5b conflict choice: the server's note is shown and Save anyway sends its revision", async () => {
      const target = opened();
      store.loadDrawing(V2, target.id, [stroke()], 30);
      store.setItems(V2, "edit", [stroke(), arrow()]);
      expect(store.adoptCurrentNote(V2, fresh({ id: target.id }) as VideoNoteThreadDto)).toBe("conflict");
      expect(store.slot(V2).open?.conflict).toMatchObject({ revision: 5, body: "Remote" });
      expect(store.slot(V2).open?.problem?.text).toMatch(/changed since you opened/i);
      expect(store.slot(V2).open?.drawing.touched).toBe(true);
      expect(store.adoptCurrentNote(V2, fresh({ id: target.id }) as VideoNoteThreadDto)).toBeNull(); // asked once
    });
  });
});
