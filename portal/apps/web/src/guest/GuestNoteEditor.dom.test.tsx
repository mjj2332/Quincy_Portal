import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const uploadMultipartFile = vi.hoisted(() => vi.fn());
vi.mock("../lib/multipart-upload", () => ({ uploadMultipartFile }));
const { GuestNoteEditor } = await import("./GuestNoteEditor");
const { createGuestMediaTransport } = await import("./guest-api");

/** The real rich field on a Review link (#835 C): no mentions, and every byte goes through the link's own media routes. */
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}/media`;
const MEDIA = "33333333-3333-4333-8333-333333333333";
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const png = () => new File([new Uint8Array(8)], "site.png", { type: "image/png" });

let root: Root | null = null;
let latest: RichTextDoc = empty();
let busy: boolean[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
const transport = createGuestMediaTransport(LINK);
function Harness() {
  const [value, setValue] = useState(empty());
  return <GuestNoteEditor testId="field" label="Your note" media={transport} value={value} onChange={(next) => { latest = next; setValue(next); }} onUploadingChange={(uploading) => { busy.push(uploading); }} />;
}
async function mount() {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  // The editor is a lazy chunk in the page; here it is imported, so it renders at once.
  await act(async () => { root!.render(<Harness />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  latest = empty(); busy = [];
  uploadMultipartFile.mockReset(); uploadMultipartFile.mockResolvedValue({});
  fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === BASE ? json({ mediaId: MEDIA, devDirect: true }) : String(input).endsWith("/complete") ? json({ mediaId: MEDIA, state: "pending" }) : new Response(null, { status: 204 }));
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

  it("offers Insert image and Insert video, and its picker takes no HEIC", async () => {
    const host = await mount();
    expect(host.querySelector('button[aria-label="Insert image"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Insert video"]')).not.toBeNull();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Insert image"]')!.click(); });
    click.mockRestore();
    expect(host.querySelector<HTMLInputElement>('input[data-testid="rich-text-image-picker"]')!.accept).toBe("image/jpeg,image/png,image/webp");
  });

  it("uploads an image through the link's routes, reports it busy until it lands, and shows it from the link", async () => {
    const host = await mount();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Insert image"]')!.click(); });
    click.mockRestore();
    const picker = host.querySelector<HTMLInputElement>('input[data-testid="rich-text-image-picker"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [png()] });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(); await settle();
    expect(busy).toEqual([true, false]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([BASE, `${BASE}/${MEDIA}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`${BASE}/${MEDIA}/direct`);
    expect(JSON.stringify(latest)).toContain(MEDIA);
    expect(host.querySelector<HTMLImageElement>(`img[data-media-id="${MEDIA}"]`)!.getAttribute("src")).toBe(`${BASE}/${MEDIA}`);
  });
});
