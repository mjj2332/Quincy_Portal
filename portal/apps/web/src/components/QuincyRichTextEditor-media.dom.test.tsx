import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import editorSource from "./QuincyRichTextEditor.tsx?raw";
import imageSource from "./quincy/EmbeddedImage.tsx?raw";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, defaultScheduler, notifyManager } from "@tanstack/react-query";
import { COMMENT_MEDIA_RICH_TEXT_PROFILE, parseRichTextDoc, type RichTextDoc } from "@quincy/shared";
import { RenditionFailedError } from "../lib/embedded-media";
import { createRichTextEditorExtensions, tiptapToRichTextDoc, toTiptap } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { RichTextContent } from "./RichTextContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const upload = vi.hoisted(() => vi.fn());
const heicSetting = vi.hoisted(() => vi.fn());
const retryRendition = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: upload, fetchEmbeddedHeicSetting: heicSetting, retryEmbeddedRendition: retryRendition }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const withImages = (...ids: string[]): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }, ...ids.map((mediaId) => ({ type: "image" as const, attrs: { mediaId } }))] });
const png = (name = "a.png", size = 100) => new File([new Uint8Array(size)], name, { type: "image/png" });

let root: Root | null = null;
let latest: RichTextDoc = empty();
let uploadingNow = false;
function Harness({ initial = empty(), media = true, onSubmit }: { initial?: RichTextDoc; media?: boolean; onSubmit?: () => void }) {
  const [value, setValue] = useState(initial);
  return <QuincyRichTextEditor preset="composer" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} {...(media ? { media: { projectId: "p1" } } : {})} {...(onSubmit ? { onSubmit } : {})} onUploadingChange={(busy) => { uploadingNow = busy; }} />;
}
function mount(ui: React.ReactElement) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(ui)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const insertButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Insert image"]');
// The picker is the ReUI Input, mounted only while choosing: capture its click, give it the files, and fire its change.
async function choose(host: HTMLElement, files: File[], options: { accept?: string; tick?: () => Promise<void> } = {}) {
  const tick = options.tick ?? settle;
  expect(host.querySelector('input[type="file"]')).toBeNull();
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { insertButton(host)!.click(); });
  click.mockRestore();
  const picker = host.querySelector<HTMLInputElement>('input[data-testid="rich-text-image-picker"]')!;
  expect(picker.accept).toBe(options.accept ?? "image/jpeg,image/png,image/webp"); expect(picker.multiple).toBe(true);
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await tick();
  expect(host.querySelector('input[type="file"]')).toBeNull();
}

beforeEach(() => { latest = empty(); uploadingNow = false; upload.mockReset(); heicSetting.mockReset(); heicSetting.mockResolvedValue(false); retryRendition.mockReset(); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the image node's stored contract", () => {
  it("round-trips through Tiptap and keeps only the media id", () => {
    const stored = withImages(A, B);
    expect(tiptapToRichTextDoc(toTiptap(stored))).toEqual(stored);
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: toTiptap(stored) });
    const out = tiptapToRichTextDoc(editor.getJSON());
    expect(out).toEqual(stored);
    expect(() => parseRichTextDoc(out, COMMENT_MEDIA_RICH_TEXT_PROFILE)).not.toThrow();
    editor.destroy();
  });

  it("never builds an image node from pasted HTML (a foreign <img> or a data: URL)", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer") });
    editor.commands.insertContent('<p>x</p><img src="https://evil.test/a.png"><img src="data:image/png;base64,AAAA">');
    expect(JSON.stringify(editor.getJSON())).not.toContain('"image"');
    editor.destroy();
  });

  it("has the image node in the document preset too (the Notice board takes images, #496), and still builds none from pasted HTML", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("document") });
    expect(editor.schema.nodes.image).toBeDefined();
    editor.commands.insertContent('<p>x</p><img src="https://evil.test/a.png">');
    expect(JSON.stringify(editor.getJSON())).not.toContain('"image"');
    editor.destroy();
  });
});

