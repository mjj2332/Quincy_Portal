import { describe, expect, it } from "vitest";
import {
  RICH_TEXT_JSON_MAX_BYTES,
  RICH_TEXT_MAX_NESTING,
  RichTextValidationError,
  legacyBodyToRichTextDoc,
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

  it("wraps legacy plain body values in a paragraph", () => {
    expect(legacyBodyToRichTextDoc("Existing notice")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Existing notice" }] }] });
  });
});
