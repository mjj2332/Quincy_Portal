import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, type RichTextDoc } from "@quincy/shared";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import type { RichTextEditorHandle } from "./QuincyRichTextEditorBase";

/**
 * #952 D8: the note box's paper clip takes any file. A photo or video the person may embed goes down the Embedded media path as before;
 * anything else becomes an Attachment, a chip from the moment it is picked (uploading, then failed with Retry and Remove, then landed).
 * Without an attachment transport (Video notes, Guest notes, the Notice board) the picker is exactly as it was.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const uploadImage = vi.hoisted(() => vi.fn());
const uploadVideo = vi.hoisted(() => vi.fn());
const heicSetting = vi.hoisted(() => vi.fn());
const uploadAttachment = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: uploadImage, uploadEmbeddedVideo: uploadVideo, fetchEmbeddedHeicSetting: heicSetting }));
vi.mock("../lib/attachments", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/attachments")>()), uploadAttachment }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";
const V = "44444444-4444-4444-8444-444444444444";
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const file = (name: string, type = "", size = 100) => { const made = new File([new Uint8Array(4)], name, { type }); Object.defineProperty(made, "size", { value: size }); return made; };
const pdf = (name = "Floor plan.pdf", size = 2_400_000) => file(name, "application/pdf", size);
const deferred = () => { let resolve!: (id: string) => void; let reject!: (error: unknown) => void; const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

let root: Root | null = null;
let latest: RichTextDoc = empty();
let uploadingNow = false;
let failedNow = 0;
let handle: RichTextEditorHandle | null = null;
const onSubmit = vi.fn();

function Harness({ initial = empty(), files = true }: { initial?: RichTextDoc; files?: boolean }) {
  const [value, setValue] = useState(initial);
  return <QuincyRichTextEditor
    ref={(next) => { handle = next; }}
    preset="note" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []}
    media={{ projectId: "p1" }} {...(files ? { attachments: { projectId: "p1" } } : {})} onSubmit={onSubmit}
    onUploadingChange={(busy) => { uploadingNow = busy; }} onFailedFilesChange={(count) => { failedNow = count; }}
  />;
}
function mount(ui: React.ReactElement) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(ui)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const surfaceOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[contenteditable="true"]')!;
const tiptapOf = (host: HTMLElement) => (surfaceOf(host) as unknown as { editor: Editor }).editor;
async function openPicker(host: HTMLElement) {
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { handle!.pickMedia(); });
  click.mockRestore();
  return host.querySelector<HTMLInputElement>('input[data-testid="rich-text-media-picker"]')!;
}
async function pick(host: HTMLElement, files: File[]) {
  const picker = await openPicker(host);
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-testid="note-draft-chip"]')];
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label) ?? null;
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); }
const problems = () => document.body.textContent ?? "";
const kinds = (doc: RichTextDoc) => doc.content.map((block) => block.type);

beforeEach(() => {
  latest = empty(); uploadingNow = false; failedNow = 0; handle = null; onSubmit.mockReset();
  uploadImage.mockReset(); uploadVideo.mockReset(); heicSetting.mockReset(); heicSetting.mockResolvedValue(false); uploadAttachment.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({ media: query, matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList);
});
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe("the paper clip's split (#952 D8)", () => {
  it("sends a photo and a video down Embedded media and a PDF down the Attachment path, from one pick", async () => {
    uploadImage.mockResolvedValue(M); uploadVideo.mockResolvedValue(V); uploadAttachment.mockResolvedValue(A);
    const host = mount(<Harness />);
    await pick(host, [pdf(), file("front.jpg", "image/jpeg"), file("walk.mp4", "video/mp4")]);
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment.mock.calls[0]![0]).toBe("p1");
    expect((uploadAttachment.mock.calls[0]![1] as File).name).toBe("Floor plan.pdf");
    expect(kinds(latest).filter((kind) => kind !== "paragraph").sort()).toEqual(["attachment", "image", "video"]);
  });

  it("makes a GIF, a raw file and a HEIC (for someone without HEIC) Attachments rather than refusing them (A3)", async () => {
    uploadAttachment.mockResolvedValue(A);
    const host = mount(<Harness />);
    await pick(host, [file("loop.gif", "image/gif"), file("IMG_1.DNG"), file("IMG_2.HEIC")]);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(uploadAttachment).toHaveBeenCalledTimes(3);
  });

  it("takes any file and names the picker for files; without an attachment transport the picker is unchanged", async () => {
    const host = mount(<Harness />);
    const picker = await openPicker(host);
    expect(picker.hasAttribute("accept")).toBe(false);
    expect(picker.getAttribute("aria-label")).toBe("Choose files");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const plain = mount(<Harness files={false} />);
    const before = await openPicker(plain);
    expect(before.getAttribute("accept")).toContain("image/jpeg");
    expect(before.getAttribute("aria-label")).toBe("Choose photos or videos");
  });
});

describe("an Attachment's chip", () => {
  it("shows the file uploading with its progress, holds the post, then lands as a chip at the end of the note", async () => {
    const upload = deferred();
    let progress: ((percent: number) => void) | undefined;
    uploadAttachment.mockImplementation((_project: string, _file: File, options: { onProgress?: (percent: number) => void }) => { progress = options.onProgress; return upload.promise; });
    const host = mount(<Harness initial={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plans" }] }] }} />);
    await pick(host, [pdf()]);
    expect(uploadingNow).toBe(true);
    await act(async () => { progress!(40); });
    const chip = chips()[0]!;
    expect(chip.dataset.state).toBe("uploading");
    expect(chip.textContent).toContain("Floor plan.pdf");
    expect(chip.textContent).toContain("2.4 MB");
    expect(chip.textContent).toContain("Uploading, 40%");
    await act(async () => { upload.resolve(A); });
    await settle();
    expect(uploadingNow).toBe(false);
    expect(latest.content.at(-1)).toEqual({ type: "attachment", attrs: { attachmentId: A, name: "Floor plan.pdf", bytes: 2_400_000 } });
    expect(chips()).toHaveLength(1);
    expect(chips()[0]!.dataset.state).toBe("ready");
    expect(chips()[0]!.textContent).toContain("2.4 MB");
  });

  it("keeps the caret where the author is typing when an Attachment lands", async () => {
    const upload = deferred();
    uploadAttachment.mockReturnValue(upload.promise);
    const host = mount(<Harness initial={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plans" }] }] }} />);
    await pick(host, [pdf()]);
    const tiptap = tiptapOf(host);
    await act(async () => { surfaceOf(host).focus(); tiptap.commands.setTextSelection(6); });
    await act(async () => { upload.resolve(A); });
    await settle();
    await act(async () => { tiptap.commands.insertContent(" and more"); });
    expect(latest.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "Plans and more" }] });
    expect(kinds(latest)).toEqual(["paragraph", "attachment"]);
  });

  it("offers Retry and Remove on a failed upload and holds the post until one of them; Retry sends the same file again", async () => {
    const first = deferred();
    uploadAttachment.mockReturnValueOnce(first.promise);
    const host = mount(<Harness />);
    const chosen = pdf();
    await pick(host, [chosen]);
    await act(async () => { first.reject(new Error("Part 1 could not be uploaded.")); });
    await settle();
    const chip = chips()[0]!;
    expect(chip.dataset.state).toBe("failed");
    expect(chip.textContent).toContain("Upload failed");
    expect(failedNow).toBe(1);
    expect(uploadingNow).toBe(false);
    // ⌘↵ is held too: a post must never go out missing a file.
    await act(async () => { surfaceOf(host).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", metaKey: true })); });
    expect(onSubmit).not.toHaveBeenCalled();
    const again = deferred();
    uploadAttachment.mockReturnValueOnce(again.promise);
    await click(button(chip, "Retry Floor plan.pdf")!);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(uploadAttachment.mock.calls[1]![1]).toBe(chosen);
    expect(failedNow).toBe(0);
    expect(uploadingNow).toBe(true);
    expect(chips()[0]!.dataset.state).toBe("uploading");
    await act(async () => { again.reject(new Error("again")); });
    await settle();
    expect(failedNow).toBe(1);
    await click(button(chips()[0]!, "Remove Floor plan.pdf")!);
    expect(chips()).toHaveLength(0);
    expect(failedNow).toBe(0);
  });

  it("shows the server's refusal and keeps no chip, since sending it again cannot help", async () => {
    uploadAttachment.mockRejectedValue(Object.assign(new Error("Plan.pdf can't be attached: application/x-msdownload files are blocked."), { status: 400 }));
    const host = mount(<Harness />);
    await pick(host, [pdf("Plan.pdf")]);
    expect(chips()).toHaveLength(0);
    expect(failedNow).toBe(0);
    expect(problems()).toContain("Plan.pdf can't be attached: application/x-msdownload files are blocked.");
  });

  it("cancels an uploading file with its x, and starts nothing for a blocked, an oversized or an 11th file", async () => {
    const host = mount(<Harness initial={{ type: "doc", content: Array.from({ length: 9 }, (_, index) => ({ type: "attachment" as const, attrs: { attachmentId: `5555555${index}-5555-4555-8555-555555555555`, name: `f${index}.pdf`, bytes: 10 } })) }} />);
    let signal: AbortSignal | undefined;
    uploadAttachment.mockImplementation((_project: string, _file: File, options: { signal?: AbortSignal }) => { signal = options.signal; return new Promise(() => {}); });
    await pick(host, [file("setup.exe"), pdf("big.pdf", ATTACHMENT_MAX_BYTES + 1), pdf("ten.pdf"), pdf("eleven.pdf")]);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(problems()).toContain("setup.exe can't be attached: .exe files are blocked.");
    expect(problems()).toContain("big.pdf is larger than 100 MB, the most a file can be.");
    expect(problems()).toContain("A post can hold 10 attachments at most.");
    const uploading = chips().find((chip) => chip.dataset.state === "uploading")!;
    await click(button(uploading, "Remove ten.pdf")!);
    expect(signal?.aborted).toBe(true);
    expect(uploadingNow).toBe(false);
    expect(chips().filter((chip) => chip.dataset.state === "uploading")).toHaveLength(0);
  });

  it("draws an edited comment's Attachments as chips by their served name and size, and x removes one from the note", async () => {
    mount(<Harness initial={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Two files" }] }, { type: "attachment", attrs: { attachmentId: A, name: "a.pdf", bytes: 1_000 } }, { type: "attachment", attrs: { attachmentId: B, name: "b.zip", bytes: 3_000_000 } }] }} />);
    expect(chips().map((chip) => chip.textContent)).toEqual([expect.stringContaining("a.pdf"), expect.stringContaining("b.zip")]);
    expect(chips()[1]!.textContent).toContain("3.0 MB");
    await click(button(chips()[0]!, "Remove a.pdf")!);
    expect(latest.content.filter((block) => block.type === "attachment")).toEqual([{ type: "attachment", attrs: { attachmentId: B, name: "b.zip", bytes: 3_000_000 } }]);
  });

  it("cancels a running upload when the editor unmounts", async () => {
    let signal: AbortSignal | undefined;
    uploadAttachment.mockImplementation((_project: string, _file: File, options: { signal?: AbortSignal }) => { signal = options.signal; return new Promise(() => {}); });
    const host = mount(<Harness />);
    await pick(host, [pdf()]);
    act(() => root?.unmount()); root = null;
    expect(signal?.aborted).toBe(true);
    expect(host.isConnected).toBe(true);
  });
});