describe("inserting an image", () => {
  it("uploads the chosen file and inserts the node only after the server accepts it", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const host = mount(<Harness />);
    await choose(host, [png()]);
    expect(upload).toHaveBeenCalledWith({ projectId: "p1" }, expect.any(File), expect.any(Function), { signal: expect.any(AbortSignal), onPhase: expect.any(Function) });
    expect(uploadingNow).toBe(true);
    expect(host.querySelector('[data-testid="rich-text-upload-tray"]')?.textContent).toContain("Uploading a.png");
    expect(JSON.stringify(latest)).not.toContain('"image"');
    await act(async () => { finish(A); }); await settle();
    expect(latest.content.some((node) => node.type === "image" && node.attrs.mediaId === A)).toBe(true);
    expect(uploadingNow).toBe(false);
    expect(host.querySelector('[data-testid="rich-text-upload-tray"]')).toBeNull();
    expect(host.querySelector(`img[data-media-id="${A}"]`)?.getAttribute("src")).toBe(`/media/embedded/${A}`);
  });

  it("inserts the node with the file name, cleaned, as its alt text (#553)", async () => {
    upload.mockResolvedValue(A);
    const host = mount(<Harness />);
    await choose(host, [png("IMG_1234.HEIC")]); await settle();
    expect(latest.content.find((node) => node.type === "image")).toEqual({ type: "image", attrs: { mediaId: A, alt: "IMG 1234" } });
    expect(host.querySelector(`img[data-media-id="${A}"]`)?.getAttribute("alt")).toBe("IMG 1234");
  });

  it("stores no alt when the file name leaves nothing readable, and the image falls back to a generic one (#553)", async () => {
    upload.mockResolvedValue(A);
    const host = mount(<Harness />);
    await choose(host, [png(".png")]); await settle();
    expect(latest.content.find((node) => node.type === "image")).toEqual({ type: "image", attrs: { mediaId: A } });
    expect(host.querySelector(`img[data-media-id="${A}"]`)?.getAttribute("alt")).toBe("Embedded image");
  });

  it("lets an image be dragged by itself: the image is the drag handle, the Alt text control is not, and the node stays draggable (#553)", async () => {
    const host = mount(<Harness initial={withImages(A)} />); await settle();
    const editor = (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
    expect(editor.schema.nodes.image!.spec.draggable).toBe(true);
    const image = host.querySelector<HTMLElement>(`img[data-media-id="${A}"]`)!;
    expect(image.hasAttribute("data-drag-handle")).toBe(true);
    expect(image.className).toContain("cursor-grab");
    let imagePos = -1; editor.state.doc.descendants((node, pos) => { if (node.type.name === "image") imagePos = pos; });
    await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, imagePos))); }); await settle();
    const button = host.querySelector<HTMLElement>('[data-testid="embedded-image-alt-button"]')!;
    expect(button.hasAttribute("data-drag-handle")).toBe(false);
    expect(button.closest("[data-drag-handle]")).toBeNull();
  });

  it.each([false, true])("moves a dragged image: dragstart makes a move of the node selection, and dropping it leaves exactly one image, node already selected: %s (#553)", async (preselected) => {
    const para = (text: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text }] });
    const host = mount(<Harness initial={{ type: "doc", content: [para("One"), { type: "image", attrs: { mediaId: A } }, para("Two")] }} />); await settle();
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const editor = (surface as unknown as { editor: Editor }).editor;
    const images = () => { let n = 0; editor.state.doc.descendants((node) => { if (node.type.name === "image") n += 1; }); return n; };
    expect(images()).toBe(1);
    if (preselected) { let at = -1; editor.state.doc.descendants((node, pos) => { if (node.type.name === "image") at = pos; }); await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at))); }); await settle(); }
    const store = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => { store.set(type, value); }, getData: (type: string) => store.get(type) ?? "", setDragImage: () => undefined, clearData: () => { store.clear(); }, effectAllowed: "", dropEffect: "move", files: [], types: [] as string[] };
    const image = host.querySelector<HTMLElement>(`img[data-media-id="${A}"]`)!;
    // A browser mouses down on the handle first (Tiptap records "dragging started" there; ProseMirror selects the node).
    await act(async () => { image.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); }); await settle();
    const start = new Event("dragstart", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    start.dataTransfer = dataTransfer;
    await act(async () => { image.dispatchEvent(start); }); await settle();
    const dragging = (editor.view as unknown as { dragging: { move: boolean; slice: { content: { childCount: number } } } | null }).dragging;
    expect(dragging?.move).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    // Release below the second paragraph, as a browser would report it.
    let end = 0; editor.state.doc.forEach((node, offset) => { end = offset + node.nodeSize; });
    const view = editor.view; const original = view.posAtCoords.bind(view);
    view.posAtCoords = () => ({ pos: end, inside: -1 }) as ReturnType<typeof original>;
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown; clientX?: number; clientY?: number };
    drop.dataTransfer = { ...dataTransfer, dropEffect: "move" }; drop.clientX = 1; drop.clientY = 1;
    await act(async () => { surface.dispatchEvent(drop); }); await settle();
    view.posAtCoords = original;
    // A browser ends every drag with dragend; Tiptap tracks the source editor until then.
    await act(async () => { window.dispatchEvent(new Event("dragend")); });
    expect(images()).toBe(1);
    expect(editor.state.doc.lastChild?.type.name).toBe("image");
    expect(latest.content.filter((node) => node.type === "image")).toHaveLength(1);
    expect(host.querySelectorAll(`img[data-media-id="${A}"]`)).toHaveLength(1);
  });

  it("edits the alt text from a control on the selected image, and the node carries the new text (#553)", async () => {
    const host = mount(<Harness initial={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }, { type: "image", attrs: { mediaId: A, alt: "IMG 1234" } }] }} />);
    const editor = (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
    expect(host.querySelector('[data-testid="embedded-image-alt-button"]')).toBeNull();
    let imagePos = -1; editor.state.doc.descendants((node, pos) => { if (node.type.name === "image") imagePos = pos; });
    await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, imagePos))); }); await settle();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image-alt-button"]')!.click(); }); await settle();
    const input = document.querySelector<HTMLInputElement>('[data-testid="embedded-image-alt-popover"] input')!;
    expect(document.querySelector('[data-testid="embedded-image-alt-popover"] label')?.textContent).toBe("Alt text");
    expect(document.querySelector('[data-testid="embedded-image-alt-popover"] label')?.getAttribute("for")).toBe(input.id);
    expect(input.value).toBe("IMG 1234"); expect(input.maxLength).toBe(200);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  Front door  "); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Apply alt text"]')!.click(); }); await settle();
    expect(latest.content.find((node) => node.type === "image")).toEqual({ type: "image", attrs: { mediaId: A, alt: "Front door" } });
    expect(host.querySelector(`img[data-media-id="${A}"]`)?.getAttribute("alt")).toBe("Front door");
    expect(() => parseRichTextDoc(latest, COMMENT_MEDIA_RICH_TEXT_PROFILE)).not.toThrow();
    // Clearing it drops the attribute and the image falls back to the generic name.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image-alt-button"]')!.click(); }); await settle();
    const again = document.querySelector<HTMLInputElement>('[data-testid="embedded-image-alt-popover"] input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(again, ""); again.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Apply alt text"]')!.click(); }); await settle();
    expect(latest.content.find((node) => node.type === "image")).toEqual({ type: "image", attrs: { mediaId: A } });
  });

  it("shows an error, inserts nothing and releases the busy state when the upload fails", async () => {
    upload.mockRejectedValue(new Error("Upload service is down"));
    const host = mount(<Harness />);
    await choose(host, [png()]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("a.png could not be uploaded: Upload service is down");
    expect(JSON.stringify(latest)).not.toContain('"image"');
    expect(uploadingNow).toBe(false);
  });

  it("refuses a non-image, an oversize file and an 11th image without calling the server", async () => {
    const host = mount(<Harness initial={withImages(A, B, ...Array.from({ length: 8 }, (_, index) => `33333333-3333-4333-8333-33333333333${index}`))} />);
    await choose(host, [new File(["x"], "doc.pdf", { type: "application/pdf" }), png("big.png", 25 * 1024 * 1024 + 1), png("eleventh.png")]);
    expect(upload).not.toHaveBeenCalled();
    const alerts = Array.from(host.querySelectorAll('[role="alert"]')).map((node) => node.textContent);
    expect(alerts[0]).toContain("not a JPEG, PNG or WebP"); expect(alerts[1]).toContain("larger than 25 MB"); expect(alerts[2]).toContain("10 images and videos at most");
  });

  it("does not offer images when the editor has no media target", () => {
    const host = mount(<Harness media={false} />);
    expect(insertButton(host)).toBeNull();
  });

  it("uploads a pasted image and swallows a dropped non-image so the browser does not navigate", async () => {
    upload.mockResolvedValue(A);
    const host = mount(<Harness />);
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    paste.clipboardData = { files: [png("pasted.png")], getData: () => "", types: ["Files"] };
    await act(async () => { surface.dispatchEvent(paste); }); await settle();
    expect(upload).toHaveBeenCalledTimes(1); expect(paste.defaultPrevented).toBe(true);
    // jsdom has no layout: give ProseMirror a position for the drop, as a browser would.
    const doc = document as Document & { elementFromPoint: (x: number, y: number) => Element | null; caretPositionFromPoint?: unknown };
    doc.elementFromPoint = () => surface; doc.caretPositionFromPoint = () => ({ offsetNode: surface.firstChild ?? surface, offset: 0 }) as unknown as CaretPosition;
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    drop.dataTransfer = { files: [new File(["x"], "a.zip", { type: "application/zip" })], types: ["Files"], getData: () => "" };
    await act(async () => { surface.dispatchEvent(drop); }); await settle();
    expect(upload).toHaveBeenCalledTimes(1); expect(drop.defaultPrevented).toBe(true);
  });
});

