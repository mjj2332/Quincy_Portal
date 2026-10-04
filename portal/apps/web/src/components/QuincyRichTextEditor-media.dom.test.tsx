import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
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
function Harness({ initial = empty(), media = true }: { initial?: RichTextDoc; media?: boolean }) {
  const [value, setValue] = useState(initial);
  return <QuincyRichTextEditor preset="composer" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} {...(media ? { media: { projectId: "p1" } } : {})} onUploadingChange={(busy) => { uploadingNow = busy; }} />;
}
function mount(ui: React.ReactElement) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(ui)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const insertButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Insert image"]');
// The picker is a native input made on click: capture it, give it the files, and fire its change.
async function choose(host: HTMLElement, files: File[]) {
  const made: HTMLInputElement[] = [];
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { made.push(this); });
  await act(async () => { insertButton(host)!.click(); });
  click.mockRestore();
  const picker = made[0]!;
  expect(picker.type).toBe("file"); expect(picker.accept).toBe("image/jpeg,image/png,image/webp"); expect(picker.multiple).toBe(true);
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change")); });
  await settle();
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

  it("has no image node in the document preset (the Notice board stays text)", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("document") });
    expect(editor.schema.nodes.image).toBeUndefined();
    editor.destroy();
  });
});

describe("inserting an image", () => {
  it("uploads the chosen file and inserts the node only after the server accepts it", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const host = mount(<Harness />);
    await choose(host, [png()]);
    expect(upload).toHaveBeenCalledWith("p1", expect.any(File), expect.any(Function));
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
