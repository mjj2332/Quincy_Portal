import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "./api";
import { createNoteFormStore, effectiveMarks, FRAME_CONFIRM_TIMEOUT_MS, frameOnScreen, type NoteClock, type NoteFormStore } from "./video-note-form-store";
import { EMPTY_MARKS } from "./video-note-marks";

const V2 = "77777777-7777-4777-8777-777777777777";
const V1 = "66666666-6666-4666-8666-666666666666";

let n = 0;
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
const note = (over: Record<string, unknown> = {}): VideoNoteThreadDto => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, assetId: V2, parentId: null, author: { kind: "staff", person }, authorRole: "editor", copiedFrom: null, visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "A note", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;

/** The part of the frame clock the store uses: the test decides when the frame is confirmed. */
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

let store: NoteFormStore;
beforeEach(() => { store = createNoteFormStore("user:project"); });
afterEach(() => { vi.useRealTimers(); });

/** Types `text` and starts a post on `assetId`; returns the fake clock and the gate the send is held on. */
async function startPost(assetId: string, text: string, at = 12) {
  const fc = fakeClock(at);
  store.setBody(assetId, text, at);
  const sent = gate<unknown>();
  const send = vi.fn(() => sent.promise);
  const done = store.post(assetId, { clock: fc.clock, frameCount: 300, send });
  return { fc, sent, send, done };
}

describe("composer draft (#741 5b form store)", () => {
  it("freezes the anchor at the first character; erasing the text resets Client-visible and the anchor", () => {
    store.setBody(V2, "h", 30);
    store.setBody(V2, "he", 50);
    expect(store.slot(V2).composer).toMatchObject({ body: "he", anchorFrame: 30 });
    store.setVisibility(V2, "public");
    store.setBody(V2, "", 60);
    expect(store.slot(V2).composer).toMatchObject({ body: "", anchorFrame: null, visibility: "internal" });
    store.setBody(V2, "x", 70);
    expect(store.slot(V2).composer.anchorFrame).toBe(70);
  });

  it("the frame on screen is the presented one while playing and the one a seek is bringing when paused", () => {
    expect(frameOnScreen({ playing: true, frame: 5, targetFrame: 9 } as never)).toBe(5);
    expect(frameOnScreen({ playing: false, frame: 5, targetFrame: 9 } as never)).toBe(9);
    expect(frameOnScreen({ playing: false, frame: 5, targetFrame: null } as never)).toBe(5);
  });

  it("every edit of the draft advances its revision; a slot nobody wrote to is the same frozen empty object", () => {
    expect(store.slot(V2)).toBe(store.slot(V1));
    const first = store.slot(V2).composer.revision;
    store.setBody(V2, "a", 1);
    store.setVisibility(V2, "public");
    expect(store.slot(V2).composer.revision).toBeGreaterThan(first + 1);
  });
});

