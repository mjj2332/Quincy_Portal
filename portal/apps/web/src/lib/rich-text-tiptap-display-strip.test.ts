import { describe, expect, it } from "vitest";
import { richTextDocByteLength, type RichTextDoc } from "@quincy/shared";
import { stripEmbeddedDisplay } from "./rich-text-tiptap";

const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const MAX = 32 * 1024;

describe("stripEmbeddedDisplay (#556)", () => {
  it("drops the served-only hasPoster flag from videos so size checks and submission measure the stored form", () => {
    // Pad a paragraph so the stored form is exactly at the byte limit, then let the flag push the served form over it.
    const doc = (pad: number, flag: boolean): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(pad) }] }, { type: "video", attrs: { mediaId: A, ...(flag ? { hasPoster: true } : {}) } }] });
    let pad = MAX; while (richTextDocByteLength(doc(pad, false)) > MAX) pad -= 1;
    const served = doc(pad, true);
    expect(richTextDocByteLength(doc(pad, false))).toBeLessThanOrEqual(MAX);
    expect(richTextDocByteLength(served)).toBeGreaterThan(MAX);
    const submitted = stripEmbeddedDisplay(served);
    expect(richTextDocByteLength(submitted)).toBeLessThanOrEqual(MAX);
    expect(JSON.stringify(submitted)).not.toContain("hasPoster");
    expect(submitted).toEqual(doc(pad, false));
  });

  it("still reduces link cards to the preview id, and returns the same doc when there is nothing to strip", () => {
    const card: RichTextDoc = { type: "doc", content: [{ type: "linkPreview", attrs: { previewId: P, url: "https://a.test", title: "T", description: null, siteName: null, imageMediaId: null } as never }] };
    expect(stripEmbeddedDisplay(card).content).toEqual([{ type: "linkPreview", attrs: { previewId: P } }]);
    const plain: RichTextDoc = { type: "doc", content: [{ type: "video", attrs: { mediaId: A } }] };
    expect(stripEmbeddedDisplay(plain)).toBe(plain);
  });

  it("drops the served-only width and height from images (#611) and keeps the alt text", () => {
    const served: RichTextDoc = { type: "doc", content: [{ type: "image", attrs: { mediaId: A, alt: "Front", width: 511, height: 384 } }, { type: "image", attrs: { mediaId: P } }] };
    const submitted = stripEmbeddedDisplay(served);
    expect(submitted.content).toEqual([{ type: "image", attrs: { mediaId: A, alt: "Front" } }, { type: "image", attrs: { mediaId: P } }]);
    const plain: RichTextDoc = { type: "doc", content: [{ type: "image", attrs: { mediaId: A } }] };
    expect(stripEmbeddedDisplay(plain)).toBe(plain);
  });
});
