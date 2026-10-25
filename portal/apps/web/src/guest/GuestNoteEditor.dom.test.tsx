import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import type { RichTextEditorHandle } from "../components/QuincyRichTextEditorBase";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const uploadMultipartFile = vi.hoisted(() => vi.fn());
vi.mock("../lib/multipart-upload", () => ({ uploadMultipartFile }));
const { GuestNoteEditor } = await import("./GuestNoteEditor");
const { createGuestMediaTransport } = await import("./guest-api");

/** The real rich field on a Review link (#835 C): no mentions, and every byte goes through the link's own media routes. The `note` preset (#927): the box's paperclip opens the picker through the handle. */
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}/media`;
const MEDIA = "33333333-3333-4333-8333-333333333333";
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const png = () => new File([new Uint8Array(8)], "site.png", { type: "image/png" });
const FILES = `/d/api/links/${LINK}/attachments`;
const FILE = "44444444-4444-4444-8444-444444444444";
/** A PDF of `bytes` (8 by default): only its `size` is read, so a large one claims the size without holding the bytes. */
const pdf = (name: string, bytes = 8) => { const file = new File([new Uint8Array(8)], name, { type: "application/pdf" }); if (bytes !== 8) Object.defineProperty(file, "size", { value: bytes }); return file; };

let root: Root | null = null;
let latest: RichTextDoc = empty();
let busy: boolean[] = [];
let failed: number[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let handle: RichTextEditorHandle | null = null;
const transport = createGuestMediaTransport(LINK);
function Harness() {
  const [value, setValue] = useState(empty());
  return <GuestNoteEditor ref={(next) => { handle = next; }} testId="field" label="Your note" media={transport} value={value} onChange={(next) => { latest = next; setValue(next); }} onUploadingChange={(uploading) => { busy.push(uploading); }} onFailedFilesChange={(count) => { failed.push(count); }} />;
}
async function mount() {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  // The editor is a lazy chunk in the page; here it is imported, so it renders at once.
  await act(async () => { root!.render(<Harness />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function openPicker(host: HTMLElement): Promise<HTMLInputElement> {
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { handle!.pickMedia(); });
  click.mockRestore();
  return host.querySelector<HTMLInputElement>('input[data-testid="rich-text-media-picker"]')!;
}
async function pick(host: HTMLElement, files: File[]) {
  const picker = await openPicker(host);
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(); await settle(); await settle();
}

beforeEach(() => {
  latest = empty(); busy = []; failed = []; handle = null;
  uploadMultipartFile.mockReset(); uploadMultipartFile.mockResolvedValue({});
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === BASE) return json({ mediaId: MEDIA, devDirect: true });
    if (url === FILES) return json({ attachmentId: FILE, devDirect: true });
    if (url === `${FILES}/${FILE}/complete`) return json({ attachmentId: FILE, state: "pending" });
    return url.endsWith("/complete") ? json({ mediaId: MEDIA, state: "pending" }) : new Response(null, { status: 204 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // jsdom never decodes an image: its size is unreadable at once, so the upload does not wait on the measurement.
  vi.stubGlobal("Image", class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onerror?.()); } });
});
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the guest's note field", () => {
  it("has no mentions: typing @ lists nobody and stays plain text", async () => {
    const host = await mount();
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(editor.getAttribute("aria-label")).toBe("Your note");
    await act(async () => {
      editor.querySelector("p")!.append(document.createTextNode("@no"));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "@no" }));
      await Promise.resolve(); await Promise.resolve();
    });
    await settle();
    expect(editor.getAttribute("aria-expanded")).toBeNull();
    expect(document.querySelector('[aria-label="Mention suggestions"]')).toBeNull();
    expect(JSON.stringify(latest)).toContain("@no");
    expect(JSON.stringify(latest)).not.toContain('"mention"');
  });

  it("opens one picker for any file through the handle (#956: a guest attaches files too)", async () => {
    const host = await mount();
    // The note preset has no toolbar: the box's paperclip is the way in.
    expect(host.querySelector('button[aria-label="Insert image"]')).toBeNull();
    const picker = await openPicker(host);
    expect(picker.getAttribute("accept")).toBeNull();
    expect(picker.getAttribute("aria-label")).toBe("Choose files");
  });

  it("sends a HEIC down the file path while the owner has HEIC off, never the media path", async () => {
    const host = await mount();
    await pick(host, [new File([new Uint8Array(8)], "site.heic", { type: "image/heic" })]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([FILES, `${FILES}/${FILE}/complete`]);
  });

  it("uploads a file through the link's Attachment routes and puts it in the note", async () => {
    const host = await mount();
    await pick(host, [pdf("brief.pdf")]);
    expect(busy).toEqual([true, false]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([FILES, `${FILES}/${FILE}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`${FILES}/${FILE}/direct`);
    expect(latest.content?.find((node) => node.type === "attachment")).toMatchObject({ attrs: { attachmentId: FILE } });
    expect(host.querySelector('[data-testid="note-draft-chip"][data-kind="attachment"]')?.getAttribute("title")).toBe("brief.pdf");
  });

  it("refuses in the box a file over 25 MB, a blocked type and a sixth file, uploading none of them", async () => {
    const host = await mount();
    await pick(host, [pdf("huge.pdf", 25 * 1024 * 1024 + 1), new File([new Uint8Array(8)], "setup.exe", { type: "application/octet-stream" })]);
    expect(host.textContent).toContain("huge.pdf is larger than 25 MB");
    expect(host.textContent).toMatch(/setup\.exe/);
    expect(fetchMock).not.toHaveBeenCalled();

    await pick(host, Array.from({ length: 6 }, (_, n) => pdf(`page-${n + 1}.pdf`)));
    expect(host.textContent).toContain("A note can hold 5 attachments at most.");
    expect(host.textContent).not.toContain("A post can hold");
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === FILES)).toHaveLength(5);
  });

  it("reports a failed file to the host, so the note waits for a Retry or a Remove", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const host = await mount();
    await pick(host, [pdf("brief.pdf")]);
    expect(failed.at(-1)).toBe(1);
  });

  it("uploads an image through the link's routes, reports it busy until it lands, and shows it from the link", async () => {
    const host = await mount();
    await pick(host, [png()]);
    expect(busy).toEqual([true, false]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([BASE, `${BASE}/${MEDIA}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`${BASE}/${MEDIA}/direct`);
    expect(JSON.stringify(latest)).toContain(MEDIA);
    // It shows in the draft strip's chip, read from the link's own route.
    expect(host.querySelector<HTMLImageElement>('[data-testid="note-draft-chip"] img')!.getAttribute("src")).toBe(`${BASE}/${MEDIA}`);
  });
});