describe("one open form per Version (#741 5b form store)", () => {
  it("opening an edit, then a reply, leaves one open form; close empties it", () => {
    const a = note(); const b = note();
    expect(store.openEdit(V2, a, a.id)).toBe(true);
    expect(store.slot(V2).open).toMatchObject({ kind: "edit", noteId: a.id, text: "A note" });
    expect(store.openReply(V2, b.id)).toBe(true);
    expect(store.slot(V2).open).toMatchObject({ kind: "reply", rootId: b.id, text: "" });
    store.close(V2);
    expect(store.slot(V2).open).toBeNull();
  });

  it("opening is refused while a request is out in that Version, and allowed in another Version", async () => {
    const { fc, sent } = await startPost(V2, "posting");
    fc.confirm(12); await tick();
    expect(store.slot(V2).op?.phase).toBe("posting");
    const a = note();
    expect(store.openEdit(V2, a, a.id)).toBe(false);
    expect(store.openReply(V2, a.id)).toBe(false);
    expect(store.openEdit(V1, a, a.id)).toBe(true);
    sent.resolve(note()); await tick();
  });

  it("opening a form cancels the composer's frame confirmation: the frame arriving later sends nothing", async () => {
    const { fc, send } = await startPost(V2, "hold");
    expect(store.slot(V2).op?.phase).toBe("confirming");
    store.openReply(V2, note().id);
    expect(store.slot(V2).op).toBeNull();
    fc.confirm(12); await tick();
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer.body).toBe("hold");
  });

  it("the composer cannot post while an edit or reply is open", async () => {
    store.setBody(V2, "text", 1);
    store.openReply(V2, note().id);
    const send = vi.fn();
    await store.post(V2, { clock: fakeClock().clock, frameCount: 300, send });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("marks (#741 5b form store)", () => {
  const clockA = {} as NoteClock; const clockB = {} as NoteClock;
  const marksOf = (clock: NoteClock | null) => effectiveMarks(store.slot(V2).marks, clock);

  it("I and O are captured synchronously on the clock they were made on, and read as empty under another clock", () => {
    store.mark(V2, "in", 10, clockA);
    store.mark(V2, "out", 20, clockA);
    expect(marksOf(clockA).value).toEqual({ in: 10, out: 20 });
    expect(marksOf(clockB).value).toEqual(EMPTY_MARKS);
    expect(marksOf(null).value).toEqual(EMPTY_MARKS);
  });

  it("a mark that crosses the other clears it; Make point collapses a range to its first mark; Clear empties", () => {
    store.mark(V2, "in", 10, clockA);
    store.mark(V2, "out", 5, clockA);
    expect(marksOf(clockA).value).toEqual({ in: null, out: 5 });
    store.mark(V2, "in", 3, clockA); store.mark(V2, "out", 9, clockA);
    store.makePoint(V2, clockA);
    expect(marksOf(clockA).value).toEqual({ in: 3, out: null });
    store.clearMarks(V2);
    expect(marksOf(clockA).value).toEqual(EMPTY_MARKS);
  });

  it("an edit form shows the note's stored frames until a frame action is taken on the clock in front of it", () => {
    const a = note({ startFrame: 10, endFrame: 21 });
    store.openEdit(V2, a, a.id);
    expect(marksOf(clockA)).toMatchObject({ value: { in: 10, out: 20 }, touched: false });
    store.mark(V2, "in", 12, clockA);
    expect(marksOf(clockA)).toMatchObject({ value: { in: 12, out: 20 }, touched: true });
    // The Version was left and came back: a new clock, so the baseline shows again and no frame action has been taken.
    expect(marksOf(clockB)).toMatchObject({ value: { in: 10, out: 20 }, touched: false });
  });

  it("a reply and an edit of a note with markup or of a reply take no marks", () => {
    const root = note();
    store.openReply(V2, root.id);
    store.mark(V2, "in", 4, clockA);
    expect(marksOf(clockA).value).toEqual(EMPTY_MARKS);
    const marked = note({ hasMarkup: true });
    store.openEdit(V2, marked, marked.id);
    store.mark(V2, "in", 4, clockA);
    expect(marksOf(clockA).value).toEqual(EMPTY_MARKS);
    const reply = note({ parentId: root.id, startFrame: null });
    store.openEdit(V2, reply, root.id);
    store.mark(V2, "in", 4, clockA);
    expect(marksOf(clockA).value).toEqual(EMPTY_MARKS);
  });

  it("marks are not written while a request is out", async () => {
    const fc = fakeClock(4);
    store.setBody(V2, "x", 4);
    store.mark(V2, "in", 4, fc.clock);
    const sent = gate<unknown>();
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send: () => sent.promise });
    store.mark(V2, "out", 9, fc.clock); // confirming
    expect(effectiveMarks(store.slot(V2).marks, fc.clock).value).toEqual({ in: 4, out: null });
    fc.confirm(4); await tick();
    store.mark(V2, "out", 9, fc.clock); // posting
    expect(effectiveMarks(store.slot(V2).marks, fc.clock).value).toEqual({ in: 4, out: null });
    sent.resolve(note()); await done;
  });
});

describe("post (#741 5b form store)", () => {
  it("seeks to the frozen anchor, waits for it, sends the exact payload, and a success clears the draft and marks", async () => {
    const { fc, sent, send, done } = await startPost(V2, "  hello  ", 12);
    expect(fc.raw.seekToFrame).toHaveBeenCalledWith(12);
    expect(store.slot(V2).op).toMatchObject({ form: "composer", phase: "confirming" });
    fc.confirm(12); await tick();
    expect(send).toHaveBeenCalledWith({ startFrame: 12, visibility: "internal", body: "hello" });
    expect(store.slot(V2).op?.phase).toBe("posting");
    sent.resolve(note()); await done;
    expect(store.slot(V2).composer).toMatchObject({ body: "", anchorFrame: null, visibility: "internal", problem: null });
    expect(store.slot(V2).op).toBeNull();
  });

  it("a marked post on the clock that holds the marks seeks to the range start and posts [in, out + 1)", async () => {
    const fc = fakeClock(40);
    store.setBody(V2, "range", 40);
    store.mark(V2, "in", 5, fc.clock); store.mark(V2, "out", 9, fc.clock);
    const sent = gate<unknown>();
    const send = vi.fn(() => sent.promise);
    const done = store.post(V2, { clock: fc.clock, frameCount: 300, send });
    expect(fc.raw.seekToFrame).toHaveBeenCalledWith(5);
    fc.confirm(5); await tick();
    expect(send).toHaveBeenCalledWith({ startFrame: 5, endFrame: 10, visibility: "internal", body: "range" });
    sent.resolve(note()); await done;
    expect(effectiveMarks(store.slot(V2).marks, fc.clock).value).toEqual(EMPTY_MARKS);
  });

  it("a frame other than the anchor lands: 'Frame moved', nothing sent, the draft kept", async () => {
    const { fc, send, done } = await startPost(V2, "keep", 12);
    fc.confirm(13); await done;
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer).toMatchObject({ body: "keep", problem: { text: "Frame moved — Post again" } });
    expect(store.slot(V2).op).toBeNull();
  });

  it("a confirmation that never lands in 10 seconds keeps the draft and offers Retry", async () => {
    vi.useFakeTimers();
    const { send, done } = await startPost(V2, "slow");
    await vi.advanceTimersByTimeAsync(FRAME_CONFIRM_TIMEOUT_MS);
    await done;
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer.problem).toMatchObject({ retry: true });
    expect(store.slot(V2).composer.body).toBe("slow");
    expect(store.slot(V2).op).toBeNull();
  });

  it("cancelling the confirmation (Escape, dismissal) invalidates the operation: the frame landing later sends nothing", async () => {
    const { fc, send } = await startPost(V2, "cancel me");
    store.cancelConfirmation(V2);
    expect(store.slot(V2).op).toBeNull();
    fc.confirm(12); await tick();
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).composer).toMatchObject({ body: "cancel me", problem: null });
  });

  it("a clock disposed mid-confirmation (Version change, close) goes back to idle with the text and no problem", async () => {
    const { fc, send, done } = await startPost(V2, "away");
    fc.abort(); await done;
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2)).toMatchObject({ op: null, composer: { body: "away", problem: null } });
  });

  it("a principal ending (cancelAll) or a store being replaced (retire) sends nothing, but never touches a request already sent", async () => {
    const first = await startPost(V2, "one");
    store.cancelAll();
    first.fc.confirm(12); await tick();
    expect(first.send).not.toHaveBeenCalled();

    const second = await startPost(V1, "two");
    second.fc.confirm(12); await tick();
    expect(second.send).toHaveBeenCalledTimes(1);
    store.cancelAll();
    expect(store.slot(V1).op?.phase).toBe("posting");

    const third = await startPost(V2, "three");
    store.retire();
    third.fc.confirm(12); await tick();
    expect(third.send).not.toHaveBeenCalled();
    second.sent.resolve(note()); await tick();
  });

  it("a network failure keeps the draft, never retries, and says it may or may not have posted", async () => {
    const { fc, sent, send, done } = await startPost(V2, "offline");
    fc.confirm(12); await tick();
    sent.reject(new ApiError("offline", 0)); await done;
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.slot(V2).composer.body).toBe("offline");
    expect(store.slot(V2).composer.problem).toMatchObject({ refresh: true, text: expect.stringContaining("may or may not have posted") });
    expect(store.slot(V2).op).toBeNull();
  });
});

