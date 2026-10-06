import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const uploadVideo = vi.hoisted(() => vi.fn());
const uploadImage = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedVideo: uploadVideo, uploadEmbeddedImage: uploadImage }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const withVideos = (...ids: string[]): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }, ...ids.map((mediaId) => ({ type: "video" as const, attrs: { mediaId } }))] });
const mp4 = (name = "a.mp4", size = 100) => new File([new Uint8Array(size)], name, { type: "video/mp4" });
const png = (name = "a.png", size = 100) => new File([new Uint8Array(size)], name, { type: "image/png" });

let root: Root | null = null;
let latest: RichTextDoc = empty();
let uploadingNow = false;
function Harness({ initial = empty(), media = { projectId: "p1" } as { projectId: string } | { noticeBoard: true } | null, preset = "composer" as "composer" | "document" }: { initial?: RichTextDoc; media?: { projectId: string } | { noticeBoard: true } | null; preset?: "composer" | "document" }) {
  const [value, setValue] = useState(initial);
  return <QuincyRichTextEditor preset={preset} value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} {...(media ? { media } : {})} onUploadingChange={(busy) => { uploadingNow = busy; }} />;
}
function mount(ui: React.ReactElement) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(ui)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const insertVideo = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Insert video"]');
async function choose(host: HTMLElement, files: File[], button: "Insert video" | "Insert image" = "Insert video") {
  expect(host.querySelector('input[type="file"]')).toBeNull();
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${button}"]`)!.click(); });
  click.mockRestore();
  const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(host.querySelector('input[type="file"]')).toBeNull();
}
const beforeUnload = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event; };
const tray = (host: HTMLElement) => host.querySelector('[data-testid="rich-text-upload-tray"]');
const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;

beforeEach(() => { latest = empty(); uploadingNow = false; uploadVideo.mockReset(); uploadImage.mockReset(); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the video node's stored contract (#494)", () => {
  it("round-trips through Tiptap, keeps only the media id, and parses under the comment media profile", () => {
    const stored = withVideos(A, B);
    expect(tiptapToRichTextDoc(toTiptap(stored))).toEqual(stored);
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: toTiptap(stored) });
    const out = tiptapToRichTextDoc(editor.getJSON());
    expect(out).toEqual(stored); expect(() => parseRichTextDoc(out, COMMENT_MEDIA_RICH_TEXT_PROFILE)).not.toThrow();
    editor.destroy();
  });

  it("a posted video omits `poster` when the server says it has none, and keeps it otherwise (#556)", () => {
    const flagged = (hasPoster?: boolean): RichTextDoc => ({ type: "doc", content: [{ type: "video", attrs: { mediaId: A, ...(hasPoster === undefined ? {} : { hasPoster }) } }] });
    expect(mount(<RichTextContent content={flagged(false)} />).querySelector("video")!.hasAttribute("poster")).toBe(false);
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(mount(<RichTextContent content={flagged(true)} />).querySelector("video")!.getAttribute("poster")).toBe(`/media/embedded/${A}/poster`);
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(mount(<RichTextContent content={flagged()} />).querySelector("video")!.getAttribute("poster")).toBe(`/media/embedded/${A}/poster`);
  });

  it("renders in the editor as a muted inline-playing preview with the poster and no controls, addressed by id only", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: toTiptap(withVideos(A)) });
    const element = editor.view.dom.querySelector<HTMLVideoElement>("video")!;
    expect(element.getAttribute("data-media-id")).toBe(A);
    expect(element.getAttribute("src")).toBe(`/media/embedded/${A}`); expect(element.getAttribute("poster")).toBe(`/media/embedded/${A}/poster`);
    expect(element.getAttribute("preload")).toBe("metadata"); expect(element.hasAttribute("muted")).toBe(true); expect(element.hasAttribute("playsinline")).toBe(true);
    expect(element.hasAttribute("controls")).toBe(false);
    editor.destroy();
  });

  it("never builds a video node from pasted HTML, and the Notice board's document preset has no video node at all", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer") });
    editor.commands.insertContent('<p>x</p><video src="https://evil.test/a.mp4"></video><video><source src="data:video/mp4;base64,AAAA"></video>');
    expect(JSON.stringify(editor.getJSON())).not.toContain('"video"');
    editor.destroy();
    const notice = new Editor({ extensions: createRichTextEditorExtensions("document") });
    expect(notice.schema.nodes.video).toBeUndefined();
    notice.destroy();
  });
});

