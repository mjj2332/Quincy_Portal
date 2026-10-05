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
import { COMMENT_MEDIA_RICH_TEXT_PROFILE, parseRichTextDoc, type RichTextDoc } from "@quincy/shared";
import { createRichTextEditorExtensions, tiptapToRichTextDoc, toTiptap } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { RichTextContent } from "./RichTextContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const upload = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: upload }));

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
async function choose(host: HTMLElement, files: File[]) {
  expect(host.querySelector('input[type="file"]')).toBeNull();
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { insertButton(host)!.click(); });
  click.mockRestore();
  const picker = host.querySelector<HTMLInputElement>('input[data-testid="rich-text-image-picker"]')!;
  expect(picker.accept).toBe("image/jpeg,image/png,image/webp"); expect(picker.multiple).toBe(true);
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(host.querySelector('input[type="file"]')).toBeNull();
}

beforeEach(() => { latest = empty(); uploadingNow = false; upload.mockReset(); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

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
    expect(upload).toHaveBeenCalledWith({ projectId: "p1" }, expect.any(File), expect.any(Function));
    expect(uploadingNow).toBe(true);
    expect(host.querySelector('[data-testid="rich-text-upload-tray"]')?.textContent).toContain("Uploading a.png");
    expect(JSON.stringify(latest)).not.toContain('"image"');
    await act(async () => { finish(A); }); await settle();
    expect(latest.content.some((node) => node.type === "image" && node.attrs.mediaId === A)).toBe(true);
    expect(uploadingNow).toBe(false);
    expect(host.querySelector('[data-testid="rich-text-upload-tray"]')).toBeNull();
    expect(host.querySelector(`img[data-media-id="${A}"]`)?.getAttribute("src")).toBe(`/media/embedded/${A}`);
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
    expect(alerts[0]).toContain("not a JPEG, PNG or WebP"); expect(alerts[1]).toContain("larger than 25 MB"); expect(alerts[2]).toContain("10 images at most");
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
    expect(rule(".rich-text__editor-content img.rich-text__embedded-image {")).toContain("margin: var(--space-2) 0");
  });

  it("outlines the selected image with a hairline accent, not the heavy focus ring", () => {
    const selected = rule(".rich-text__editor-content img.rich-text__embedded-image.ProseMirror-selectednode");
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
