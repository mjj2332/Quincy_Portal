import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RichTextBlock, RichTextDoc } from "@quincy/shared";
import { splitNoteMedia } from "./note-media-strip";

/** #927 T1: a posted note reads as its text, then one strip of its media. The split is display-only and never rewrites the stored document. */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const p = (text: string): RichTextBlock => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (mediaId: string): RichTextBlock => ({ type: "image", attrs: { mediaId, alt: "Kitchen" } });
const video = (mediaId: string): RichTextBlock => ({ type: "video", attrs: { mediaId, hasPoster: true } });
const list = (...items: string[]): RichTextBlock => ({ type: "bulletList", content: items.map((text) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })) });
const doc = (...content: RichTextBlock[]): RichTextDoc => ({ type: "doc", content });

describe("splitNoteMedia", () => {
  it("leaves a text-only note whole, with no media", () => {
    const note = doc(p("Lift the shadows"), p("on the left wall"));
    expect(splitNoteMedia(note)).toEqual({ text: doc(p("Lift the shadows"), p("on the left wall")), media: [] });
  });

  it("takes the media off the end of a new note", () => {
    expect(splitNoteMedia(doc(p("Like this"), image(A), video(B)))).toEqual({ text: doc(p("Like this")), media: [image(A), video(B)] });
  });

  it("moves media placed mid-text in an old note to the strip, keeping the text around it in order", () => {
    expect(splitNoteMedia(doc(p("Before"), image(A), p("Between"), video(B), p("After")))).toEqual({
      text: doc(p("Before"), p("Between"), p("After")),
      media: [image(A), video(B)],
    });
  });

  it("keeps the lists on either side of a picture as the two lists they were", () => {
    expect(splitNoteMedia(doc(list("One", "Two"), image(A), list("Three")))).toEqual({ text: doc(list("One", "Two"), list("Three")), media: [image(A)] });
  });

  it("gives a media-only note no text, even with the empty paragraph the editor leaves after a picture", () => {
    expect(splitNoteMedia(doc(image(A), video(B)))).toEqual({ text: null, media: [image(A), video(B)] });
    expect(splitNoteMedia(doc(image(A), { type: "paragraph" }))).toEqual({ text: null, media: [image(A)] });
    expect(splitNoteMedia(doc({ type: "paragraph", content: [] }, video(B)))).toEqual({ text: null, media: [video(B)] });
  });

  it("keeps the media in document order, whatever their kind", () => {
    const { media } = splitNoteMedia(doc(video(C), p("x"), image(A), video(B)));
    expect(media.map((node) => node.attrs.mediaId)).toEqual([C, A, B]);
  });

  it("never changes the document it was given", () => {
    const note = doc(p("Before"), image(A), list("One"), video(B), { type: "paragraph" });
    const before = structuredClone(note);
    const split = splitNoteMedia(note);
    expect(note).toEqual(before);
    expect(split.text).not.toBe(note);
    expect(split.text?.content).not.toBe(note.content);
  });
});

/**
 * The Review link (#741 12b) will draw the same strip, so nothing it imports may reach the staff app's session, API or router: the
 * modules `guest/guest-boundary.guard.test.ts` bans. That guard scans only what the guest tree imports today, so this holds the strip
 * to it before the guest adopts it.
 */
describe("the strip is Guest-safe", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const BANNED = /^(?:lib\/(?:auth|api|router|app-router|query-client|staff-history|location-store)|components\/InternalLink)\.tsx?$/;
  const resolveFrom = (from: string, specifier: string): string | null => {
    const base = specifier.startsWith("@/") ? specifier.slice(2) : specifier.startsWith(".") ? join(dirname(from), specifier) : null;
    if (base === null) return null;
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => existsSync(join(srcDir, candidate))) ?? null;
  };
  const reach = (root: string) => {
    const seen = new Set([root]); const queue = [root];
    while (queue.length) {
      const file = queue.shift()!;
      const source = readFileSync(join(srcDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
        if (specifier!.startsWith("@tanstack/")) seen.add(specifier!);
        const next = resolveFrom(file, specifier!);
        if (next !== null && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return [...seen];
  };

  it("reaches no staff module and no TanStack package", () => {
    const reached = reach("components/quincy/NoteMediaStrip.tsx");
    // The scan follows the imports: the strip's own pieces are in it.
    expect(reached).toEqual(expect.arrayContaining(["lib/note-media-strip.ts", "components/quincy/EmbeddedImage.tsx", "components/quincy/EmbeddedVideo.tsx", "components/RichTextContent.tsx"]));
    expect(reached.filter((file) => BANNED.test(file) || file.startsWith("@tanstack/"))).toEqual([]);
  });
});