describe("a completion addresses its originating slot and operation (#741 5b form store)", () => {
  it("a success with nobody subscribed clears that Version's draft only", async () => {
    store.setBody(V1, "v1 draft", 3);
    const { fc, sent, done } = await startPost(V2, "v2 post");
    fc.confirm(12); await tick();
    sent.resolve(note()); await done;
    expect(store.slot(V2).composer.body).toBe("");
    expect(store.slot(V1).composer.body).toBe("v1 draft");
  });

  it("a success clears the draft it was sent from but never a newer one (compared by revision, not by text)", async () => {
    const { fc, sent, done } = await startPost(V2, "First");
    fc.confirm(12); await tick();
    store.setBody(V2, "First and more", 12);
    sent.resolve(note()); await done;
    expect(store.slot(V2).composer.body).toBe("First and more");
    expect(store.slot(V2).op).toBeNull();
  });

  it("an edited-back draft with identical text is still a newer draft", async () => {
    const { fc, sent, done } = await startPost(V2, "Same");
    fc.confirm(12); await tick();
    store.setBody(V2, "Same!", 12);
    store.setBody(V2, "Same", 12);
    sent.resolve(note()); await done;
    expect(store.slot(V2).composer.body).toBe("Same");
  });

  it("a Version-1 completion while a Version-2 edit is open leaves the Version-2 form untouched", async () => {
    const { fc, sent, done } = await startPost(V1, "on v1");
    fc.confirm(12); await tick();
    const mine = note();
    store.openEdit(V2, mine, mine.id);
    store.setOpenText(V2, "typing on v2");
    const before = store.slot(V2);
    sent.resolve(note()); await done;
    expect(store.slot(V2)).toBe(before);
    expect(store.slot(V1).composer.body).toBe("");
  });

  it("a failure is written to its own Version's composer", async () => {
    const { fc, sent, done } = await startPost(V1, "refused");
    fc.confirm(12); await tick();
    const before = store.slot(V2);
    sent.reject(new ApiError("Nope", 500)); await done;
    expect(store.slot(V1).composer).toMatchObject({ body: "refused", problem: { text: "Nope" } });
    expect(store.slot(V2)).toBe(before);
  });
});

