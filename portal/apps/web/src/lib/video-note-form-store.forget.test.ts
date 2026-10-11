import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteFormStore, type NoteClock, type NoteFormStore } from "./video-note-form-store";

const REMOVED = "77777777-7777-4777-8777-777777777777";
const KEPT = "66666666-6666-4666-8666-666666666666";
const gate = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const clockAt = (frame: number): NoteClock => ({ getState: () => ({ frame, targetFrame: null, playing: false }) as never, seekToFrame: vi.fn(), awaitConfirmedFrame: () => Promise.resolve(frame) });

let store: NoteFormStore;
beforeEach(() => { store = createNoteFormStore("user:project"); });

describe("forgetSlot: a removed Version's form slot is retired (#776 E, 'Form lifetime is not component lifetime')", () => {
  it("drops that Version's draft and leaves every other Version's alone", () => {
    store.setBody(REMOVED, "an unsent note", 4);
    store.setBody(KEPT, "another draft", 9);
    store.forgetSlot(REMOVED);
    expect(store.slot(REMOVED).composer.body).toBe("");
    expect(store.slot(KEPT).composer.body).toBe("another draft");
  });

  it("tells subscribers, so a panel showing the slot re-reads it", () => {
    store.setBody(REMOVED, "draft", 1);
    const listener = vi.fn();
    store.subscribe(listener);
    store.forgetSlot(REMOVED);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a Post that completes after the slot was forgotten does not bring the slot back", async () => {
    store.setBody(REMOVED, "posting", 12);
    const sent = gate<unknown>();
    const done = store.post(REMOVED, { clock: clockAt(12), frameCount: 300, send: () => sent.promise });
    await tick();
    store.forgetSlot(REMOVED);
    sent.resolve({});
    await done;
    await tick();
    expect(store.slot(REMOVED).composer.body).toBe("");
    expect(store.slot(REMOVED).op).toBeNull();
    expect(store.slot(REMOVED)).toBe(store.slot("00000000-0000-4000-8000-000000000000"));
  });

  it("a Post that fails after the slot was forgotten writes no problem into it", async () => {
    store.setBody(REMOVED, "posting", 12);
    const sent = gate<unknown>();
    const done = store.post(REMOVED, { clock: clockAt(12), frameCount: 300, send: () => sent.promise });
    await tick();
    store.forgetSlot(REMOVED);
    sent.reject(new Error("boom"));
    await done;
    await tick();
    expect(store.slot(REMOVED)).toBe(store.slot("00000000-0000-4000-8000-000000000000"));
  });

  it("a copied-notes clipboard whose source is the forgotten Version goes; one from another Version stays", () => {
    store.copyNotes("video-a", { sourceAssetId: REMOVED, sourceVersion: 2, noteIds: ["n1"] });
    store.copyNotes("video-b", { sourceAssetId: KEPT, sourceVersion: 1, noteIds: ["n2"] });
    store.forgetSlot(REMOVED);
    expect(store.clipboard("video-a")).toBeNull();
    expect(store.clipboard("video-b")).not.toBeNull();
  });
});