describe("Insert video (#494)", () => {
  it("is a toolbar button beside Insert image in the Media group, and the picker takes MP4 and MOV", async () => {
    const host = mount(<Harness />);
    expect(host.querySelector('[data-testid="rich-text-media-tools"] button[aria-label="Insert video"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rich-text-media-tools"] button[aria-label="Insert image"]')).not.toBeNull();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { insertVideo(host)!.click(); }); click.mockRestore();
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker.accept.split(",")).toEqual(expect.arrayContaining(["video/mp4", "video/quicktime", ".mp4", ".mov"])); expect(picker.accept).not.toContain("image/");
    expect(picker.multiple).toBe(true);
  });

  it("keeps the image picker to images", async () => {
    const host = mount(<Harness />);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Insert image"]')!.click(); }); click.mockRestore();
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toBe("image/jpeg,image/png,image/webp");
  });

  it("is offered in a Project's discussion only: not on the Notice board, and not without a media target", () => {
    expect(insertVideo(mount(<Harness media={{ noticeBoard: true }} preset="document" />))).toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(insertVideo(mount(<Harness media={null} />))).toBeNull();
  });

  it("uploads the chosen video with a cancel signal and progress, and inserts the node only after the server accepts it", async () => {
    let finish!: (id: string) => void; let report!: (percent: number) => void;
    uploadVideo.mockImplementation((_project: string, _file: File, options: { onProgress: (percent: number) => void }) => { report = options.onProgress; return new Promise<string>((resolve) => { finish = resolve; }); });
    const host = mount(<Harness />);
    await choose(host, [mp4()]);
    expect(uploadVideo).toHaveBeenCalledWith("p1", expect.any(File), { signal: expect.any(AbortSignal), onProgress: expect.any(Function), onPoster: expect.any(Function) });
    expect(uploadingNow).toBe(true); expect(tray(host)?.textContent).toContain("Uploading a.mp4");
    expect(JSON.stringify(latest)).not.toContain('"video"');
    await act(async () => { report(40); });
    expect(host.querySelector('[data-testid="rich-text-upload-tray"] [data-testid="upload-progress-value"]')?.textContent).toContain("40");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    await act(async () => { finish(A); }); await settle();
    expect(latest.content.some((node) => node.type === "video" && node.attrs.mediaId === A)).toBe(true);
    expect(uploadingNow).toBe(false); expect(tray(host)).toBeNull();
    expect(host.querySelector(`video[data-media-id="${A}"]`)).not.toBeNull();
  });

  it("shows a Video badge over the composer node, and leaves `poster` off a video the server kept no poster for (#556)", async () => {
    uploadVideo.mockImplementation(async (_project: string, _file: File, options: { onPoster: (stored: boolean) => void }) => { options.onPoster(false); return A; });
    const host = mount(<Harness />);
    await choose(host, [mp4()]);
    const video = host.querySelector<HTMLVideoElement>(`video[data-media-id="${A}"]`)!;
    expect(video.hasAttribute("poster")).toBe(false);
    expect(host.querySelector('[data-testid="embedded-video-badge"]')?.textContent).toBe("Video");
    expect(latest.content.find((node) => node.type === "video")).toEqual({ type: "video", attrs: { mediaId: A, hasPoster: false } });
  });

  it("asks for the poster of a video the server did keep one for, and of an older node with no flag (#556)", async () => {
    uploadVideo.mockImplementation(async (_project: string, _file: File, options: { onPoster: (stored: boolean) => void }) => { options.onPoster(true); return A; });
    const host = mount(<Harness initial={withVideos(B)} />);
    await choose(host, [mp4()]);
    expect(host.querySelector(`video[data-media-id="${A}"]`)?.getAttribute("poster")).toBe(`/media/embedded/${A}/poster`);
    expect(host.querySelector(`video[data-media-id="${B}"]`)?.getAttribute("poster")).toBe(`/media/embedded/${B}/poster`);
  });

  it("keeps the poster flag in a local draft, never in the stored document", () => {
    const flagged = toTiptap({ type: "doc", content: [{ type: "video", attrs: { mediaId: A, hasPoster: false } }] });
    expect(tiptapToRichTextDoc(flagged).content[0]).toEqual({ type: "video", attrs: { mediaId: A } });
    expect(tiptapToRichTextDoc(flagged, { keepPreviewDisplay: true }).content[0]).toEqual({ type: "video", attrs: { mediaId: A, hasPoster: false } });
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "video", attrs: { mediaId: A, hasPoster: false } }] }, COMMENT_MEDIA_RICH_TEXT_PROFILE)).not.toThrow();
  });

  it("refuses a non-video, an oversize file and an 11th item without calling the server, saying what is wrong", async () => {
    const host = mount(<Harness initial={withVideos(A, B, ...Array.from({ length: 8 }, (_, index) => `33333333-3333-4333-8333-33333333333${index}`))} />);
    await choose(host, [new File(["x"], "a.webm", { type: "video/webm" }), { name: "big.mp4", type: "video/mp4", size: 1024 ** 3 + 1, slice: () => new Blob() } as unknown as File, mp4("eleventh.mp4")]);
    expect(uploadVideo).not.toHaveBeenCalled();
    const alerts = Array.from(host.querySelectorAll('[role="alert"]')).map((node) => node.textContent);
    expect(alerts[0]).toContain("not an MP4 or MOV"); expect(alerts[1]).toContain("larger than 1 GB"); expect(alerts[2]).toContain("10 images and videos at most");
  });

  it("counts images and videos against one shared ten, including uploads still running", async () => {
    uploadVideo.mockImplementation(() => new Promise<string>(() => undefined));
    const host = mount(<Harness initial={withVideos(A, B, ...Array.from({ length: 7 }, (_, index) => `33333333-3333-4333-8333-33333333333${index}`))} />);
    await choose(host, [mp4("one.mp4"), mp4("two.mp4")]);
    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("10 images and videos at most");
  });

  it("shows an error, inserts nothing and releases the busy state when the upload fails", async () => {
    uploadVideo.mockRejectedValue(new Error("Part 2 could not be uploaded."));
    const host = mount(<Harness />);
    await choose(host, [mp4()]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("a.mp4 could not be uploaded: Part 2 could not be uploaded.");
    expect(JSON.stringify(latest)).not.toContain('"video"'); expect(uploadingNow).toBe(false); expect(tray(host)?.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("uploads dropped videos where they were dropped, and pasted ones, through the video path", async () => {
    uploadVideo.mockResolvedValue(A);
    const host = mount(<Harness />);
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    paste.clipboardData = { files: [mp4("pasted.mp4"), png("pic.png")], getData: () => "", types: ["Files"] };
    uploadImage.mockResolvedValue(B);
    await act(async () => { surface.dispatchEvent(paste); }); await settle();
    expect(uploadVideo).toHaveBeenCalledTimes(1); expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadVideo.mock.calls[0]![1].name).toBe("pasted.mp4"); expect(uploadImage.mock.calls[0]![1].name).toBe("pic.png");
  });

  it("does not take a dropped video on the Notice board, which has no video", async () => {
    const host = mount(<Harness media={{ noticeBoard: true }} preset="document" />);
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    paste.clipboardData = { files: [mp4("pasted.mp4")], getData: () => "", types: ["Files"] };
    await act(async () => { surface.dispatchEvent(paste); }); await settle();
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/not a JPEG, PNG or WebP/);
  });
});