describe("edit save and reply (#741 5b form store)", () => {
  const frames = { clock: {} as NoteClock, frameCount: 300 };

  it("an unchanged edit closes without a request", async () => {
    const a = note();
    store.openEdit(V2, a, a.id);
    const send = vi.fn();
    await store.save(V2, { ...frames, send });
    expect(send).not.toHaveBeenCalled();
    expect(store.slot(V2).open).toBeNull();
  });

  it("sends the revision the form was opened with and only the changed body; success closes it", async () => {
    const a = note({ revision: 4 });
    store.openEdit(V2, a, a.id);
    store.setOpenText(V2, "  new  ");
    const sent = gate<unknown>();
    const send = vi.fn(() => sent.promise);
    const done = store.save(V2, { ...frames, send });
    expect(send).toHaveBeenCalledWith(a.id, { expectedRevision: 4, body: "new" });
    expect(store.slot(V2).op).toMatchObject({ form: "open", phase: "posting" });
    sent.resolve(a); await done;
    expect(store.slot(V2).open).toBeNull();
    expect(store.slot(V2).op).toBeNull();
  });

  it("a 409 keeps the text and stores the server's note; Save anyway sends exactly that revision", async () => {
    const a = note({ revision: 1, body: "old" });
    store.openEdit(V2, a, a.id);
    store.setOpenText(V2, "mine");
    const fresh = { ...a, body: "theirs", revision: 2 } as VideoNoteThreadDto;
    const refused = vi.fn(async () => { throw new ApiError("changed", 409, { code: "note_conflict", thread: fresh }); });
    await store.save(V2, { ...frames, send: refused });
    expect(store.slot(V2).open).toMatchObject({ text: "mine", conflict: { revision: 2, body: "theirs" } });
    expect(store.slot(V2).open?.problem?.text).toContain("changed since you opened it");
    const ok = vi.fn(async () => a);
    await store.save(V2, { ...frames, send: ok });
    expect(ok).toHaveBeenCalledWith(a.id, { expectedRevision: 2, body: "mine" });
    expect(store.slot(V2).open).toBeNull();
  });

  it("a note deleted elsewhere closes the form and leaves a notice for its thread", async () => {
    const a = note();
    store.openEdit(V2, a, a.id);
    store.setOpenText(V2, "late");
    await store.save(V2, { ...frames, send: async () => { throw new ApiError("This note was deleted.", 409, { code: "note_deleted" }); } });
    expect(store.slot(V2).open).toBeNull();
    expect(store.slot(V2).notice).toMatchObject({ rootId: a.id, text: "This note was deleted." });
  });

  it("frames are sent only after an explicit frame action since the form opened", async () => {
    const clock = {} as NoteClock;
    const a = note({ startFrame: 10, endFrame: 21 });
    store.openEdit(V2, a, a.id);
    store.setOpenText(V2, "text only");
    const first = vi.fn(async () => a);
    await store.save(V2, { clock, frameCount: 300, send: first });
    expect(first).toHaveBeenCalledWith(a.id, { expectedRevision: 1, body: "text only" });

    store.openEdit(V2, a, a.id);
    store.mark(V2, "in", 12, clock);
    const second = vi.fn(async () => a);
    await store.save(V2, { clock, frameCount: 300, send: second });
    expect(second).toHaveBeenCalledWith(a.id, { expectedRevision: 1, startFrame: 12, endFrame: 21 });
  });

  it("a reply posts the trimmed body to its root, closes on success, and keeps text and problem on failure", async () => {
    const root = note();
    store.openReply(V2, root.id);
    store.setOpenText(V2, " answer ");
    const refused = vi.fn(async () => { throw new ApiError("Nope", 500); });
    await store.reply(V2, { send: refused });
    expect(refused).toHaveBeenCalledWith(root.id, "answer");
    expect(store.slot(V2).open).toMatchObject({ kind: "reply", text: " answer ", problem: { text: "Nope" } });
    const ok = vi.fn(async () => root);
    await store.reply(V2, { send: ok });
    expect(store.slot(V2).open).toBeNull();
  });
});

