import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import type { RichTextDoc } from "@quincy/shared";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";
import { createQuincyQueryClient } from "../lib/query-client";
import { chooseNoticeAction } from "../testing/notice-menu";

/**
 * Attachments on Notice board posts (#954): the paperclip in the new-notice and the edit box takes any file. A photo still lands inline as
 * Embedded media; anything else is an Attachment, a C4 chip in the box from the pick (uploading, failed with Retry and Remove, landed), and a
 * download chip on the posted notice. Post and Save wait on an upload and on a failed file.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const uploadImage = vi.hoisted(() => vi.fn());
const heicSetting = vi.hoisted(() => vi.fn());
const uploadFile = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: uploadImage, fetchEmbeddedHeicSetting: heicSetting }));
vi.mock("../lib/attachments", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/attachments")>()), uploadNoticeAttachment: uploadFile }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: () => Promise.resolve({ ok: true }) };
});

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";
const text = (value: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: value }] });
const withFile = (value: string, attachmentId: string, name = "Rota.pdf", bytes = 2_400_000): RichTextDoc => ({ type: "doc", content: [text(value), { type: "attachment", attrs: { attachmentId, name, bytes } }] });
const file = (name: string, type = "", size = 100) => { const made = new File([new Uint8Array(4)], name, { type }); Object.defineProperty(made, "size", { value: size }); return made; };
const pdf = (name = "Rota.pdf") => file(name, "application/pdf", 2_400_000);
const deferred = () => { let resolve!: (id: string) => void; let reject!: (error: unknown) => void; const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const readState = { marker: null, latest: null, unreadCount: 0 };
const ownPost: NoticeBoardPost = { id: "post-own", authorId: "user-a", authorName: "A", body: "Rota\n[attachment]", content: withFile("Rota", F1), createdAt: "2026-07-28T00:00:00.000Z", editedAt: null };

const isLocked = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";
const composer = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="notice-board-composer"]')!;
const editComposer = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"]')!;
const postButton = (host: HTMLElement) => composer(host).querySelector<HTMLButtonElement>('button[type="submit"]')!;
const buttonNamed = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name) ?? null;
const chips = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-testid="note-draft-chip"]')];
const advanceTimers = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let root: Root | null = null;
let queryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1); await Promise.resolve(); await Promise.resolve(); }); }
async function render(value: ReactNode) {
  await act(async () => { root!.render(<QueryClientProvider client={queryClient!}>{value}</QueryClientProvider>); for (let index = 0; index < 12; index += 1) await Promise.resolve(); });
  await flush();
}
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); await flush(); }
async function pick(scope: ParentNode, files: File[]) {
  const spy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { buttonNamed(scope, "Add files")!.click(); });
  spy.mockRestore();
  const picker = scope.querySelector<HTMLInputElement>('input[data-testid="rich-text-media-picker"]')!;
  expect(picker.getAttribute("accept")).toBeNull();
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}
async function typeInto(scope: ParentNode, value: string) {
  const editor = scope.querySelector<HTMLElement>('[contenteditable="true"]')!;
  await act(async () => { editor.focus(); editor.textContent = value; editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); await Promise.resolve(); await Promise.resolve(); });
}
const ctrlEnter = (scope: ParentNode) => act(async () => { scope.querySelector<HTMLElement>('[contenteditable="true"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
const sentContent = (mock: typeof apiPostMock | typeof apiPatchMock) => (mock.mock.calls[0]![1] as { content: RichTextDoc }).content;

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, String(value)); }, removeItem: (key: string) => { values.delete(key); }, clear: () => { values.clear(); } } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  focusManager.setFocused(true);
  uploadImage.mockReset(); heicSetting.mockReset(); heicSetting.mockResolvedValue(false); uploadFile.mockReset(); apiGetMock.mockReset(); apiPostMock.mockReset(); apiPatchMock.mockReset();
  queryClient = createQuincyQueryClient();
  apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("read-marker") ? readState : { posts: [ownPost] }));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); queryClient = null; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("the Notice board's paperclip takes files (#954)", () => {
  it("is \"Add files\" in the new-notice and the edit box, and sends a PDF down the Notice board's Attachment path and a photo down Embedded media", async () => {
    uploadFile.mockResolvedValue(F2); uploadImage.mockResolvedValue(M);
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await pick(composer(host), [pdf("Logos.pdf"), file("front.jpg", "image/jpeg")]);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect((uploadFile.mock.calls[0]![0] as File).name).toBe("Logos.pdf");
    expect(uploadImage).toHaveBeenCalledTimes(1); expect(uploadImage.mock.calls[0]![0]).toEqual({ noticeBoard: true });
    // The photo is inline in the page, as before; the file is a chip in the box, and only the file.
    expect(composer(host).querySelector(`[contenteditable="true"] img[data-media-id="${M}"]`)).not.toBeNull();
    expect(chips(composer(host)).map((chip) => [chip.dataset.kind, chip.dataset.state, chip.textContent])).toEqual([["attachment", "ready", expect.stringContaining("Logos.pdf")]]);
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    expect(buttonNamed(editComposer(host), "Add files")).not.toBeNull();
  });

  it("holds Post while a file uploads, ignores Ctrl+Enter, then posts the file's id alone", async () => {
    const upload = deferred(); uploadFile.mockReturnValue(upload.promise);
    apiPostMock.mockResolvedValue({ post: { ...ownPost, id: "post-new" }, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeInto(composer(host), "Logos");
    await pick(composer(host), [pdf("Logos.pdf")]);
    expect(chips(composer(host))[0]!.dataset.state).toBe("uploading");
    expect(isLocked(postButton(host))).toBe(true);
    await ctrlEnter(composer(host)); await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
    await act(async () => { upload.resolve(F2); }); await flush();
    expect(isLocked(postButton(host))).toBe(false);
    await click(postButton(host));
    expect(apiPostMock.mock.calls[0]![0]).toBe("/api/notice-board/posts");
    expect(sentContent(apiPostMock).content.filter((node) => node.type === "attachment")).toEqual([{ type: "attachment", attrs: { attachmentId: F2 } }]);
  });

  it("holds Post on a failed file with Retry or Remove, and Remove lets the notice go without it", async () => {
    const upload = deferred(); uploadFile.mockReturnValue(upload.promise);
    apiPostMock.mockResolvedValue({ post: { ...ownPost, id: "post-new" }, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeInto(composer(host), "Logos");
    await pick(composer(host), [pdf("Logos.pdf")]);
    await act(async () => { upload.reject(new Error("Part 1 could not be uploaded.")); }); await flush();
    const chip = chips(composer(host))[0]!;
    expect(chip.dataset.state).toBe("failed");
    expect(buttonNamed(chip, "Retry Logos.pdf")).not.toBeNull();
    expect(isLocked(postButton(host))).toBe(true);
    expect(postButton(host).getAttribute("title")).toBe("Retry or remove the file that failed.");
    await ctrlEnter(composer(host)); await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
    await click(buttonNamed(chip, "Remove Logos.pdf")!);
    expect(chips(composer(host))).toHaveLength(0);
    expect(isLocked(postButton(host))).toBe(false);
  });

  it("refuses an eleventh file and a blocked one in the box, with the reason", async () => {
    uploadFile.mockImplementation(() => new Promise<string>(() => undefined));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await pick(composer(host), [...Array.from({ length: 11 }, (_, n) => pdf(`Sheet ${n + 1}.pdf`)), file("macro.xlsm")]);
    expect(uploadFile).toHaveBeenCalledTimes(10);
    expect(chips(composer(host))).toHaveLength(10);
    expect(composer(host).textContent).toContain("A post can hold 10 attachments at most.");
    expect(composer(host).textContent).toMatch(/macro\.xlsm/);
  });
});

describe("a notice's Attachments once posted", () => {
  it("are download chips on the notice, from the attachment route, with the name and size", async () => {
    const host = mount(); await render(<NoticeBoard currentUserId="user-b" />);
    const chip = host.querySelector<HTMLAnchorElement>('[data-slot="notice-board-post"] [data-testid="attachment-chip"]')!;
    expect(chip.getAttribute("href")).toBe(`/media/attachments/${F1}`);
    expect(chip.hasAttribute("download")).toBe(true);
    expect(chip.getAttribute("aria-label")).toMatch(/^Download Rota\.pdf, 2\.\d MB$/);
  });

  it("show in the edit box as chips; removing one and saving sends the notice without it, and adding one sends both", async () => {
    uploadFile.mockResolvedValue(F2);
    apiPatchMock.mockResolvedValue({ post: ownPost, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    expect(chips(editComposer(host)).map((chip) => chip.dataset.state)).toEqual(["ready"]);
    await pick(editComposer(host), [pdf("Logos.pdf")]);
    expect(chips(editComposer(host))).toHaveLength(2);
    await click(buttonNamed(editComposer(host), "Remove Rota.pdf")!);
    await click(buttonNamed(editComposer(host), "Save")!);
    expect(apiPatchMock.mock.calls[0]![0]).toBe("/api/notice-board/posts/post-own");
    expect(sentContent(apiPatchMock).content.filter((node) => node.type === "attachment")).toEqual([{ type: "attachment", attrs: { attachmentId: F2 } }]);
  });

  it("holds Save in the edit box while its file uploads, independently of the new-notice box", async () => {
    const editing = deferred();
    uploadFile.mockImplementationOnce(() => new Promise<string>(() => undefined)).mockImplementationOnce(() => editing.promise);
    apiPatchMock.mockResolvedValue({ post: ownPost, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await pick(composer(host), [pdf("Create.pdf")]);
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    expect(isLocked(buttonNamed(editComposer(host), "Save")!)).toBe(false);
    await pick(editComposer(host), [pdf("Edit.pdf")]);
    expect(isLocked(buttonNamed(editComposer(host), "Save")!)).toBe(true);
    await act(async () => { editing.resolve(F2); }); await flush();
    expect(isLocked(buttonNamed(editComposer(host), "Save")!)).toBe(false);
  });
});