describe("cancelling a video upload (#494)", () => {
  it("has a Cancel button on its tray row, 44px tall on a phone, that aborts the upload and removes the row at once, with no error and no node", async () => {
    let signal!: AbortSignal;
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => { signal = options.signal; return new Promise<string>((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }))); }); });
    const host = mount(<Harness />);
    await choose(host, [mp4("long.mp4")]);
    const cancel = host.querySelector<HTMLButtonElement>('[data-testid="rich-text-upload-tray"] button[aria-label="Cancel upload of long.mp4"]')!;
    expect(cancel).not.toBeNull(); expect(cancel.className).toContain("max-[721px]:min-h-[44px]");
    expect(signal.aborted).toBe(false);
    await act(async () => { cancel.click(); });
    expect(signal.aborted).toBe(true); expect(tray(host)).toBeNull();
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(JSON.stringify(latest)).not.toContain('"video"');
    expect(uploadingNow).toBe(false);
  });

  it("announces \"Upload cancelled\" in the editor's live region when the author cancels (#556)", async () => {
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }))); }));
    const host = mount(<Harness />);
    await choose(host, [mp4("long.mp4")]);
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(region.textContent).toBe("");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="rich-text-upload-tray"] button[aria-label="Cancel upload of long.mp4"]')!.click(); });
    await settle();
    expect(host.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(region.textContent).toBe("Upload cancelled");
  });

  it("announces a second consecutive cancel: the live region is cleared, then repopulated, with no edit between (#556)", async () => {
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }))); }));
    const host = mount(<Harness />);
    await choose(host, [mp4("one.mp4"), mp4("two.mp4")]);
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]')!;
    const seen: string[] = [];
    const observer = new MutationObserver(() => { if (seen[seen.length - 1] !== (region.textContent ?? "")) seen.push(region.textContent ?? ""); });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of one.mp4"]')!.click(); });
    await settle();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of two.mp4"]')!.click(); });
    await settle();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    observer.disconnect();
    expect(seen).toEqual(["Upload cancelled", "", "Upload cancelled"]);
  });

  it("a sibling upload landing before the re-announce timer fires neither clears the timer nor the message (#556)", async () => {
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }))); }));
    let finishImage!: (id: string) => void;
    uploadImage.mockImplementation(() => new Promise<string>((resolve) => { finishImage = resolve; }));
    const host = mount(<Harness />);
    await choose(host, [mp4("long.mp4")]);
    await choose(host, [png("sibling.png")], "Insert image");
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]')!;
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of long.mp4"]')!.click(); finishImage(B); });
    await settle(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(JSON.stringify(latest)).toContain(B);
    expect(region.textContent).toBe("Upload cancelled");
  });
  it("a sibling upload landing does not retire the cancel announcement (#556)", async () => {
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }))); }));
    let finishImage!: (id: string) => void;
    uploadImage.mockImplementation(() => new Promise<string>((resolve) => { finishImage = resolve; }));
    const host = mount(<Harness />);
    await choose(host, [mp4("long.mp4")]);
    await choose(host, [png("sibling.png")], "Insert image");
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]')!;
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of long.mp4"]')!.click(); });
    await settle();
    expect(region.textContent).toBe("Upload cancelled");
    await act(async () => { finishImage(B); }); await settle();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(JSON.stringify(latest)).toContain(B);
    expect(region.textContent).toBe("Upload cancelled");
  });

  it("an image row has no Cancel button", async () => {
    uploadImage.mockImplementation(() => new Promise<string>(() => undefined));
    const host = mount(<Harness />);
    await choose(host, [png()], "Insert image");
    expect(tray(host)?.textContent).toContain("Uploading a.png"); expect(tray(host)?.querySelector("button")).toBeNull();
  });

  it("aborts every upload still running when the editor unmounts, and the host is told it is no longer uploading", async () => {
    const signals: AbortSignal[] = [];
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => { signals.push(options.signal); return new Promise<string>(() => undefined); });
    const host = mount(<Harness />);
    await choose(host, [mp4("a.mp4"), mp4("b.mp4")]);
    expect(signals).toHaveLength(2); expect(uploadingNow).toBe(true);
    act(() => root!.unmount()); root = null;
    expect(signals.every((signal) => signal.aborted)).toBe(true); expect(uploadingNow).toBe(false);
    expect(host).toBeDefined();
  });

  it("warns before the page unloads while a video uploads, and not before it starts or after it ends or is cancelled", async () => {
    let finish!: (id: string) => void;
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => new Promise<string>((resolve, reject) => { finish = resolve; options.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))); }));
    const host = mount(<Harness />);
    expect(beforeUnload().defaultPrevented).toBe(false);
    await choose(host, [mp4()]);
    const during = beforeUnload(); expect(during.defaultPrevented).toBe(true);
    await act(async () => { finish(A); }); await settle();
    expect(beforeUnload().defaultPrevented).toBe(false);
    await choose(host, [mp4("again.mp4")]);
    expect(beforeUnload().defaultPrevented).toBe(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of again.mp4"]')!.click(); }); await settle();
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it("does not warn for an image upload alone", async () => {
    uploadImage.mockImplementation(() => new Promise<string>(() => undefined));
    const host = mount(<Harness />);
    await choose(host, [png()], "Insert image");
    expect(beforeUnload().defaultPrevented).toBe(false);
  });
});

