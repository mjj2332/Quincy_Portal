import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The rich field is replaced by handles on its props: this file is about what the composer does with the document and the upload state (the field itself is tested with the editor). */
const field = vi.hoisted(() => ({ props: null as null | { value: RichTextDoc; onChange: (doc: RichTextDoc) => void; onUploadingChange: (uploading: boolean) => void; projectId: string; role: string } }));
vi.mock("./VideoNoteEditor", () => ({ VideoNoteEditor: (props: NonNullable<typeof field.props>) => { field.props = props; return <div data-testid="rich-field" />; } }));
const { VideoNoteComposer } = await import("./VideoNoteComposer");

const mention = (id: string, label: string) => ({ type: "mention" as const, attrs: { id, label } });
const docWith = (...content: unknown[]): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content }] }) as RichTextDoc;
const clock = { getState: () => ({ frame: 12, targetFrame: null, confirmed: true, playing: false, rate: 0, stalled: false }), subscribe: () => () => {}, seekToFrame: vi.fn(), awaitConfirmedFrame: vi.fn(async () => 12) } as unknown as VideoFrameClock;
let root: Root; let host: HTMLElement; let store: NoteFormStore; const A = "asset";
const post = vi.fn(async (_input: unknown) => ({}));
async function render() {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<VideoNoteComposer store={store} assetId={A} clock={clock} frameCount={300} timecode={(f) => `TC${f}`} post={post} onRefresh={vi.fn()} rich={{ projectId: "p1", role: "editor" }} />); });
}
/** The box's round Send (#927); a lock with a reason is aria-disabled. */
const postButton = () => host.querySelector<HTMLButtonElement>('[data-testid="video-note-composer"] button[type="submit"]')!;
const off = () => postButton().disabled || postButton().getAttribute("aria-disabled") === "true";
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
beforeEach(() => { store = createNoteFormStore("test"); post.mockClear(); field.props = null; });
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.replaceChildren(); });

describe("VideoNoteComposer rich field (#835)", () => {
  it("hands the field the Project and role, and Post stays off while the document is empty", async () => {
    await render();
    expect(field.props).toMatchObject({ projectId: "p1", role: "editor" });
    expect(off()).toBe(true);
  });

  it("a mention makes the draft postable, and Post sends the document, not text", async () => {
    await render();
    const doc = docWith({ type: "text", text: "Match " }, mention("u1", "Mia"));
    await act(async () => { field.props!.onChange(doc); });
    expect(store.slot(A).composer).toMatchObject({ body: "Match @Mia", content: doc });
    expect(off()).toBe(false);
    await act(async () => { postButton().click(); });
    await flush();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ content: doc, visibility: "internal", startFrame: 12 }));
    expect(post.mock.calls[0]![0]).not.toHaveProperty("body");
  });

  it("holds Post while an upload is in flight, and releases it when the upload lands", async () => {
    await render();
    await act(async () => { field.props!.onChange(docWith({ type: "text", text: "x" })); });
    expect(off()).toBe(false);
    await act(async () => { field.props!.onUploadingChange(true); });
    expect(off()).toBe(true);
    await act(async () => { field.props!.onUploadingChange(false); });
    expect(off()).toBe(false);
  });

  it("an upload starting freezes the anchor on the frame on screen (#927)", async () => {
    await render();
    expect(store.slot(A).composer.anchorFrame).toBeNull();
    await act(async () => { field.props!.onUploadingChange(true); });
    expect(store.slot(A).composer.anchorFrame).toBe(12);
  });

  it("a media-only note is postable, because its body carries the count hint", async () => {
    await render();
    await act(async () => { field.props!.onChange({ type: "doc", content: [{ type: "image", attrs: { mediaId: "m1" } }] }); });
    expect(store.slot(A).composer.body).toBe("[1 image]");
    expect(off()).toBe(false);
  });
});