const textDoc = (text: string): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;

describe("where an uploaded image lands", () => {
  it("goes where the upload started, never over a selection made while it ran", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const host = mount(<Harness initial={textDoc("Hello world")} />);
    const editor = tiptapOf(host);
    await act(async () => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
    await choose(host, [png()]);
    // The user selects text to copy while the file uploads.
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    await act(async () => { finish(A); }); await settle();
    expect(latest.content[0]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "Hello world" }] });
    expect(latest.content.some((node) => node.type === "image" && node.attrs.mediaId === A)).toBe(true);
  });

  it("follows the text it was beside when the document changes before the upload ends", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const host = mount(<Harness initial={textDoc("Hello")} />);
    const editor = tiptapOf(host);
    await act(async () => { editor.commands.setTextSelection(1 + "Hello".length); });
    await choose(host, [png()]);
    await act(async () => { editor.commands.insertContentAt(1, "XX"); });
    await act(async () => { finish(A); }); await settle();
    expect(latest.content[0]).toMatchObject({ content: [{ type: "text", text: "XXHello" }] });
    expect(latest.content.map((node) => node.type)).toEqual(["paragraph", "image"]);
  });
});

describe("saving while an image uploads", () => {
  it("does not submit on Ctrl/Cmd+Enter until the upload has finished", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const onSubmit = vi.fn();
    const host = mount(<Harness initial={textDoc("Hi")} onSubmit={onSubmit} />);
    await choose(host, [png()]);
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await act(async () => { surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => { finish(A); }); await settle();
    await act(async () => { surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a cancelled editor's late upload cannot clear the busy flag of the editor that replaced it", async () => {
    const finishers: Array<(id: string) => void> = [];
    upload.mockImplementation(() => new Promise<string>((resolve) => { finishers.push(resolve); }));
    const host = mount(<Harness key="first" />);
    await choose(host, [png("a.png")]);
    expect(uploadingNow).toBe(true);
    // Cancel (unmount) and reopen (a fresh editor), then start another upload.
    await act(async () => { root!.render(<Harness key="second" />); }); await settle();
    await choose(host, [png("b.png")]);
    expect(uploadingNow).toBe(true);
    await act(async () => { finishers[0]!(A); }); await settle();
    expect(uploadingNow).toBe(true);
    await act(async () => { finishers[1]!(B); }); await settle();
    expect(uploadingNow).toBe(false);
  });
});

describe("a posted image", () => {
  it("renders lazily from the media route and opens the larger view in a dialog", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    const image = host.querySelector<HTMLImageElement>('[data-testid="embedded-image"] img')!;
    expect(image.getAttribute("src")).toBe(`/media/embedded/${A}`); expect(image.getAttribute("loading")).toBe("lazy");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!.click(); });
    await settle();
    expect(document.querySelector('[data-testid="embedded-image-dialog"] img')?.getAttribute("src")).toBe(`/media/embedded/${A}`);
  });

  it("says so when the image cannot be loaded", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    await act(async () => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector('[data-testid="embedded-image-unavailable"]')?.textContent).toBe("Image unavailable");
  });
});

