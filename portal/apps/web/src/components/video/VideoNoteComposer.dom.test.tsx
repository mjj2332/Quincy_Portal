import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFrameClock, FrameClockState } from "../../lib/video-frame-clock";
import { VIDEO_NOTE_BODY_MAX } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));
import { VideoNoteComposer } from "./VideoNoteComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The part of VideoFrameClock the composer and its store use, with a held-open confirmation. */
function fakeClock(initial: Partial<FrameClockState> = {}) {
  let state: FrameClockState = { frame: 12, targetFrame: null, confirmed: true, playing: false, rate: 0, stalled: false, ...initial };
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

const para = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const tc = (frame: number) => `TC${frame}`;
let root: Root | null = null; let host: HTMLElement;
type Props = Omit<React.ComponentProps<typeof VideoNoteComposer>, "store" | "assetId">;
/** The Video tab's form store, shared by every composer mounted in a test (a remount reads it back). */
let store: NoteFormStore;
const A = "asset";
async function render(over: Partial<Props> = {}) {
  const props: Props = { clock: null, frameCount: 300, timecode: tc, post: vi.fn(async () => ({})), onRefresh: vi.fn(), rich: { projectId: "p1", role: "editor" }, ...over };
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
/** The box's round Send (#927): icon-only, named by its phase. A lock with a reason is aria-disabled (it stays focusable for its title). */
const postButton = () => host.querySelector<HTMLButtonElement>('[data-testid="video-note-composer"] button[type="submit"]')!;
const postLabel = () => postButton().getAttribute("aria-label");
const off = (button: HTMLElement) => (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const rangeButton = () => byLabel("In and out points")!;
const chip = () => byTestId("note-composer-chip")!;
/** The visibility menu's trigger names the current choice. */
const visibilityTrigger = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Who can see this note"]')!;
const visibility = () => (visibilityTrigger().getAttribute("aria-label")!.endsWith("Client-visible") ? "public" : "internal");
async function pickVisibility(value: "internal" | "public") {
  await click(visibilityTrigger());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((candidate) => candidate.textContent!.startsWith(value === "public" ? "Client-visible" : "Internal"));
  if (item) await click(item);
}
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(textarea(), text); textarea().dispatchEvent(new Event("input", { bubbles: true })); });
}
/** One stroke drawn the way the pen makes it: draw mode confirms the frame, the stroke lands, ‹ leaves. */
async function drawStroke(f: ReturnType<typeof fakeClock>, frame: number) {
  let entering: Promise<unknown> = Promise.resolve();
  act(() => { entering = store.enterDraw(A, { clock: f.clock, form: "composer", frameCount: 300 }); });
  f.confirm(frame);
  await act(async () => { await entering; });
  await act(async () => { store.setItems(A, "composer", [{ color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }] as never); store.exitDraw(A); });
}
const click = (el: HTMLElement) => act(async () => { el.click(); await Promise.resolve(); await Promise.resolve(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { vi.useRealTimers(); store = createNoteFormStore("test"); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; vi.useRealTimers(); document.body.replaceChildren(); });

describe("VideoNoteComposer (#741 5b; the note box, #927)", () => {
  it("is the staff box (C2): the chip before the field, in/out and the paperclip on the left, visibility and a round Send on the right; no Set in / Set out, hint line or toggle group", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    const form = byTestId("video-note-composer")!;
    expect(form.tagName).toBe("FORM");
    expect(form.getAttribute("aria-label")).toBe("Add a note");
    expect(form.dataset.variant).toBe("staff");
    expect([...form.querySelectorAll("button:not([hidden])")].map((b) => b.getAttribute("aria-label"))).toEqual(["In and out points", "Add photos or videos", "Who can see this note: Internal", "Post note"]);
    expect(textarea().placeholder).toBe("Add a note at this frame… Use @ to mention a colleague.");
    for (const removed of ["video-note-set-in", "video-note-set-out", "video-note-clear-marks", "video-note-visibility-hint", "video-note-visibility-internal", "video-note-anchor", "video-note-remove-drawing", "video-note-drawing-chip"]) expect(byTestId(removed)).toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Who can see this note"]')).toBeNull();
  });

  it("without a clock, Send is locked and says the film is loading", async () => {
    await render({ clock: null });
    await type("hello");
    expect(off(postButton())).toBe(true);
    expect(postButton().title).toBe("Loading the film…");
    expect(host.textContent).toContain("Loading the film…");
  });

  it("Send needs text (C2, D2): empty it is disabled; a drawing alone says to add a few words; text enables it", async () => {
    const f = fakeClock();
    await render({ clock: f.clock, markup: true });
    expect(off(postButton())).toBe(true);
    expect(postButton().title).toBe("Post (⌘↵)");
    await drawStroke(f, 12);
    expect(off(postButton())).toBe(true);
    expect(postButton().title).toBe("Add a few words to post the drawing");
    await type("with words");
    expect(off(postButton())).toBe(false);
  });

  it("starts Internal; the menu's Client-visible posts as public; after a post it is Internal again (C5)", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    expect(visibility()).toBe("internal");
    await pickVisibility("public");
    expect(visibility()).toBe("public");
    await type("for the client");
    await click(postButton());
    f.confirm(12);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 12, visibility: "public", content: para("for the client") });
    expect(textarea().value).toBe("");
    expect(visibility()).toBe("internal");
  });

  it("posts Internal by default", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("x"); await click(postButton()); f.confirm(12); await flush();
    expect(props.post).toHaveBeenCalledWith(expect.objectContaining({ visibility: "internal" }));
  });

  it("the chip follows the playhead until the first text, then freezes: playback moves on, Send seeks back and waits for the frame before posting it", async () => {
    const f = fakeClock({ frame: 12 });
    const { props } = await render({ clock: f.clock });
    expect(chip().textContent).toBe("Note at TC12");
    expect(chip().title).toBe("Follows the playhead until you start the note");
    f.set({ frame: 20 });
    expect(chip().textContent).toBe("Note at TC20");
    await type("a");
    expect(chip().title).toBe("The note is stamped here");
    f.set({ frame: 40, playing: true, rate: 1 });
    expect(chip().textContent).toBe("Note at TC20");
    await click(postButton());
    expect(f.raw.seekToFrame).toHaveBeenCalledWith(20);
    expect(postLabel()).toBe("Confirming…");
    expect(off(postButton())).toBe(true);
    expect(props.post).not.toHaveBeenCalled();
    f.confirm(20);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 20, visibility: "internal", content: para("a") });
  });

  it("the first upload freezes the chip too (the paperclip), so scrubbing no longer moves it, and Send waits for the upload", async () => {
    const f = fakeClock({ frame: 30 });
    await render({ clock: f.clock });
    await click(byLabel("Add photos or videos")!);
    expect(store.slot(A).composer.anchorFrame).toBe(30);
    f.set({ frame: 55 });
    expect(chip().textContent).toBe("Note at TC30");
    await type("ref attached");
    expect(off(postButton())).toBe(true);
    expect(postButton().title).toBe("Wait for the uploads to finish.");
    await click(byTestId("stub-upload-done")!);
    expect(off(postButton())).toBe(false);
    expect(chip().textContent).toBe("Note at TC30");
  });

  it("#955: a file that failed to upload holds Send until it is retried or removed", async () => {
    await render({ clock: fakeClock({ frame: 30 }).clock });
    await type("with a file");
    expect(off(postButton())).toBe(false);
    await click(byTestId("stub-file-failed")!);
    expect(off(postButton())).toBe(true);
    expect(postButton().title).toBe("Retry or remove the file that failed.");
    await click(byTestId("stub-file-cleared")!);
    expect(off(postButton())).toBe(false);
  });

  it("focus alone does not freeze the chip on a desktop", async () => {
    const f = fakeClock({ frame: 12 });
    await render({ clock: f.clock });
    await act(async () => { textarea().focus(); });
    f.set({ frame: 44 });
    expect(chip().textContent).toBe("Note at TC44");
    expect(store.slot(A).composer.anchorFrame).toBeNull();
  });

  it("posts frame 0 as startFrame 0", async () => {
    const f = fakeClock({ frame: 0 });
    const { props } = await render({ clock: f.clock });
    await type("first frame"); await click(postButton()); f.confirm(0); await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 0, visibility: "internal", content: para("first frame") });
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
    expect(off(postButton())).toBe(false);
    expect(postLabel()).toBe("Retry");
  });

  it("a clock disposed mid-confirmation (Version change) posts nothing", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("x"); await click(postButton());
    f.abort(); await flush();
    expect(props.post).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("went wrong");
  });

  it("in/out is one button, three presses (In, then Out, then clear), and the chip reads In → Out with ×; both marks post the half-open range", async () => {
    const f = fakeClock({ frame: 33 });
    const { props } = await render({ clock: f.clock });
    expect(rangeButton().title).toBe("Set in (I)");
    expect(rangeButton().getAttribute("aria-pressed")).toBe("false");
    expect(rangeButton().getAttribute("aria-keyshortcuts")).toBe("I O");
    f.set({ frame: 10 });
    await click(rangeButton());
    expect(store.slot(A).marks.value).toMatchObject({ in: 10, out: null });
    expect(rangeButton().title).toBe("Set out (O)");
    expect(rangeButton().getAttribute("aria-pressed")).toBe("true");
    // Out follows the playhead until it is marked.
    f.set({ frame: 18 });
    expect(chip().textContent).toContain("TC10 → TC18");
    expect(byTestId("note-composer-chip-live")).not.toBeNull();
    f.set({ frame: 20 });
    await click(rangeButton());
    expect(chip().textContent).toContain("Note from TC10 to TC20");
    expect(byTestId("note-composer-chip-live")).toBeNull();
    expect(rangeButton().title).toBe("Clear in / out");
    await type("range");
    await click(postButton());
    f.confirm(10);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 10, endFrame: 21, visibility: "internal", content: para("range") });
    f.set({ frame: 40 });
    await click(rangeButton());
    await click(rangeButton());
    expect(chip().textContent).toContain("TC40 → TC40");
    await click(rangeButton());
    expect(chip().textContent).toBe("Note at TC40");
    await click(rangeButton());
    await click(byLabel("Clear in and out")!);
    expect(chip().textContent).toBe("Note at TC40");
    expect(rangeButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("Ctrl/Cmd+Enter posts; plain Enter is a newline; typing i and o sets no marks", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("io");
    expect(rangeButton().getAttribute("aria-pressed")).toBe("false");
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
    expect(byTestId("video-note-problem")!.getAttribute("role")).toBe("alert");
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

  it("too long: Send is locked and the box says the cap", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await type("x".repeat(VIDEO_NOTE_BODY_MAX + 1));
    expect(off(postButton())).toBe(true);
    expect(byTestId("video-note-problem")!.textContent).toContain("characters at most");
  });

  it("keeps its text, choice and anchor in the store, and a remounted composer shows them", async () => {
    const f = fakeClock({ frame: 7 });
    await render({ clock: f.clock });
    await pickVisibility("public");
    await type("keep me");
    expect(store.slot(A).composer).toMatchObject({ body: "keep me", visibility: "public", anchorFrame: 7 });
    await type("");
    expect(store.slot(A).composer).toMatchObject({ body: "", visibility: "internal", anchorFrame: null });
    await pickVisibility("public");
    await type("back again");
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await render({ clock: f.clock });
    expect(textarea().value).toBe("back again");
    expect(visibility()).toBe("public");
    expect(chip().textContent).toBe("Note at TC7");
  });

  it("marks its form for the viewer's focus lookup", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    expect(host.querySelector<HTMLElement>("[data-notes-form]")!.dataset.notesForm).toBe("composer");
  });
});

