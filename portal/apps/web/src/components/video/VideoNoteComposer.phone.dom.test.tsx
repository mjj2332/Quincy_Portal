import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFrameClock, FrameClockState } from "../../lib/video-frame-clock";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import "../../testing/dom-polyfills";
import { mockViewport, type MockViewport } from "../../testing/viewport";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));
import { VideoNoteComposer } from "./VideoNoteComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The phone composer (#879, D10/D11): one row at rest, engaged on focus, focus pauses the film, the pen blurs the keyboard away. */
let frameNow = 12;
function fakeClock() {
  frameNow = 12;
  const state: FrameClockState = { frame: 12, targetFrame: null, confirmed: true, playing: true, rate: 1, stalled: false };
  const clock = { getState: () => ({ ...state, frame: frameNow }), subscribe: () => () => undefined, pause: vi.fn(), step: vi.fn(), seekToFrame: vi.fn(), awaitConfirmedFrame: vi.fn(() => Promise.resolve(12)) };
  return { clock: clock as unknown as VideoFrameClock, raw: clock };
}
let root: Root | null = null; let host: HTMLElement; let store: NoteFormStore; let viewport: MockViewport;
async function render(width: number, pen = true) {
  viewport = mockViewport({ width });
  const f = fakeClock();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<VideoNoteComposer store={store} assetId="a" clock={f.clock} frameCount={300} timecode={(n) => `TC${n}`} post={vi.fn(async () => ({}))} onRefresh={() => {}} rich={{ projectId: "p", role: "editor" }} {...(pen ? { pen: <button type="button" data-testid="pen-stub">Draw</button> } : {})} />); });
  return f;
}
const by = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
beforeEach(() => { store = createNoteFormStore("t"); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; viewport.restore(); document.body.replaceChildren(); });

describe("VideoNoteComposer on a phone (#879)", () => {
  it("rests as one row: editor, pen and Post, with no marks row or visibility choice", async () => {
    await render(390);
    expect(by("video-note-marks")).toBeNull();
    expect(by("video-note-visibility-internal")).toBeNull();
    expect(by("pen-stub")).not.toBeNull();
    expect(by("video-note-post")).not.toBeNull();
  });

  it("focusing the editor pauses the film and brings the marks row and visibility choice in", async () => {
    const f = await render(390);
    await act(async () => { host.querySelector<HTMLTextAreaElement>("textarea")!.focus(); });
    expect(f.raw.pause).toHaveBeenCalledTimes(1);
    expect(by("video-note-marks")).not.toBeNull();
    expect(by("video-note-visibility-internal")).not.toBeNull();
  });

  it("pressing the pen blurs the editor so the keyboard goes away", async () => {
    await render(390);
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { area.focus(); });
    expect(document.activeElement).toBe(area);
    await act(async () => { by("pen-stub")!.click(); });
    expect(document.activeElement).not.toBe(area);
  });

  it("on a desktop width nothing pauses on focus and the composer is whole at rest", async () => {
    const f = await render(1280, false);
    await act(async () => { host.querySelector<HTMLTextAreaElement>("textarea")!.focus(); });
    expect(f.raw.pause).not.toHaveBeenCalled();
    expect(by("video-note-marks")).not.toBeNull();
    expect(by("pen-stub")).toBeNull();
  });

  it("at rest the field is one line with the short placeholder and no formatting toolbar; engaged it shows the stamp line with Cancel and the frame steps", async () => {
    const f = await render(390);
    expect(host.querySelector("textarea")!.getAttribute("placeholder")).toBe("Add a note…");
    expect(by("video-note-stamp")).toBeNull();
    await act(async () => { host.querySelector<HTMLTextAreaElement>("textarea")!.focus(); });
    expect(by("video-note-stamp")!.textContent).toContain("Paused at TC12 · the note is stamped here");
    await act(async () => { by("video-note-step-forward")!.click(); });
    expect(f.raw.step).toHaveBeenCalledWith(1);
    await act(async () => { by("video-note-cancel")!.click(); });
    expect(document.activeElement).not.toBe(host.querySelector("textarea"));
  });

  it("Cancel throws the whole draft away: the next note starts clean, with no old drawing and its own anchor frame", async () => {
    const f = await render(390);
    await act(async () => { host.querySelector<HTMLTextAreaElement>("textarea")!.focus(); });
    await act(async () => { await store.enterDraw("a", { clock: f.clock, form: "composer", frameCount: 300 }); });
    await act(async () => { store.setItems("a", "composer", [{ kind: "pen" } as never]); store.exitDraw("a"); });
    expect(store.slot("a").markup.drawingFrame).toBe(12);
    await act(async () => { by("video-note-cancel")!.click(); });
    const held = store.slot("a");
    expect(held.markup.items).toEqual([]);
    expect(held.markup.drawingFrame).toBeNull();
    expect(held.composer.problem).toBeNull();
    expect(held.composer.anchorFrame).toBeNull();
    frameNow = 100;
    await act(async () => { store.setContent("a", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] } as never, 100); });
    expect(store.slot("a").composer.anchorFrame).toBe(100);
    expect(store.slot("a").markup.drawingFrame).toBeNull();
  });
});