describe("design review fixes (#493)", () => {
  const appCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles/app.css"), "utf8");
  const rule = (selector: string) => appCss.split("\n").find((line) => line.startsWith(selector)) ?? "";

  it("puts the thumbnail's vertical margin on the button, so the focus ring does not wrap it, and none on the image inside", () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    expect(imageSource).toMatch(/data-testid="embedded-image"[\s\S]{0,240}my-\[var\(--space-2\)\]/);
    expect(host.querySelector('[data-testid="embedded-image"]')).not.toBeNull();
    expect(rule(".rich-text__embedded-image {")).toMatch(/margin: 0[;\s]/);
    expect(rule(".rich-text__embedded-image-node {")).toContain("margin: var(--space-2) 0");
  });

  it("outlines the selected image with a hairline accent, not the heavy focus ring", () => {
    const selected = rule(".rich-text__editor-content .ProseMirror-selectednode .rich-text__embedded-image-node > img.rich-text__embedded-image");
    expect(selected).toContain("var(--border-width-hair)"); expect(selected).not.toContain("--ring"); expect(selected).not.toContain("--border-width-bold");
  });

  it("moves the Media group to the front of the toolbar on a phone, so Insert image is never scrolled off-screen", () => {
    const host = mount(<Harness />);
    expect(insertButton(host)).not.toBeNull();
    // The wrapper holds the separator and the group; reversed and ordered first on a phone it reads Insert image | separator | the rest.
    expect(editorSource).toMatch(/data-testid="rich-text-media-tools"[^>]*max-\[721px\]:order-first[^>]*max-\[721px\]:flex-row-reverse|data-testid="rich-text-media-tools"[^>]*max-\[721px\]:flex-row-reverse[^>]*max-\[721px\]:order-first/);
    expect(host.querySelector('[data-testid="rich-text-media-tools"] button[aria-label="Insert image"]')).not.toBeNull();
  });

  it("shows the upload percentage beside the label", async () => {
    let report!: (percent: number) => void;
    upload.mockImplementation((_p: string, _f: File, onProgress: (percent: number) => void) => { report = onProgress; return new Promise<string>(() => undefined); });
    const host = mount(<Harness />);
    await choose(host, [png()]);
    await act(async () => { report(40); });
    expect(host.querySelector('[data-testid="rich-text-upload-tray"] [data-testid="upload-progress-value"]')?.textContent).toContain("40");
  });

  it("clears an upload error when a new pick starts and when the host replaces the content (a post)", async () => {
    upload.mockRejectedValueOnce(new Error("Upload service is down")).mockImplementation(() => new Promise<string>(() => undefined));
    const host = mount(<Harness />);
    await choose(host, [png()]);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await choose(host, [png()]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears an upload error once the composer is emptied after posting", async () => {
    upload.mockRejectedValue(new Error("Upload service is down"));
    let reset!: () => void;
    function Posting() { const [value, setValue] = useState<RichTextDoc>(empty()); reset = () => setValue(withImages()); return <QuincyRichTextEditor preset="composer" value={value} onChange={setValue} limit={10_000} loadMentionables={async () => []} media={{ projectId: "p1" }} />; }
    const host = mount(<Posting />);
    await choose(host, [png()]);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { reset(); }); await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("opens the larger view on a dark, edge-to-edge stage with the close button over a scrim", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!.click(); });
    await settle();
    const dialog = document.querySelector<HTMLElement>('[data-testid="embedded-image-dialog"]')!;
    expect(dialog.getAttribute("data-surface")).toBe("inverse");
    expect(dialog.querySelector('[data-testid="embedded-image-scrim"]')).not.toBeNull();
    expect(imageSource).toMatch(/data-testid="embedded-image-dialog"/);
    expect(imageSource).toMatch(/p-0/); expect(imageSource).toMatch(/bg-background/); expect(imageSource).toMatch(/embedded-image-scrim[^>]*scrim-overlay/);
    expect(imageSource).toMatch(/max-w-\[calc\(100%-2rem\)\]/);
  });

  it("never upscales: the dialog fits the image and the image is capped at its natural size (#553)", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!.click(); });
    await settle();
    const dialog = document.querySelector<HTMLElement>('[data-testid="embedded-image-dialog"]')!;
    const classes = (element: Element) => element.getAttribute("class")!.split(/\s+/);
    expect(classes(dialog)).toContain("w-fit"); expect(classes(dialog)).not.toContain("w-full");
    const image = dialog.querySelector("img")!;
    expect(classes(image)).toEqual(expect.arrayContaining(["w-auto", "max-w-full", "h-auto", "max-h-[90dvh]"])); expect(classes(image)).not.toContain("w-full");
  });

  it("keeps a 48px close target even for a tiny image: the dialog has a token minimum in both dimensions and centres the image (#553)", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!.click(); });
    await settle();
    const dialog = document.querySelector<HTMLElement>('[data-testid="embedded-image-dialog"]')!;
    const classes = dialog.getAttribute("class")!.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["min-w-[var(--space-7)]", "min-h-[var(--space-7)]", "place-items-center"]));
    const close = dialog.querySelector<HTMLElement>('[data-testid="embedded-image-close"]')!;
    expect(close.className).toContain("size-[var(--space-7)]");
    expect(dialog.querySelector("img")!.className).not.toMatch(/min-w|min-h|(^|\s)w-full/);
  });

  it("pads the stage by the chip when the image is under twice the chip, so a tiny image stays visible beside Close (#553)", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!.click(); });
    await settle();
    const dialog = () => document.querySelector<HTMLElement>('[data-testid="embedded-image-dialog"]')!;
    const image = dialog().querySelector("img")!;
    const load = async (width: number, height: number) => {
      Object.defineProperty(image, "naturalWidth", { configurable: true, value: width }); Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
      await act(async () => { image.dispatchEvent(new Event("load")); });
    };
    expect(dialog().className).not.toContain("pt-[var(--space-7)]");
    await load(24, 24);
    expect(dialog().className).toContain("pt-[var(--space-7)]"); expect(dialog().className).toContain("pr-[var(--space-7)]");
    // The top padding comes out of the image's height cap, so a tall narrow image is not clipped by the dialog's overflow; width is a percentage of the content box, which already excludes the right padding.
    expect(image.className).toContain("max-h-[calc(90dvh-var(--space-7))]"); expect(image.className).not.toContain("max-h-[90dvh]");
    await load(600, 400);
    expect(dialog().className).not.toContain("pt-[var(--space-7)]");
    expect(image.className).toContain("max-h-[90dvh]"); expect(image.className).not.toContain("calc(90dvh");
    await load(600, 90); // short in one dimension: the chip would still cover its corner
    expect(dialog().className).toContain("pr-[var(--space-7)]");
  });

  it("draws the close focus ring inside the chip and keeps the chip's ring legible on ink (#553)", () => {
    expect(imageSource).toMatch(/embedded-image-close[^>]*outline-offset-\[-4px\][^>]*focus-visible:!outline-offset-\[-4px\]/);
    expect(imageSource).toMatch(/embedded-image-scrim[^>]*ring-\[color:var\(--border-hover\)\]/);
  });

  it("makes the close button the drawn 48px chip, with the dialog's radius and a hairline ring on the scrim (#553)", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!.click(); });
    await settle();
    const dialog = document.querySelector<HTMLElement>('[data-testid="embedded-image-dialog"]')!;
    const close = dialog.querySelector<HTMLElement>('[data-testid="embedded-image-close"]')!;
    const scrim = dialog.querySelector<HTMLElement>('[data-testid="embedded-image-scrim"]')!;
    expect(close.textContent).toBe("Close");
    for (const element of [close, scrim]) { expect(element.className).toContain("size-[var(--space-7)]"); expect(element.className).toContain("top-0"); expect(element.className).toContain("right-0"); expect(element.className).toContain("rounded-xl"); }
    expect(scrim.className).toContain("ring-[length:var(--border-width-hair)]");
    expect(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles/tokens/spacing.css"), "utf8")).toMatch(/--space-7:\s*48px/);
    // Only one close control: the dialog's built-in 28px one is off.
    expect(dialog.querySelectorAll("button")).toHaveLength(1);
  });

  it("names the thumbnail and the larger view from the author's alt text, and falls back for an image with none (#553)", async () => {
    const withAlt: RichTextDoc = { type: "doc", content: [{ type: "image", attrs: { mediaId: A, alt: "Front door at dusk" } }] };
    const host = mount(<RichTextContent content={withAlt} />);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("View image: Front door at dusk");
    expect(trigger.querySelector("img")?.getAttribute("alt")).toBe("Front door at dusk");
    await act(async () => { trigger.click(); }); await settle();
    const dialog = document.querySelector<HTMLElement>('[data-testid="embedded-image-dialog"]')!;
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("Front door at dusk");
    expect(dialog.textContent).toContain("Front door at dusk");
    act(() => root!.unmount()); document.body.innerHTML = "";
    const plain = mount(<RichTextContent content={withImages(A)} />);
    expect(plain.querySelector('[data-testid="embedded-image"]')?.getAttribute("aria-label")).toBe("View image: Embedded image");
  });

  async function openViewer(host: HTMLElement) {
    const thumbnail = host.querySelector<HTMLButtonElement>('[data-testid="embedded-image"]')!;
    // No explicit focus(): Safari and touch do not focus a button on click, so the dialog must know its trigger rather than rely on prior focus.
    await act(async () => { thumbnail.click(); });
    await settle();
    expect(document.querySelector('[data-testid="embedded-image-dialog"]')).not.toBeNull();
    return thumbnail;
  }

  it("returns focus to the thumbnail when the larger view is closed with Escape", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    const thumbnail = await openViewer(host);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle(); await settle();
    expect(document.querySelector('[data-testid="embedded-image-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(thumbnail);
  });

  it("returns focus to the thumbnail when the larger view is closed with its close button", async () => {
    const host = mount(<RichTextContent content={withImages(A)} />);
    const thumbnail = await openViewer(host);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="embedded-image-dialog"] button')!.click(); });
    await settle(); await settle();
    expect(document.querySelector('[data-testid="embedded-image-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(thumbnail);
  });

  it("keeps the error live region for screen readers but gives it no space while empty", () => {
    const host = mount(<Harness />);
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(region.textContent).toBe("");
    expect(region.classList.contains("sr-only")).toBe(true);
    expect(region.classList.contains("min-h-[1.2em]")).toBe(false);
  });
});