describe("VideoNoteComposer: the pen and the drawing row (#927, C6)", () => {
  const row = { tool: "freehand" as const, color: "#e64b3c", onToolChange: vi.fn(), onColorChange: vi.fn(), canUndo: true, canRedo: false, canClear: true, onUndo: vi.fn(), onRedo: vi.fn(), onClear: vi.fn(), onDone: vi.fn() };

  it("shows the pen only when it is handed one, and a press goes to it", async () => {
    const f = fakeClock();
    const onPress = vi.fn();
    const { rerender } = await render({ clock: f.clock });
    expect(byLabel("Draw on the frame")).toBeNull();
    await rerender({ draw: { pen: { onPress }, row: null, full: false } });
    await click(byLabel("Draw on the frame")!);
    expect(onPress).toHaveBeenCalledTimes(1);
    await rerender({ draw: { pen: { onPress, disabled: true, reason: "Finish or cancel the open edit first." }, row: null, full: false } });
    expect(off(byLabel("Draw on the frame")!)).toBe(true);
    expect(byLabel("Draw on the frame")!.title).toBe("Finish or cancel the open edit first.");
  });

  it("while drawing the row takes the tools' place: visibility and Send hide, the field stays; the stroke cap shows its line", async () => {
    const f = fakeClock();
    await render({ clock: f.clock, draw: { pen: { onPress: vi.fn() }, row, full: true } });
    expect(byTestId("video-note-composer")!.dataset.drawing).toBe("true");
    expect(byTestId("note-draw-row")).not.toBeNull();
    expect(visibilityTrigger()).toBeNull();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(textarea()).not.toBeNull();
    expect(byTestId("video-markup-full")!.textContent).toBe("That is as much markup as one note can hold. Undo a stroke to add more.");
    await click(byLabel("Done drawing")!);
    expect(row.onDone).toHaveBeenCalled();
  });

  it("a drawing in the draft puts the pencil on the chip; there is no separate drawing chip or Remove drawing", async () => {
    const f = fakeClock();
    await render({ clock: f.clock, markup: true });
    await drawStroke(f, 12);
    expect(chip().textContent).toBe("Note with a drawing at TC12");
    expect(chip().querySelector("svg")).not.toBeNull();
    expect(byTestId("video-note-drawing-chip")).toBeNull();
    expect(byTestId("video-note-remove-drawing")).toBeNull();
  });
});