describe("a posted video (#494)", () => {
  it("plays inline with controls from the media route, with the poster, and preloads only metadata", () => {
    const host = mount(<RichTextContent content={withVideos(A)} />);
    const element = host.querySelector<HTMLVideoElement>('[data-testid="embedded-video"] video')!;
    expect(element.getAttribute("src")).toBe(`/media/embedded/${A}`); expect(element.getAttribute("poster")).toBe(`/media/embedded/${A}/poster`);
    expect(element.hasAttribute("controls")).toBe(true); expect(element.getAttribute("preload")).toBe("metadata"); expect(element.hasAttribute("playsinline")).toBe(true);
    expect(element.getAttribute("aria-label")).toBeTruthy();
    expect(host.querySelector('[data-testid="embedded-video-unavailable"]')).toBeNull();
  });

  it("says it cannot play in this browser and offers the file as a download when the video fails", async () => {
    const host = mount(<RichTextContent content={withVideos(A)} />);
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    const unavailable = host.querySelector('[data-testid="embedded-video-unavailable"]')!;
    expect(unavailable.textContent).toContain("This video can't play in this browser");
    const link = unavailable.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe(`/media/embedded/${A}?download=1`); expect(link.hasAttribute("download")).toBe(true); expect(link.textContent).toMatch(/download/i);
    expect(host.querySelector("video")).toBeNull();
  });

  it("marks the Download video anchor with data-slot so the .rich-text link rule can exclude it (#556)", async () => {
    const host = mount(<RichTextContent content={withVideos(A)} />);
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector('[data-testid="embedded-video-unavailable"] a')!.getAttribute("data-slot")).toBe("button");
  });

  it("gives the Download video anchor a visible outline border: the base border-transparent is merged away, not left to fight border-border (#556)", async () => {
    const host = mount(<RichTextContent content={withVideos(A)} />);
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    const classes = host.querySelector('[data-testid="embedded-video-unavailable"] a')!.className.split(/\s+/);
    expect(classes).toContain("border-border");
    expect(classes).not.toContain("border-transparent");
  });

  it("does not carry one video's failure to the next: A fails, the post is refreshed to B in the same place, and B gets a player", async () => {
    const host = mount(<RichTextContent content={withVideos(A)} />);
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector('[data-testid="embedded-video-unavailable"]')).not.toBeNull();
    act(() => root!.render(<RichTextContent content={withVideos(B)} />));
    expect(host.querySelector('[data-testid="embedded-video-unavailable"]')).toBeNull();
    expect(host.querySelector("video")!.getAttribute("src")).toBe(`/media/embedded/${B}`);
  });

  it("decides per viewer from the error event: a poster that fails to load does not mark the video unplayable", async () => {
    const host = mount(<RichTextContent content={withVideos(A)} />);
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("abort")); });
    expect(host.querySelector('[data-testid="embedded-video-unavailable"]')).toBeNull();
  });
});

