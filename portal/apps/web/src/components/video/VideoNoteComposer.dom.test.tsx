import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFrameClock, FrameClockState } from "../../lib/video-frame-clock";
import { ApiError } from "../../lib/api";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import { VideoNoteComposer } from "./VideoNoteComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The part of VideoFrameClock the composer and its store use, with a held-open confirmation. */
function fakeClock(initial: Partial<FrameClockState> = {}) {
  let state: FrameClockState = { frame: 12, targetFrame: null, confirmed: true, playing: false, rate: 0, ...initial };
  const listeners = new Set<() => void>();
  const waiters: Array<{ resolve: (frame: number) => void; reject: (reason: unknown) => void }> = [];
  const clock = {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    seekToFrame: vi.fn((frame: number) => { state = { ...state, playing: false, rate: 0, targetFrame: frame, confirmed: false }; listeners.forEach((l) => l()); }),
    awaitConfirmedFrame: vi.fn(() => new Promise<number>((resolve, reject) => { waiters.push({ resolve, reject }); })),
  };
  return {
    clock: clock as unknown as VideoFrameClock, raw: clock,
    set(next: Partial<FrameClockState>) { act(() => { state = { ...state, ...next }; listeners.forEach((l) => l()); }); },
    confirm(frame: number) { act(() => { state = { ...state, frame, targetFrame: null, confirmed: true }; listeners.forEach((l) => l()); waiters.splice(0).forEach((w) => w.resolve(frame)); }); },
    abort() { waiters.splice(0).forEach((w) => w.reject(new DOMException("disposed", "AbortError"))); },
  };
}