describe("VideoNoteComposer: Sol round 1 (#741 5b)", () => {
  it("finding 3: from Send until the request settles, the text, the visibility and the marks are read-only", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("first");
    await click(postButton());
    expect(postLabel()).toBe("Confirming…");
    expect(textarea().readOnly).toBe(true);
    expect(visibilityTrigger().disabled || visibilityTrigger().getAttribute("aria-disabled") === "true" || visibilityTrigger().hasAttribute("data-disabled")).toBe(true);
    expect(off(rangeButton())).toBe(true);
    expect(off(byLabel("Add photos or videos")!)).toBe(true);
    await type("first and a late correction");
    await pickVisibility("public");
    expect(textarea().value).toBe("first");
    f.confirm(12);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 12, visibility: "internal", content: para("first") });
  });

  it("finding 3: the text stays read-only while the request is out, and the form reopens when it settles", async () => {
    const f = fakeClock();
    let settle: (value: unknown) => void = () => undefined;
    const post = vi.fn(() => new Promise<unknown>((resolve) => { settle = resolve; }));
    await render({ clock: f.clock, post });
    await type("sent"); await click(postButton()); f.confirm(12); await flush();
    expect(postLabel()).toBe("Posting…");
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
    expect(off(postButton())).toBe(false);
    expect(postLabel()).toBe("Post note");
    await click(postButton());
    f.confirm(20);
    await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 20, visibility: "internal", content: para("anchored at 20") });
  });

  it("finding 5: cancelling the confirmation (the viewer's Escape) returns the form to idle with its text, and nothing posts", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("keep this");
    await click(postButton());
    expect(postLabel()).toBe("Confirming…");
    await act(async () => { store.cancelConfirmation(A); });
    expect(postLabel()).toBe("Post note");
    expect(textarea().value).toBe("keep this");
    expect(off(postButton())).toBe(false);
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
    expect(postLabel()).toBe("Posting…");
    expect(textarea().readOnly).toBe(true);
    await act(async () => { settle({}); });
    await flush();
    expect(textarea().value).toBe("");
  });

  it("finding 2: opening another form cancels the composer's confirmation and keeps its text", async () => {
    const f = fakeClock();
    const { props } = await render({ clock: f.clock });
    await type("parked"); await click(postButton());
    expect(postLabel()).toBe("Confirming…");
    await act(async () => { store.openReply(A, "00000000-0000-4000-8000-000000000009"); });
    f.confirm(12); await flush();
    expect(props.post).not.toHaveBeenCalled();
    expect(textarea().value).toBe("parked");
  });

  it("finding 9: erasing all the text resets Client-visible to Internal", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await type("public draft");
    await pickVisibility("public");
    expect(visibility()).toBe("public");
    await type("");
    expect(visibility()).toBe("internal");
  });

  it("finding 9: a choice made on an empty composer stays until text is typed and erased", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await pickVisibility("public");
    expect(visibility()).toBe("public");
  });

  it("another form open: Send, in/out and the paperclip are locked with the reason, typing still works; the line names the form", async () => {
    const f = fakeClock();
    await render({ clock: f.clock });
    await act(async () => { store.openEdit(A, aNote, (aNote as { id: string }).id); });
    await type("still typing");
    expect(textarea().value).toBe("still typing");
    expect(off(postButton())).toBe(true);
    expect(postButton().title).toBe("Finish or cancel the open edit first.");
    expect(off(rangeButton())).toBe(true);
    expect(rangeButton().title).toBe("Finish or cancel the open edit first.");
    expect(off(byLabel("Add photos or videos")!)).toBe(true);
    expect(byTestId("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open edit first.");
    expect(byTestId("video-note-composer")!.dataset.locked).toBe("true");
    await act(async () => { store.openReply(A, "00000000-0000-4000-8000-000000000009"); });
    expect(byTestId("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open reply first.");
    await act(async () => { store.close(A); });
    expect(byTestId("video-note-other-form-hint")).toBeNull();
    expect(byTestId("video-note-composer")!.dataset.locked).toBe("false");
    expect(off(postButton())).toBe(false);
  });

  it("round 2 (4): a marked note seeks to its range start and posts only once that frame is confirmed", async () => {
    const f = fakeClock({ frame: 90, playing: true, rate: 1 });
    const { props } = await render({ clock: f.clock });
    await act(async () => { store.mark(A, "in", 10, f.clock); store.mark(A, "out", 20, f.clock); });
    await type("marked");
    await click(postButton());
    expect(f.raw.seekToFrame).toHaveBeenCalledWith(10);
    expect(postLabel()).toBe("Confirming…");
    expect(props.post).not.toHaveBeenCalled();
    f.confirm(10); await flush();
    expect(props.post).toHaveBeenCalledWith({ startFrame: 10, endFrame: 21, visibility: "internal", content: para("marked") });
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
    expect(postLabel()).toBe("Post note");
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
    expect(postLabel()).toBe("Retry");
  });
});
