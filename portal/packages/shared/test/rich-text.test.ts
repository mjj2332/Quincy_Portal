import { describe, expect, it } from "vitest";
import {
  RICH_TEXT_JSON_MAX_BYTES,
  RICH_TEXT_MAX_NESTING,
  RichTextValidationError,
  isHttpUrl,
  legacyBodyToRichTextDoc,
  normalizeRichTextMentionLabels,
  parseRichTextDoc,
  richTextMentionIds,
  richTextPlainText,
} from "../src/rich-text";

const userId = "11111111-1111-4111-8111-111111111111";
const valid = {
  type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "Hello ", marks: [{ type: "bold" }] },
    { type: "mention", attrs: { id: userId, label: "Terry" } },
    { type: "text", text: "!", marks: [{ type: "link", href: "https://example.test" }] },
  ] }],
};

describe("rich-text contract", () => {
  it("accepts the limited document model and derives mention labels as text", () => {
    const doc = parseRichTextDoc(valid);
    expect(richTextPlainText(doc)).toBe("Hello Terry!");
  });

  it("rejects unknown nodes and marks, unsafe links, malformed mention ids, and empty docs", () => {
    const cases = [
      { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "No" }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "No", marks: [{ type: "code" }] }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "No", marks: [{ type: "link", href: "javascript:alert(1)" }] }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "not-a-uuid", label: "No" } }] }] },
      { type: "doc", content: [] },
    ];
    for (const value of cases) expect(() => parseRichTextDoc(value)).toThrow(RichTextValidationError);
  });

  it("rejects excessive nesting and oversized JSON", () => {
    let nested: unknown = { type: "paragraph", content: [{ type: "text", text: "x" }] };
    for (let index = 0; index <= RICH_TEXT_MAX_NESTING; index += 1) nested = { type: "bulletList", content: [{ type: "listItem", content: [nested] }] };
    expect(() => parseRichTextDoc({ type: "doc", content: [nested] })).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(RICH_TEXT_JSON_MAX_BYTES) }] }] })).toThrow(RichTextValidationError);
  });

  it("de-duplicates mentions in their first-document order", () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const doc = parseRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "mention", attrs: { id: userId, label: "A" } },
      { type: "mention", attrs: { id: secondId, label: "B" } },
      { type: "mention", attrs: { id: userId, label: "A" } },
    ] }] });
    expect(richTextMentionIds(doc)).toEqual([userId, secondId]);
  });

  it("accepts hard breaks in list and top-level paragraphs, preserving text and mentions", () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const input = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Top" }, { type: "hardBreak" }, { type: "text", text: "level" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label: "Forged" } }, { type: "hardBreak" }, { type: "mention", attrs: { id: secondId, label: "Second" } }] }] }] },
      ],
    };
    const parsed = parseRichTextDoc(input);
    expect(parsed).toEqual(input);
    expect(richTextPlainText(parsed)).toBe("Top\nlevel\nForged\nSecond");
    expect(richTextMentionIds(parsed)).toEqual([userId, secondId]);
    expect(normalizeRichTextMentionLabels(parsed, new Map([[userId, "First"], [secondId, "Second normalized"]]))).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Top" }, { type: "hardBreak" }, { type: "text", text: "level" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label: "First" } }, { type: "hardBreak" }, { type: "mention", attrs: { id: secondId, label: "Second normalized" } }] }] }] },
      ],
    });
  });

  it("rejects attributes on hard breaks", () => {
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "No" }, { type: "hardBreak", attrs: {} }] }] })).toThrow(RichTextValidationError);
  });

  it("accepts underline and strike marks, while rejecting mark attributes", () => {
    const input = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Underlined", marks: [{ type: "underline" }] },
      { type: "text", text: " struck", marks: [{ type: "strike" }] },
    ] }] };
    expect(parseRichTextDoc(input)).toEqual(input);
    for (const mark of [{ type: "underline", attrs: {} }, { type: "strike", href: "https://example.test" }]) {
      expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "No", marks: [mark] }] }] })).toThrow(RichTextValidationError);
    }
  });

  it("shares HTTP(S) link classification without changing server validation messages", () => {
    expect(isHttpUrl("https://example.test/path")).toBe(true);
    expect(isHttpUrl("http://example.test")).toBe(true);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("/relative")).toBe(false);
    expect(isHttpUrl("mailto:hello@example.test")).toBe(false);
    const withHref = (href: unknown) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link", marks: [{ type: "link", href }] }] }] });
    expect(() => parseRichTextDoc(withHref(""))).toThrow("Link href must be a non-empty string");
    expect(() => parseRichTextDoc(withHref("/relative"))).toThrow("Link href must be an absolute HTTP(S) URL");
    expect(() => parseRichTextDoc(withHref("mailto:hello@example.test"))).toThrow("Link href must use HTTP(S)");
  });

  it("preserves every own key when normalizing future block shapes", () => {
    const futureShape = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Future" }] }],
    } as unknown as ReturnType<typeof parseRichTextDoc>;
    expect(normalizeRichTextMentionLabels(futureShape, new Map())).toEqual(futureShape);
    expect(richTextPlainText({ type: "doc", content: [{ type: "heading", attrs: { level: 2 } }] } as unknown as ReturnType<typeof parseRichTextDoc>)).toBe("");
    expect(richTextMentionIds({ type: "doc", content: [{ type: "heading", attrs: { level: 2 } }] } as unknown as ReturnType<typeof parseRichTextDoc>)).toEqual([]);
  });

  it("wraps legacy plain body values in a paragraph", () => {
    expect(legacyBodyToRichTextDoc("Existing notice")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Existing notice" }] }] });
  });
});