describe("an upload that lands while the author is composing", () => {
  it("keeps the image when the author types on after it lands (a finished upload must not select it)", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const typed: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "QA 547 repro" }] }] };
    const host = mount(<Harness initial={typed} />);
    const editor = tiptapOf(host);
    act(() => { editor.commands.focus("end"); });
    // Paste goes through the same addImagesRef path as the toolbar picker and drop.
    act(() => { const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }; event.clipboardData = { files: [png()], getData: () => "", types: ["Files"] }; editor.view.dom.dispatchEvent(event); });
    await act(async () => { finish(A); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(latest.content.some((node) => node.type === "image")).toBe(true);
    // Tiptap's insertContentAt selects inserted content by default: a NodeSelection on the new atom means the next keystroke replaces it.
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    // What ProseMirror does with the author's next keystroke: insert at the current selection.
    act(() => { editor.view.dispatch(editor.view.state.tr.insertText(" ok")); });
    expect(latest.content.filter((node) => node.type === "image")).toHaveLength(1);
    expect(JSON.stringify(latest)).toContain("QA 547 repro ok");
  });
});

describe("upload problems while sibling uploads land (#494)", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `44444444-4444-4444-8444-44444444444${index === 9 ? "a" : index}`);
  async function pasteEleven() {
    const resolvers: Array<(id: string) => void> = [];
    upload.mockImplementation(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const host = mount(<Harness />);
    const editor = tiptapOf(host);
    act(() => { editor.commands.focus("end"); });
    act(() => { const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }; event.clipboardData = { files: Array.from({ length: 11 }, (_, index) => png(`p${index}.png`)), getData: () => "", types: ["Files"] }; editor.view.dom.dispatchEvent(event); });
    await settle();
    expect(resolvers).toHaveLength(10);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("10 images and videos at most");
    return { host, editor, resolvers };
  }

  it("keeps the cap message visible after the sibling uploads' own insertions land", async () => {
    const { host, resolvers } = await pasteEleven();
    for (const [index, resolve] of resolvers.entries()) { await act(async () => { resolve(ids[index]!); }); await settle(); }
    expect(latest.content.filter((node) => node.type === "image")).toHaveLength(10);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("10 images and videos at most");
  });

  it("still clears the message on the author's next edit", async () => {
    const { host, editor, resolvers } = await pasteEleven();
    for (const [index, resolve] of resolvers.entries()) { await act(async () => { resolve(ids[index]!); }); await settle(); }
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    act(() => { editor.view.dispatch(editor.view.state.tr.insertText("x")); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});


const HEIC_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
// Safari and Chrome often report no type at all for a HEIC, so the name is what identifies it.
const heic = (name = "IMG_1.HEIC") => new File([new Uint8Array(100)], name, { type: "" });
const tray = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="rich-text-upload-tray"]');
const trayButton = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
const imageCount = (id: string) => latest.content.filter((node) => node.type === "image" && node.attrs.mediaId === id).length;
function mountWithSetting(ui: React.ReactElement) { return mount(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>); }
type Drive = { phase: (phase: "preparing", mediaId: string) => void; finish: (id: string) => void; fail: (reason: unknown) => void; signal: AbortSignal };
function driveUpload(): Drive {
  const drive = {} as Drive;
  upload.mockImplementation((_scope: unknown, _file: File, _progress: unknown, options: { onPhase: Drive["phase"]; signal: AbortSignal }) => {
    drive.phase = options.onPhase; drive.signal = options.signal;
    return new Promise<string>((resolve, reject) => { drive.finish = resolve; drive.fail = reject; });
  });
  return drive;
}

describe("HEIC images (#495)", () => {
  // The paste handler reads the HEIC setting synchronously from the rendered editor. With react-query's default
  // scheduler the observer->React notification is its own setTimeout(0), registered after `settle()`'s, so one
  // settle() tick could end before the editor rendered the fetched setting and the paste was refused (#576).
  // A synchronous scheduler makes "the query resolved inside the act" and "the editor rendered it" one event.
  beforeEach(() => { notifyManager.setScheduler((callback) => callback()); });
  afterEach(() => { notifyManager.setScheduler(defaultScheduler); });

  it("offers HEIC in the picker only once the setting is on, and sends a HEIC with no reported type", async () => {
    heicSetting.mockResolvedValue(true); upload.mockResolvedValue(A);
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0]![1] as File).name).toBe("IMG_1.HEIC");
  });

  it("refuses a pasted HEIC with the unsupported-type message when the setting is off, without uploading", async () => {
    const host = mountWithSetting(<Harness />); await settle();
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    paste.clipboardData = { files: [heic()], getData: () => "", types: ["Files"] };
    await act(async () => { surface.dispatchEvent(paste); }); await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("is not a JPEG, PNG or WebP image");
  });

  it("accepts a pasted HEIC once the setting is on", async () => {
    heicSetting.mockResolvedValue(true); upload.mockResolvedValue(A);
    const host = mountWithSetting(<Harness />); await settle();
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    paste.clipboardData = { files: [heic("shot.heif")], getData: () => "", types: ["Files"] };
    await act(async () => { surface.dispatchEvent(paste); }); await settle();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("goes uploading, then preparing, then inserts the image exactly once when it is ready", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    expect(tray(host)?.textContent).toContain("Uploading IMG_1.HEIC");
    await act(async () => { drive.phase("preparing", A); });
    expect(tray(host)?.textContent).toContain("Preparing IMG_1.HEIC…");
    expect(tray(host)?.querySelector('[role="progressbar"]')).toBeNull();
    expect(trayButton(host, "Remove")).toBeDefined();
    expect(uploadingNow).toBe(true); expect(imageCount(A)).toBe(0);
    await act(async () => { drive.finish(A); }); await settle();
    expect(imageCount(A)).toBe(1);
    expect(uploadingNow).toBe(false); expect(tray(host)).toBeNull();
  });

  it("shows Retry and Remove when preparing fails, and a Retry that ends ready inserts the image", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    let retried!: { finish: (id: string) => void; options: { onPhase: Drive["phase"]; signal: AbortSignal } };
    retryRendition.mockImplementation((_scope: unknown, _id: string, options: { onPhase: Drive["phase"]; signal: AbortSignal }) => new Promise<string>((resolve) => { retried = { finish: resolve, options }; }));
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    await act(async () => { drive.fail(new RenditionFailedError(A)); }); await settle();
    expect(tray(host)?.textContent).toContain("Couldn't prepare IMG_1.HEIC");
    expect(host.querySelector('[data-testid="rich-text-upload-tray"] [role="alert"]')).not.toBeNull();
    expect(trayButton(host, "Retry")).toBeDefined(); expect(trayButton(host, "Remove")).toBeDefined();
    expect(uploadingNow).toBe(true); expect(imageCount(A)).toBe(0);
    await act(async () => { trayButton(host, "Retry")!.click(); }); await settle();
    expect(retryRendition).toHaveBeenCalledWith({ projectId: "p1" }, A, { signal: drive.signal, onPhase: expect.any(Function) });
    expect(tray(host)?.textContent).toContain("Preparing IMG_1.HEIC…");
    await act(async () => { retried.finish(A); }); await settle();
    expect(imageCount(A)).toBe(1); expect(uploadingNow).toBe(false); expect(tray(host)).toBeNull();
  });

  it("Remove while preparing stops the polling, tells the server to abort the Project upload, and inserts nothing", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    await act(async () => { trayButton(host, "Remove")!.click(); }); await settle();
    expect(drive.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/p1/embedded-media/${A}/abort`, expect.objectContaining({ method: "POST" }));
    expect(tray(host)).toBeNull(); expect(uploadingNow).toBe(false); expect(imageCount(A)).toBe(0);
  });

  it("the preparing row shows a spinner status, not an empty progress track", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload(); vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    const status = tray(host)!.querySelector<HTMLElement>('[role="status"][aria-label="Preparing IMG_1.HEIC"]');
    expect(status).not.toBeNull();
    expect(status!.querySelector("svg")).not.toBeNull();
    expect(status!.textContent).toContain("Preparing IMG_1.HEIC…");
    expect(tray(host)!.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("Retry moves focus to the new preparing row's Remove button", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    retryRendition.mockImplementation(() => new Promise<string>(() => undefined)); vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    await act(async () => { drive.fail(new RenditionFailedError(A)); }); await settle();
    const retry = trayButton(host, "Retry")!; retry.focus(); expect(document.activeElement).toBe(retry);
    await act(async () => { retry.click(); }); await settle();
    expect(document.activeElement).toBe(trayButton(host, "Remove")); expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove IMG_1.HEIC");
  });

  it("Remove on a preparing row, and on a failed row, moves focus to the editor", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const host = mountWithSetting(<Harness />); await settle();
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    const remove = trayButton(host, "Remove")!; remove.focus(); expect(document.activeElement).toBe(remove);
    await act(async () => { remove.click(); }); await settle();
    expect(tray(host)).toBeNull(); expect(document.activeElement).toBe(surface);
    const second = driveUpload();
    await choose(host, [heic("IMG_2.HEIC")], { accept: HEIC_ACCEPT });
    await act(async () => { second.phase("preparing", B); });
    await act(async () => { second.fail(new RenditionFailedError(B)); }); await settle();
    const failedRemove = trayButton(host, "Remove")!; failedRemove.focus(); expect(document.activeElement).toBe(failedRemove);
    await act(async () => { failedRemove.click(); }); await settle();
    expect(tray(host)).toBeNull(); expect(document.activeElement).toBe(surface);
  });

  it("Remove on a failed row aborts the upload too", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    await act(async () => { drive.fail(new RenditionFailedError(A)); }); await settle();
    await act(async () => { trayButton(host, "Remove")!.click(); }); await settle();
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/p1/embedded-media/${A}/abort`, expect.objectContaining({ method: "POST" }));
    expect(tray(host)).toBeNull(); expect(uploadingNow).toBe(false);
  });

  it("unmounting while preparing stops the polling and aborts the Project upload", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    const host = mountWithSetting(<Harness />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    act(() => root!.unmount()); root = null;
    expect(drive.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/p1/embedded-media/${A}/abort`, expect.objectContaining({ method: "POST" }));
  });

  it("counts a preparing upload toward the per-post cap", async () => {
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 }))); // the unmount abort
    const host = mountWithSetting(<Harness initial={withImages(...Array.from({ length: 9 }, (_, index) => `33333333-3333-4333-8333-33333333333${index}`))} />); await settle();
    await choose(host, [heic()], { accept: HEIC_ACCEPT });
    await act(async () => { drive.phase("preparing", A); });
    await choose(host, [png("eleventh.png")], { accept: HEIC_ACCEPT });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="rich-text-upload-tray"] [role="alert"]')?.textContent).toContain("10 images and videos at most");
  });

  it("says it is taking a while once a HEIC has been preparing for 60 seconds", async () => {
    vi.useFakeTimers();
    heicSetting.mockResolvedValue(true); const drive = driveUpload();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 }))); // the unmount abort
    const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const host = mountWithSetting(<Harness />); await tick();
    await choose(host, [heic()], { accept: HEIC_ACCEPT, tick });
    await act(async () => { drive.phase("preparing", A); });
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(tray(host)?.textContent).toContain("Preparing IMG_1.HEIC…"); expect(tray(host)?.textContent).not.toContain("Still preparing");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(tray(host)?.textContent).toContain("Still preparing IMG_1.HEIC… this can take a few minutes");
  });
});