const tc = (frame: number) => `TC${frame}`;
let root: Root | null = null; let host: HTMLElement;
type Props = Omit<React.ComponentProps<typeof VideoNoteComposer>, "store" | "assetId">;
/** The Video tab's form store, shared by every composer mounted in a test (a remount reads it back). */
let store: NoteFormStore;
const A = "asset";
async function render(over: Partial<Props> = {}) {
  const props: Props = { clock: null, frameCount: 300, timecode: tc, post: vi.fn(async () => ({})), onRefresh: vi.fn(), ...over };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const tree = () => <VideoNoteComposer {...props} store={store} assetId={A} />;
  const rerender = async (next: Partial<Props>) => { Object.assign(props, next); await act(async () => { root!.render(tree()); }); };
  await act(async () => { root!.render(tree()); });
  return { props, rerender };
}
/** A note the way the store opens it for editing or replying to. */
const aNote = { id: "00000000-0000-4000-8000-000000000001", body: "A note", revision: 1, startFrame: 10, endFrame: null, hasMarkup: false } as never;
const textarea = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const postButton = () => byTestId("video-note-post") as HTMLButtonElement;
const visibilityItem = (value: string) => host.querySelector<HTMLElement>(`[data-testid="video-note-visibility-${value}"]`)!;
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(textarea(), text); textarea().dispatchEvent(new Event("input", { bubbles: true })); });
}
const click = (el: HTMLElement) => act(async () => { el.click(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { vi.useRealTimers(); store = createNoteFormStore("test"); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; vi.useRealTimers(); document.body.replaceChildren(); });

describe("VideoNoteComposer (#741 5b)", () => {
  it("without a clock, Post is disabled and says the film is loading", async () => {
    await render({ clock: null });
    await type("hello");
    expect(postButton().disabled).toBe(true);
    expect(host.textContent).toContain("Loading the film…");
  });

  it("starts Internal with its hint; Client-visible posts as public with its own hint; after a post it is Internal again", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    expect(visibilityItem("internal").getAttribute("aria-pressed")).toBe("true");
    expect(visibilityItem("public").getAttribute("aria-pressed")).toBe("false");
    expect(byTestId("video-note-visibility-hint")!.textContent).toBe("Studio only — never shown on the client link.");
    await click(visibilityItem("public"));
    expect(visibilityItem("public").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("video-note-visibility-hint")!.textContent).toBe("Shown to the client on the review link.");
    await type("for the client");
    await click(postButton());
    f.confirm(12);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 12, visibility: "public", body: "for the client" });
    expect(textarea().value).toBe("");
    expect(visibilityItem("internal").getAttribute("aria-pressed")).toBe("true");
  });

  it("posts Internal by default", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("x"); await click(postButton()); f.confirm(12); await flush();
    expect(props.post).toHaveBeenCalledWith(expect.objectContaining({ visibility: "internal" }));
  });

  it("an empty visibility choice is refused: one option is always pressed", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await click(visibilityItem("internal"));
    expect(visibilityItem("internal").getAttribute("aria-pressed")).toBe("true");
  });

  it("the anchor freezes where composing started: playback moves on, Post seeks back and waits for the frame before posting it", async () => {
    const f = fakeClock({ frame: 12 });
    const { props } = await render({ clock: f.clock });
    expect(byTestId("video-note-anchor")!.textContent).toContain("TC12");
    f.set({ frame: 20 });
    expect(byTestId("video-note-anchor")!.textContent).toContain("TC20");
    await type("a");
    f.set({ frame: 40, playing: true, rate: 1 });
    expect(byTestId("video-note-anchor")!.textContent).toContain("TC20");
    await click(postButton());
    expect(f.raw.seekToFrame).toHaveBeenCalledWith(20);
    expect(postButton().textContent).toBe("Confirming…");
    expect(postButton().disabled).toBe(true);
    expect(props.post).not.toHaveBeenCalled();
    f.confirm(20);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 20, visibility: "internal", body: "a" });
  });

  it("posts frame 0 as startFrame 0", async () => {
    const f = fakeClock({ frame: 0 });
    const { props } = await render({ clock: f.clock });
    await type("first frame"); await click(postButton()); f.confirm(0); await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 0, visibility: "internal", body: "first frame" });
  });

  it("a confirmation that never lands in 10 seconds keeps the draft, posts nothing and offers Retry", async () => {
    vi.useFakeTimers();
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("slow");
    await click(postButton());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(props.post).not.toHaveBeenCalled();
    expect(textarea().value).toBe("slow");
    expect(host.textContent).toContain("The frame took too long to show.");
    expect(postButton().disabled).toBe(false);
    expect(postButton().textContent).toBe("Retry");
  });

  it("a clock disposed mid-confirmation (Version change) posts nothing", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("x"); await click(postButton());
    f.abort(); await flush();
    expect(props.post).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("went wrong");
  });

  it("with both marks it pauses on the range start, confirms it, then posts the half-open range; Set in, Set out and Clear marks write the store", async () => {
    const f = fakeClock({ frame: 33 });
    const { props } = await render({ clock: f.clock });
    await act(async () => { store.mark(A, "in", 10, f.clock); store.mark(A, "out", 20, f.clock); });
    expect(byTestId("video-note-anchor")!.textContent).toContain("TC10");
    expect(byTestId("video-note-anchor")!.textContent).toContain("TC20");
    await type("range");
    await click(postButton());
    f.confirm(10);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 10, endFrame: 21, visibility: "internal", body: "range" });
    f.set({ frame: 40 });
    await click(byTestId("video-note-set-in")!);
    expect(byTestId("video-note-anchor")!.textContent).toBe("In TC40");
    await click(byTestId("video-note-set-out")!);
    expect(byTestId("video-note-anchor")!.textContent).toBe("In TC40 → Out TC40");
    await click(byTestId("video-note-clear-marks")!);
    expect(byTestId("video-note-anchor")!.textContent).toBe("Note at TC40");
  });

  it("Ctrl/Cmd+Enter posts; plain Enter is a newline; typing i and o sets no marks", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("io");
    expect(byTestId("video-note-anchor")!.textContent).not.toContain("In ");
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(props.post).not.toHaveBeenCalled();
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
    f.confirm(12); await flush();
    expect(props.post).toHaveBeenCalledTimes(1);
  });

  it("a network failure keeps the draft, never retries by itself, and offers a refresh", async () => {
    const f = fakeClock();
    const post = vi.fn(async () => { throw new ApiError("Failed to fetch", 0); });
    const { props } = await render({ clock: f.clock, post });
    await type("maybe posted"); await click(postButton()); f.confirm(12); await flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("maybe posted");
    expect(host.textContent).toContain("may or may not have posted");
    await click(byTestId("video-note-refresh")!);
    expect(props.onRefresh).toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("an out-of-range refusal names the last frame; an archived refusal keeps the draft", async () => {
    const f = fakeClock();
    const post = vi.fn()
      .mockRejectedValueOnce(new ApiError("range", 422, { code: "frame_out_of_range", frameCount: 300 }))
      .mockRejectedValueOnce(new ApiError("archived", 409, { code: "project_archived" }));
    await render({ clock: f.clock, post });
    await type("x"); await click(postButton()); f.confirm(12); await flush();
    expect(host.textContent).toContain("outside this film");
    expect(host.textContent).toContain("299");
    await click(postButton()); f.confirm(12); await flush();
    expect(host.textContent).toContain("archived");
    expect(textarea().value).toBe("x");
  });

  it("keeps its text, choice and anchor in the store, and a remounted composer shows them", async () => {
    const f = fakeClock({ frame: 7 });
    await render({ clock: f.clock });
    await click(visibilityItem("public"));
    await type("keep me");
    expect(store.slot(A).composer).toMatchObject({ body: "keep me", visibility: "public", anchorFrame: 7 });
    await type("");
    expect(store.slot(A).composer).toMatchObject({ body: "", visibility: "internal", anchorFrame: null });
    await click(visibilityItem("public"));
    await type("back again");
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await render({ clock: f.clock });
    expect(textarea().value).toBe("back again");
    expect(visibilityItem("public").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("video-note-anchor")!.textContent).toContain("TC7");
  });

  it("marks its form for the viewer's focus lookup", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    expect(host.querySelector<HTMLElement>("[data-notes-form]")!.dataset.notesForm).toBe("composer");
  });
});

