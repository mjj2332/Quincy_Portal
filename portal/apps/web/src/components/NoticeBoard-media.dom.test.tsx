import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import type { RichTextDoc } from "@quincy/shared";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { createQuincyQueryClient } from "../lib/query-client";
import { chooseNoticeAction, confirmNoticeDelete } from "../testing/notice-menu";
const advanceTimers = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Notice board embedded media (#496): the composers, the upload locks, the failure paths and a posted image. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const upload = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: upload }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: () => Promise.resolve({ ok: true }) };
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const text = (value: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: value }] });
const withImage = (value: string, ...ids: string[]): RichTextDoc => ({ type: "doc", content: [text(value), ...ids.map((mediaId) => ({ type: "image" as const, attrs: { mediaId } }))] });
const png = (name = "a.png") => new File([new Uint8Array(100)], name, { type: "image/png" });
const readState = { marker: null, latest: null, unreadCount: 0 };
const ownPost: NoticeBoardPost = { id: "post-own", authorId: "user-a", authorName: "A", body: "Mine\n[image]", content: withImage("Mine", A), createdAt: "2026-07-28T00:00:00.000Z", editedAt: null };

let root: Root | null = null;
let queryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render(value: ReactNode) {
  await act(async () => { root!.render(<QueryClientProvider client={queryClient!}>{value}</QueryClientProvider>); for (let index = 0; index < 12; index += 1) await Promise.resolve(); });
  await flush();
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1); await Promise.resolve(); await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }
const buttonNamed = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name)!;
const tiptapOf = (scope: ParentNode) => (scope.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
async function choose(scope: ParentNode, files: File[]) {
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { scope.querySelector<HTMLButtonElement>('button[aria-label="Insert image"]')!.click(); });
  click.mockRestore();
  const picker = scope.querySelector<HTMLInputElement>('input[data-testid="rich-text-image-picker"]')!;
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}
const ctrlEnter = (scope: ParentNode) => act(async () => { scope.querySelector<HTMLElement>('[contenteditable="true"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
const composer = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="notice-board-composer"]')!;
const editComposer = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"]')!;
async function typeInto(scope: ParentNode, value: string) {
  const editor = scope.querySelector<HTMLElement>('[contenteditable="true"]')!;
  await act(async () => { editor.focus(); editor.textContent = value; editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, String(value)); }, removeItem: (key: string) => { values.delete(key); }, clear: () => { values.clear(); } } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  focusManager.setFocused(true);
  upload.mockReset(); apiGetMock.mockReset(); apiPostMock.mockReset(); apiPatchMock.mockReset();
  queryClient = createQuincyQueryClient();
  apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("read-marker") ? readState : { posts: [ownPost] }));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); queryClient = null; document.body.replaceChildren(); vi.useRealTimers();
});