describe("Escape (#741 5b form store)", () => {
  it("a frame confirmation is cancelled first and the composer's text field is focused", async () => {
    await startPost(V2, "wait");
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
    expect(store.slot(V2).op).toBeNull();
  });

  it("a clean edit or reply is closed and focus goes back to its opener", () => {
    store.openReply(V2, note().id);
    expect(store.escape(V2, { focusInForm: true })).toEqual({ consumed: true, focus: "opener" });
    expect(store.slot(V2).open).toBeNull();
  });

  it("a dirty form holds the first Escape wherever focus is, and focus returns to its text field; the next one is not held", () => {
    store.openReply(V2, note().id);
    store.setOpenText(V2, "half");
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: false, focus: null });
    store.setOpenText(V2, "half a");
    expect(store.escape(V2, { focusInForm: true })).toEqual({ consumed: true, focus: "textarea" });
  });

  it("a dirty composer holds the first Escape too, wherever focus is; typing or a mark re-arms it", () => {
    store.setBody(V2, "draft", 1);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(false);
    store.mark(V2, "in", 3, {} as NoteClock);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(true);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(false);
    store.rearm(V2);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(true);
  });

  it("Sol r4: cancelling a confirmation spends the first Escape, so the next one is not held", async () => {
    store.setBody(V2, "draft", 1);
    await startPost(V2, "wait");
    expect(store.escape(V2, { focusInForm: true })).toEqual({ consumed: true, focus: "textarea" });
    expect(store.escape(V2, { focusInForm: true }).consumed).toBe(false);
  });

  it("Sol r4: the first Escape of a dirty form returns focus to the text field even when focus is already inside the form", () => {
    store.setBody(V2, "draft", 1);
    expect(store.escape(V2, { focusInForm: true })).toEqual({ consumed: true, focus: "textarea" });
  });

  it("Sol r4: Clear marks re-arms Escape", () => {
    store.setBody(V2, "draft", 1);
    store.mark(V2, "in", 3, {} as NoteClock);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(true);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(false);
    store.clearMarks(V2);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(true);
  });

  it("a clean composer holds Escape only while focus is in it", () => {
    expect(store.escape(V2, { focusInForm: true })).toEqual({ consumed: true, focus: "dialog" });
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: false, focus: null });
  });

  it("an edit whose frames were changed is dirty even with its text untouched", () => {
    const a = note({ startFrame: 10, endFrame: 21 });
    store.openEdit(V2, a, a.id);
    store.mark(V2, "in", 11, {} as NoteClock);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "textarea" });
    expect(store.slot(V2).open).not.toBeNull();
  });
});

