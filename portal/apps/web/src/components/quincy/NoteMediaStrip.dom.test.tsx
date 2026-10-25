import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RichTextBlock, RichTextDoc, RichTextImage, RichTextVideo } from "@quincy/shared";
import { NoteBody, NoteMediaThumb } from "./NoteMediaStrip";

/**
 * #927 T1: a posted note reads as its text, then one strip of 56px tiles. A tile opens the media's larger view: the image dialog an
 * embedded image already opens, and the Portal's player for a video. A Review link reads the bytes from its own routes, so every tile
 * and every dialog takes the caller's URLs.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }

const p = (text: string): RichTextBlock => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (mediaId: string, alt = "Kitchen"): RichTextImage => ({ type: "image", attrs: { mediaId, alt } });
const video = (mediaId: string, hasPoster = true): RichTextVideo => ({ type: "video", attrs: { mediaId, hasPoster } });
const doc = (...content: RichTextBlock[]): RichTextDoc => ({ type: "doc", content });
const strip = (host: ParentNode) => host.querySelector<HTMLElement>('[data-testid="note-media-strip"]');
const tiles = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-testid="note-media-strip"] > li')];

const guestMedia = (mediaId: string) => `/d/review/media/${mediaId}`;
const guestPoster = (mediaId: string) => `/d/review/media/${mediaId}/poster`;

describe("NoteBody: a note's files (#955)", () => {
  const file = (attachmentId: string, name?: string, bytes?: number): RichTextBlock => ({ type: "attachment", attrs: { attachmentId, ...(name ? { name } : {}), ...(bytes ? { bytes } : {}) } });
  const chips = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-testid="attachment-chip"]')];

  it("draws the text, the media strip, then the files as download chips, at the staff route by default", () => {
    const host = mount(<NoteBody content={doc(p("Plan"), file(B, "Grade notes.pdf", 40_000), image(A))} />);
    const order = [...host.querySelectorAll<HTMLElement>('[data-testid="note-body-text"], [data-testid="note-media-strip"], [data-testid="attachment-list"]')].map((node) => node.dataset.testid);
    expect(order).toEqual(["note-body-text", "note-media-strip", "attachment-list"]);
    expect(host.querySelector('[data-testid="note-body-text"] [data-testid="attachment-chip"]')).toBeNull();
    expect(chips(host).map((chip) => [chip.getAttribute("href"), chip.getAttribute("aria-label")])).toEqual([[`/media/attachments/${B}`, "Download Grade notes.pdf, 40 KB"]]);
  });

  it("downloads from the caller's route on a Review link, and draws a file the server no longer serves as unavailable", () => {
    const host = mount(<NoteBody content={doc(file(A, "LUT.zip", 2_500_000), file(B))} attachmentUrl={(id) => `/d/api/links/L/attachments/${id}`} />);
    expect(host.querySelector('[data-testid="note-body-text"]')).toBeNull();
    expect(chips(host).map((chip) => [chip.dataset.state, chip.getAttribute("href")])).toEqual([["ready", `/d/api/links/L/attachments/${A}`], ["unavailable", null]]);
  });
});

describe("NoteBody", () => {
  it("draws the text, then the strip, with the media in document order", () => {
    const host = mount(<NoteBody content={doc(p("Before"), image(A), p("After"), video(B))} />);
    const text = host.querySelector('[data-testid="note-body-text"]')!;
    expect([...text.querySelectorAll("p")].map((node) => node.textContent)).toEqual(["Before", "After"]);
    // No media is left inside the text.
    expect(text.querySelector('[data-testid="embedded-image"], [data-testid="embedded-video"], video')).toBeNull();
    expect(text.compareDocumentPosition(strip(host)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tiles(host).map((tile) => tile.querySelector("button")!.getAttribute("aria-label"))).toEqual(["View image: Kitchen", "Play video"]);
  });

  it("draws no strip for a text-only note", () => {
    const host = mount(<NoteBody content={doc(p("Just words"))} />);
    expect(host.querySelector('[data-testid="note-body-text"]')?.textContent).toBe("Just words");
    expect(strip(host)).toBeNull();
  });

  it("draws only the strip for a media-only note, with no blank text above it", () => {
    const host = mount(<NoteBody content={doc(image(A), { type: "paragraph" })} />);
    expect(host.querySelector('[data-testid="note-body-text"]')).toBeNull();
    expect(tiles(host)).toHaveLength(1);
  });

  it("names the strip for a screen reader", () => {
    const host = mount(<NoteBody content={doc(image(A))} />);
    expect(strip(host)?.tagName).toBe("UL");
    expect(strip(host)?.getAttribute("aria-label")).toBe("Attached media");
  });
});

describe("an image tile", () => {
  it("is the picture at 56px, cropped to the square, from the staff route by default", () => {
    const host = mount(<NoteMediaThumb node={image(A)} />);
    const trigger = host.querySelector<HTMLElement>('[data-testid="embedded-image"]')!;
    expect(trigger.getAttribute("data-size")).toBe("thumb");
    expect(trigger.className).toContain("size-[calc(var(--space-7)+var(--space-2))]");
    const picture = trigger.querySelector("img")!;
    expect(picture.getAttribute("src")).toBe(`/media/embedded/${A}`);
    expect(picture.className).toContain("object-cover");
    // A tile is a fixed square: the posted size never stretches it.
    expect(trigger.hasAttribute("data-sized")).toBe(false);
  });

  it("opens the image dialog with the picture as posted", async () => {
    const host = mount(<NoteMediaThumb node={image(A)} />);
    await click(host.querySelector('[data-testid="embedded-image"]')!);
    expect(document.querySelector('[data-testid="embedded-image-dialog"] img')?.getAttribute("src")).toBe(`/media/embedded/${A}`);
    expect(document.querySelector('[data-testid="embedded-image-dialog"]')?.textContent).toContain("The image as posted.");
  });

  it("reads a Review link's own route, in the tile and in the dialog", async () => {
    const host = mount(<NoteMediaThumb node={image(A)} mediaUrl={guestMedia} />);
    expect(host.querySelector('[data-testid="embedded-image"] img')?.getAttribute("src")).toBe(guestMedia(A));
    await click(host.querySelector('[data-testid="embedded-image"]')!);
    expect(document.querySelector('[data-testid="embedded-image-dialog"] img')?.getAttribute("src")).toBe(guestMedia(A));
  });

  it("says the image is unavailable, in a tile of the same size, when the file cannot load", () => {
    const host = mount(<NoteMediaThumb node={image(A)} />);
    act(() => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    const unavailable = host.querySelector<HTMLElement>('[data-testid="embedded-image-unavailable"]')!;
    expect(unavailable.getAttribute("aria-label")).toBe("Image unavailable");
    expect(unavailable.className).toContain("size-[calc(var(--space-7)+var(--space-2))]");
  });
});

describe("a video tile", () => {
  it("shows the poster frame, with no player in the strip", () => {
    const host = mount(<NoteMediaThumb node={video(A)} />);
    const trigger = host.querySelector<HTMLElement>('[data-testid="embedded-video-thumb"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Play video");
    expect(trigger.className).toContain("size-[calc(var(--space-7)+var(--space-2))]");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe(`/media/embedded/${A}/poster`);
    expect(host.querySelector("video")).toBeNull();
  });

  it("asks for no poster when the server says there is none", () => {
    const host = mount(<NoteMediaThumb node={video(A, false)} />);
    expect(host.querySelector('[data-testid="embedded-video-thumb"] img')).toBeNull();
  });

  it("falls back to the plain tile when the poster cannot load", () => {
    const host = mount(<NoteMediaThumb node={video(A)} />);
    act(() => { host.querySelector('[data-testid="embedded-video-thumb"] img')!.dispatchEvent(new Event("error")); });
    expect(host.querySelector('[data-testid="embedded-video-thumb"] img')).toBeNull();
    expect(host.querySelector('[data-testid="embedded-video-thumb"]')).not.toBeNull();
  });

  it("opens the Portal's player in a dialog, from a Review link's own routes", async () => {
    const host = mount(<NoteMediaThumb node={video(A)} mediaUrl={guestMedia} posterUrl={guestPoster} />);
    expect(host.querySelector('[data-testid="embedded-video-thumb"] img')?.getAttribute("src")).toBe(guestPoster(A));
    await click(host.querySelector('[data-testid="embedded-video-thumb"]')!);
    const player = document.querySelector<HTMLVideoElement>('[data-testid="embedded-video-dialog"] video')!;
    expect(player.getAttribute("src")).toBe(guestMedia(A));
    expect(player.getAttribute("poster")).toBe(guestPoster(A));
    expect(player.hasAttribute("controls")).toBe(true);
    expect(document.querySelector('[data-testid="embedded-video-dialog"]')?.getAttribute("data-surface")).toBe("inverse");
    expect(document.querySelector('[data-testid="embedded-video-dialog"] [data-testid="embedded-video-close"]')?.textContent).toContain("Close");
  });
});