describe("VideoNoteComposer: Sol round 1 (#741 5b)", () => {
  it("finding 3: from Post until the request settles, the text, the visibility and the marks are read-only", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("first");
    await click(postButton());
    expect(postButton().textContent).toBe("Confirming…");
    expect(textarea().readOnly).toBe(true);
    expect((visibilityItem("public") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("video-note-set-in") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("video-note-set-out") as HTMLButtonElement).disabled).toBe(true);
    await type("first and a late correction");
    await click(visibilityItem("public"));
    expect(textarea().value).toBe("first");
    f.confirm(12);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 12, visibility: "internal", body: "first" });
  });

  it("finding 3: the text stays read-only while the request is out, and the form reopens when it settles", async () => {
    const f = fakeClock();
    let settle: (value: unknown) => void = () => undefined;
    const post = vi.fn(() => new Promise<unknown>((resolve) => { settle = resolve; }));
    await render({ clock: f.clock, post });
    await type("sent"); await click(postButton()); f.confirm(12); await flush();
    expect(postButton().textContent).toBe("Posting…");
    expect(textarea().readOnly).toBe(true);
    await act(async () => { settle({}); });
    await flush();
    expect(textarea().readOnly).toBe(false);
    expect(textarea().value).toBe("");
  });

  it("finding 4: a seek that supersedes the confirmation cancels the post: 'Frame moved — Post again', the draft is kept", async () => {
    const f = fakeClock({ frame: 20 });
    const { props } = await render({ clock: f.clock });
    await type("anchored at 20");
    await click(postButton());
    expect(f.raw.seekToFrame).toHaveBeenCalledWith(20);
    f.confirm(35); // the person scrubbed to 35 before frame 20 landed
    await flush();
    expect(props.post).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Frame moved — Post again");
    expect(textarea().value).toBe("anchored at 20");
    expect(postButton().disabled).toBe(false);
    expect(postButton().textContent).toBe("Post");
    await click(postButton());
    f.confirm(20);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 20, visibility: "internal", body: "anchored at 20" });
  });

  it("finding 5: cancelling the confirmation (the viewer's Escape) returns the form to idle with its text, and nothing posts", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("keep this");
    await click(postButton());
    expect(postButton().textContent).toBe("Confirming…");
    await act(async () => { store.cancelConfirmation(A); });
    expect(postButton().textContent).toBe("Post");
    expect(textarea().value).toBe("keep this");
    expect(postButton().disabled).toBe(false);
    f.confirm(12);
    await flush();
    expect(props.post).not.toHaveBeenCalled();
  });

  it("finding 5: cancelling never touches a request already sent", async () => {
    const f = fakeClock();
    let settle: (value: unknown) => void = () => undefined;
    const post = vi.fn(() => new Promise<unknown>((resolve) => { settle = resolve; }));
    await render({ clock: f.clock, post });
    await type("sent"); await click(postButton()); f.confirm(12); await flush();
    await act(async () => { store.cancelConfirmation(A); });
    expect(postButton().textContent).toBe("Posting…");
    expect(textarea().readOnly).toBe(true);
    await act(async () => { settle({}); });
    await flush();
    expect(textarea().value).toBe("");
  });

  it("finding 2: opening another form cancels the composer's confirmation and keeps its text", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("parked"); await click(postButton());
    expect(postButton().textContent).toBe("Confirming…");
    await act(async () => { store.openReply(A, "00000000-0000-4000-8000-000000000009"); });
    f.confirm(12); await flush();
    expect(props.post).not.toHaveBeenCalled();
    expect(textarea().value).toBe("parked");
  });

  it("finding 9: erasing all the text resets Client-visible to Internal", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await type("public draft");
    await click(visibilityItem("public"));
    expect(visibilityItem("public").getAttribute("aria-pressed")).toBe("true");
    await type("");
    expect(visibilityItem("internal").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("video-note-visibility-hint")!.textContent).toBe("Studio only — never shown on the client link.");
  });

  it("finding 9: a choice made on an empty composer stays until text is typed and erased", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await click(visibilityItem("public"));
    expect(visibilityItem("public").getAttribute("aria-pressed")).toBe("true");
  });

  it("another form open: Post, Set in and Set out are disabled with a hint, typing still works; the hint names the form", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await act(async () => { store.openEdit(A, aNote, (aNote as { id: string }).id); });
    await type("still typing");
    expect(textarea().value).toBe("still typing");
    expect(postButton().disabled).toBe(true);
    expect((byTestId("video-note-set-in") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("video-note-set-out") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open edit first.");
    expect(byTestId("video-note-composer")!.dataset.locked).toBe("true");
    expect(byTestId("video-note-composer")!.className).toContain("opacity-60");
    expect(byTestId("video-note-other-form-hint")!.nextElementSibling).toBe(postButton()); // the hint sits next to Post
    await act(async () => { store.openReply(A, "00000000-0000-4000-8000-000000000009"); });
    expect(byTestId("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open reply first.");
    await act(async () => { store.close(A); });
    expect(byTestId("video-note-other-form-hint")).toBeNull();
    expect(byTestId("video-note-composer")!.dataset.locked).toBe("false");
    expect(postButton().disabled).toBe(false);
  });

  it("round 2 (4): a marked note seeks to its range start and posts only once that frame is confirmed", async () => {
    const f = fakeClock({ frame: 90, playing: true, rate: 1 });
    const { props } = await render({ clock: f.clock });
    await act(async () => { store.mark(A, "in", 10, f.clock); store.mark(A, "out", 20, f.clock); });
    await type("marked");
    await click(postButton());
    expect(f.raw.seekToFrame).toHaveBeenCalledWith(10);
    expect(postButton().textContent).toBe("Confirming…");
    expect(props.post).not.toHaveBeenCalled();
    f.confirm(10); await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 10, endFrame: 21, visibility: "internal", body: "marked" });
  });

  it("round 2 (4): a marked note whose confirmed frame is not its start shows 'Frame moved' and keeps the draft; the 10 s timeout and Escape cancel it too", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await act(async () => { store.mark(A, "in", 10, f.clock); store.mark(A, "out", 20, f.clock); });
    await type("marked"); await click(postButton());
    f.confirm(55); await flush();
    expect(props.post).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Frame moved — Post again");
    expect(textarea().value).toBe("marked");
    await click(postButton());
    await act(async () => { store.cancelConfirmation(A); });
    expect(postButton().textContent).toBe("Post");
    f.confirm(10); await flush();
    expect(props.post).not.toHaveBeenCalled();
  });

  it("round 2 (4): a marked note's confirmation times out after 10 seconds and offers Retry", async () => {
    vi.useFakeTimers();
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await act(async () => { store.mark(A, "in", 10, f.clock); });
    await type("slow marked"); await click(postButton());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(props.post).not.toHaveBeenCalled();
    expect(postButton().textContent).toBe("Retry");
  });
});