describe("retireMissing (#741 5b form store)", () => {
  it("closes a form whose note left the full list, but not while its request is out", async () => {
    const root = note(); const reply = note({ parentId: root.id, startFrame: null });
    const withReply = { ...root, replies: [reply] } as unknown as VideoNoteThreadDto;
    store.openEdit(V2, reply, root.id);
    store.retireMissing(V2, [withReply]);
    expect(store.slot(V2).open).not.toBeNull();
    store.retireMissing(V2, [root]);
    expect(store.slot(V2).open).toBeNull();

    store.openEdit(V2, root, root.id);
    store.setOpenText(V2, "saving");
    const sent = gate<unknown>();
    const done = store.save(V2, { clock: {} as NoteClock, frameCount: 300, send: () => sent.promise });
    store.retireMissing(V2, []);
    expect(store.slot(V2).open).not.toBeNull();
    sent.resolve(root); await done;
  });
});

describe("Sol r5", () => {
  it("a root that becomes a tombstone closes its edit and reply forms with a deletion notice; an edit of a surviving reply stays open", () => {
    const root = note(); const reply = note({ parentId: root.id, startFrame: null });
    const tomb = { ...root, deleted: true, replies: [reply] } as unknown as VideoNoteThreadDto;
    store.openEdit(V2, root, root.id);
    store.retireMissing(V2, [tomb]);
    expect(store.slot(V2).open).toBeNull();
    expect(store.slot(V2).notice).toMatchObject({ text: "This note was deleted.", rootId: root.id });
    store.openReply(V2, root.id);
    store.retireMissing(V2, [tomb]);
    expect(store.slot(V2).open).toBeNull();
    store.openEdit(V2, reply, root.id);
    store.retireMissing(V2, [tomb]);
    expect(store.slot(V2).open).not.toBeNull();
  });

  it("an edit whose frames were changed on a clock that has since been replaced is clean again (observeClock), so Escape closes it", () => {
    const root = note();
    const first = {} as NoteClock; const second = {} as NoteClock;
    store.observeClock(V2, first);
    store.openEdit(V2, root, root.id);
    store.mark(V2, "in", 3, first);
    expect(store.escape(V2, { focusInForm: false }).consumed).toBe(true); // dirty: held
    store.observeClock(V2, first);
    expect(store.slot(V2).marks.touched).toBe(true);
    store.observeClock(V2, second); // the Version was left and came back with a new clock
    expect(store.slot(V2).marks.touched).toBe(false);
    expect(store.escape(V2, { focusInForm: false })).toEqual({ consumed: true, focus: "opener" });
    expect(store.slot(V2).open).toBeNull();
  });
});

describe("subscription (#741 5b form store)", () => {
  it("tells subscribers about a change, and stops after unsubscribe; retire silences everyone", () => {
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setBody(V2, "a", 1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.setBody(V2, "ab", 1);
    expect(listener).toHaveBeenCalledTimes(1);
    const other = vi.fn();
    store.subscribe(other);
    store.retire();
    store.setBody(V2, "abc", 1);
    expect(other).not.toHaveBeenCalled();
  });
});