describe("the Notice board composers take images", () => {
  it("shows the media tools in both the new-post and the edit composer", async () => {
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    expect(composer(host).querySelector('[data-testid="rich-text-media-tools"]')).not.toBeNull();
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    expect(editComposer(host).querySelector('[data-testid="rich-text-media-tools"]')).not.toBeNull();
    expect(editComposer(host).querySelector('img[data-media-id]')?.getAttribute("src")).toBe(`/media/embedded/${A}`);
  });

  it("uploads into the Notice board scope", async () => {
    upload.mockResolvedValue(B);
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await choose(composer(host), [png()]);
    expect(upload).toHaveBeenCalledTimes(1); expect(upload.mock.calls[0]![0]).toEqual({ noticeBoard: true });
  });

  it("holds Post while an image uploads, ignores Ctrl+Enter, then posts the image node once it lands", async () => {
    let finish!: (id: string) => void;
    upload.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    apiPostMock.mockResolvedValue({ post: { ...ownPost, id: "post-new" }, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeInto(composer(host), "Look");
    await choose(composer(host), [png()]);
    expect(buttonNamed(composer(host), "Post notice").disabled).toBe(true);
    await ctrlEnter(composer(host)); await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
    await act(async () => { finish(B); }); await flush();
    expect(buttonNamed(composer(host), "Post notice").disabled).toBe(false);
    await click(buttonNamed(composer(host), "Post notice")); await flush();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const sent = (apiPostMock.mock.calls[0]![1] as { content: RichTextDoc }).content;
    expect(apiPostMock.mock.calls[0]![0]).toBe("/api/notice-board/posts");
    expect(sent.content.filter((node) => node.type === "image")).toEqual([{ type: "image", attrs: { mediaId: B } }]);
  });

  it("keeps the draft and its image, and shows the error, when the server answers 409", async () => {
    upload.mockResolvedValue(B);
    apiPostMock.mockRejectedValue(new Error("An image in this notice is no longer available. Remove it and try again."));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeInto(composer(host), "Look"); await choose(composer(host), [png()]);
    await click(buttonNamed(composer(host), "Post notice")); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("no longer available");
    expect(composer(host).querySelector('img[data-media-id]')?.getAttribute("data-media-id")).toBe(B);
    expect(buttonNamed(composer(host), "Post notice").disabled).toBe(false);
  });

  it("keeps the image when the post is edited, and sends it in the save", async () => {
    apiPatchMock.mockResolvedValue({ post: { ...ownPost, editedAt: "2026-07-28T00:01:00.000Z" }, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    await click(buttonNamed(editComposer(host), "Save")); await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock.mock.calls[0]![0]).toBe("/api/notice-board/posts/post-own");
    expect((apiPatchMock.mock.calls[0]![1] as { content: RichTextDoc }).content.content.filter((node) => node.type === "image")).toEqual([{ type: "image", attrs: { mediaId: A } }]);
  });

  it("locks Save and Ctrl+Enter in the edit composer while its own image uploads, independently of the new-post composer", async () => {
    let finishEdit!: (id: string) => void; let finishCreate!: (id: string) => void;
    upload.mockImplementationOnce(() => new Promise<string>((resolve) => { finishCreate = resolve; })).mockImplementationOnce(() => new Promise<string>((resolve) => { finishEdit = resolve; }));
    apiPatchMock.mockResolvedValue({ post: ownPost, readState });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await choose(composer(host), [png("create.png")]);
    // The new-post upload does not hold the edit composer.
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    expect(buttonNamed(editComposer(host), "Save").disabled).toBe(false);
    await choose(editComposer(host), [png("edit.png")]);
    expect(buttonNamed(editComposer(host), "Save").disabled).toBe(true);
    await ctrlEnter(editComposer(host)); await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
    // Finishing the new-post upload does not release the edit composer's own lock.
    await act(async () => { finishCreate(B); }); await flush();
    expect(buttonNamed(editComposer(host), "Save").disabled).toBe(true);
    await act(async () => { finishEdit("33333333-3333-4333-8333-333333333333"); }); await flush();
    expect(buttonNamed(editComposer(host), "Save").disabled).toBe(false);
    await ctrlEnter(editComposer(host)); await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the edit lock when the edit is cancelled mid-upload", async () => {
    upload.mockImplementation(() => new Promise<string>(() => undefined));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    await choose(editComposer(host), [png()]);
    expect(buttonNamed(editComposer(host), "Save").disabled).toBe(true);
    await click(buttonNamed(editComposer(host), "Cancel"));
    await chooseNoticeAction(host, "A", "Edit", advanceTimers);
    expect(buttonNamed(editComposer(host), "Save").disabled).toBe(false);
  });
});

describe("a posted image", () => {
  it("renders from the media route and opens the larger view", async () => {
    const host = mount(); await render(<NoticeBoard currentUserId="user-b" />);
    const image = host.querySelector<HTMLImageElement>('[data-slot="notice-board-post"] [data-testid="embedded-image"] img')!;
    expect(image.getAttribute("src")).toBe(`/media/embedded/${A}`);
    await click(host.querySelector('[data-testid="embedded-image"]')!);
    expect(document.querySelector('[data-testid="embedded-image-dialog"] img')?.getAttribute("src")).toBe(`/media/embedded/${A}`);
    expect(document.querySelector('[data-testid="embedded-image-dialog"]')?.textContent).toContain("The image as posted.");
  });
});

describe("dropping an image on a table", () => {
  const tableDoc: RichTextDoc = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [text("cell")] }] }] }, { type: "paragraph" }] };
  it("never puts the image inside a table cell", async () => {
    upload.mockResolvedValue(A);
    let latest: RichTextDoc = tableDoc;
    function Harness() { const [value, setValue] = useState(tableDoc); return <QuincyRichTextEditor preset="document" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} media={{ noticeBoard: true }} />; }
    const host = mount(); await act(async () => { root!.render(<Harness />); });
    const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!; const cell = surface.querySelector("td p, th p")!;
    const doc = document as Document & { elementFromPoint: (x: number, y: number) => Element | null; caretPositionFromPoint?: unknown };
    doc.elementFromPoint = () => cell; doc.caretPositionFromPoint = () => ({ offsetNode: cell.firstChild ?? cell, offset: 2 }) as unknown as CaretPosition;
    const drop = new Event("drop", { bubbles: true, cancelable: true, }) as Event & { dataTransfer?: unknown; clientX?: number; clientY?: number };
    drop.dataTransfer = { files: [png()], types: ["Files"], getData: () => "" };
    await act(async () => { cell.dispatchEvent(drop); await Promise.resolve(); await Promise.resolve(); }); await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    const nodes = latest.content;
    expect(nodes.some((node) => node.type === "image")).toBe(true);
    expect(JSON.stringify(nodes.find((node) => node.type === "table"))).not.toContain('"image"');
    void tiptapOf;
  });
});