describe("the video's styles (#494)", () => {
  const appCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles/app.css"), "utf8");
  const rule = (selector: string) => appCss.split("\n").find((line) => line.startsWith(selector)) ?? "";
  it("sizes a video like an image: contained, at most 24rem tall, the same border and sunken ground, and never wider than its container", () => {
    const style = rule(".rich-text__embedded-video {");
    expect(style).toContain("max-width: min(100%, calc(24rem * 16 / 9))"); expect(style).toContain("max-height: 24rem"); expect(style).toContain("object-fit: contain");
    expect(style).toContain("border: var(--border-width-hair) solid var(--border)"); expect(style).toContain("background: var(--surface-sunken)"); expect(style).toContain("border-radius: var(--radius-xs)");
  });
  it("turns a selected video's border accent in the editor, the same rule as an image and a link card", () => {
    const selected = rule(".rich-text__editor-content .ProseMirror-selectednode .rich-text__embedded-video-node > video.rich-text__embedded-video");
    expect(selected).toContain("border-color: var(--accent)"); expect(selected).not.toContain("outline");
  });
  it("gives a video a stable box before its metadata arrives: full width, 16:9 until the file's own ratio is known (#556)", () => {
    const style = rule(".rich-text__embedded-video {");
    expect(style).toContain("width: 100%"); expect(style).toContain("aspect-ratio: 16 / 9;"); expect(style).not.toContain("aspect-ratio: auto");
  });
});

describe("a video upload that lands while the author is composing (#494, PR #547)", () => {
  it("keeps the video when the author types on after it lands (a finished upload must not select it)", async () => {
    let finish!: (id: string) => void;
    uploadVideo.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const typed: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "QA 547 repro" }] }] };
    const host = mount(<Harness initial={typed} />);
    const editor = tiptapOf(host);
    act(() => { editor.commands.focus("end"); });
    // Paste goes through the same addImagesRef path as the toolbar picker and drop.
    act(() => { const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }; event.clipboardData = { files: [mp4()], getData: () => "", types: ["Files"] }; editor.view.dom.dispatchEvent(event); });
    expect(uploadVideo).toHaveBeenCalledTimes(1);
    await act(async () => { finish(A); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(latest.content.some((node) => node.type === "video")).toBe(true);
    // Tiptap's insertContentAt selects inserted content by default: a NodeSelection on the new atom means the next keystroke replaces it.
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    // What ProseMirror does with the author's next keystroke: insert at the current selection.
    act(() => { editor.view.dispatch(editor.view.state.tr.insertText(" ok")); });
    expect(latest.content.filter((node) => node.type === "video")).toHaveLength(1);
    expect(JSON.stringify(latest)).toContain("QA 547 repro ok");
  });
});
