import { describe, expect, it } from "vitest";
import {
  RICH_TEXT_JSON_MAX_BYTES,
  RICH_TEXT_MAX_NESTING,
  RichTextValidationError,
  isHttpUrl,
  legacyBodyToRichTextDoc,
  normalizeRichTextMentionLabels,
  parseRichTextDoc,
  richTextDocByteLength,
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

const taskListDoc = (count = 1, checked = false) => ({
  type: "doc" as const,
  content: [{ type: "taskList" as const, content: Array.from({ length: count }, () => ({
    type: "taskItem" as const,
    attrs: { checked },
    content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "abc" }] }],
  })) }],
});

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

  it("accepts only h2 and h3 document headings, preserving their inline content", () => {
    const input = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section" }, { type: "mention", attrs: { id: userId, label: "Terry" } }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Subsection" }] },
    ] };
    const parsed = parseRichTextDoc(input);
    expect(parsed).toEqual(input);
    expect(richTextPlainText(parsed)).toBe("SectionTerry\nSubsection");
    expect(richTextMentionIds(parsed)).toEqual([userId]);
    for (const heading of [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "No" }] },
      { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "No" }] },
      { type: "heading", attrs: { level: 2, extra: true }, content: [{ type: "text", text: "No" }] },
      { type: "heading", attrs: { level: 2 }, extra: true, content: [{ type: "text", text: "No" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "No" }] }] },
    ]) expect(() => parseRichTextDoc({ type: "doc", content: [heading] })).toThrow(RichTextValidationError);
  });

  it("rejects headings inside list items without narrowing legacy nested-list-first data", () => {
    const headingInList = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "No" }] }] }] }] };
    expect(() => parseRichTextDoc(headingInList)).toThrow(RichTextValidationError);
    const headingInNestedList = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [
      { type: "paragraph", content: [{ type: "text", text: "Outer item" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Nested heading" }] }] }] },
    ] }] }] };
    expect(() => parseRichTextDoc(headingInNestedList)).toThrow(RichTextValidationError);
    const legacyNestedFirst = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Still accepted" }] }] }] }] }] }] };
    expect(parseRichTextDoc(legacyNestedFirst)).toEqual(legacyNestedFirst);
  });

  it("accepts checked and unchecked task items, allowed cross-list nesting, and derives their text", () => {
    const input = {
      type: "doc",
      content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [
        { type: "paragraph", content: [{ type: "text", text: "Done" }] },
        { type: "orderedList", content: [{ type: "listItem", content: [
          { type: "paragraph", content: [{ type: "text", text: "Nested ordinary" }] },
          { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Nested task" }] }] }] },
        ] }] },
      ] }] }],
    };
    const parsed = parseRichTextDoc(input);
    expect(parsed).toEqual(input);
    expect(richTextPlainText(parsed)).toBe("Done\nNested ordinary\nNested task");
  });

  it("rejects malformed task-list shapes and task items beyond the depth-eight boundary", () => {
    const validTask = taskListDoc();
    const depthEight = { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [
      { type: "paragraph", content: [{ type: "text", text: "Level one" }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [
        { type: "paragraph", content: [{ type: "text", text: "Level two" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [
          { type: "paragraph", content: [{ type: "text", text: "Level three" }] },
          { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Level four" }] }] }] },
        ] }] },
      ] }] },
    ] }] }],
    };
    const malformed = [
      { type: "doc", content: [{ type: "taskList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "No" }] }] }] }] },
      { type: "doc", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Orphan" }] }] }] },
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: "false" }, content: [{ type: "paragraph", content: [{ type: "text", text: "No" }] }] }] }] },
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false, extra: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "No" }] }] }] }] },
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "No first paragraph" }] }] }] }] }] }] },
      { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "No heading" }] }] }] }] },
    ];
    for (const value of malformed) expect(() => parseRichTextDoc(value)).toThrow(RichTextValidationError);
    expect(parseRichTextDoc(validTask)).toEqual(validTask);
    expect(parseRichTextDoc(depthEight)).toEqual(depthEight);
    let nested: unknown = { type: "paragraph", content: [{ type: "text", text: "x" }] };
    for (let index = 0; index <= RICH_TEXT_MAX_NESTING; index += 1) nested = { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [nested] }] };
    expect(() => parseRichTextDoc({ type: "doc", content: [nested] })).toThrow(RichTextValidationError);
  });

  it("preserves checked attrs and mentions through normalization and re-parses the stored task document", () => {
    const input = {
      type: "doc",
      content: [{ type: "taskList", content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label: "Forged" } }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Unchecked" }] }] },
      ] }],
    };
    const parsed = parseRichTextDoc(input);
    expect(richTextMentionIds(parsed)).toEqual([userId]);
    const normalized = normalizeRichTextMentionLabels(parsed, new Map([[userId, "Terry normalized"]]));
    expect(normalized).toMatchObject({ content: [{ content: [
      { attrs: { checked: true }, content: [{ content: [{ attrs: { label: "Terry normalized" } }] }] },
      { attrs: { checked: false } },
    ] }] });
    expect(parseRichTextDoc(normalized)).toEqual({
      ...input,
      content: [{ ...input.content[0], content: [
        { ...input.content[0].content[0], content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label: "Terry normalized" } }] }] },
        input.content[0].content[1],
      ] }],
    });
  });

  it("measures canonical task-list byte boundaries independently of the visible character limit", () => {
    const accepted = taskListDoc(270);
    const rejected = taskListDoc(280);
    expect(richTextDocByteLength(accepted)).toBe(32_458);
    expect(richTextDocByteLength(rejected)).toBe(33_658);
    expect(richTextPlainText(accepted).length).toBe(1_079);
    expect(richTextPlainText(rejected).length).toBe(1_119);
    expect(parseRichTextDoc(accepted)).toEqual(accepted);
    expect(() => parseRichTextDoc(rejected)).toThrow(RichTextValidationError);
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

  it("preserves heading attrs through parse, normalization, and re-parse", () => {
    const headingDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "mention", attrs: { id: userId, label: "Forged" } }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Subsection" }] },
      ],
    };
    const parsed = parseRichTextDoc(headingDoc);
    const normalized = normalizeRichTextMentionLabels(parsed, new Map([[userId, "Terry normalized"]]));
    expect(normalized.content[0]).toMatchObject({ type: "heading", attrs: { level: 2 }, content: [{ type: "mention", attrs: { id: userId, label: "Terry normalized" } }] });
    expect(normalized.content[1]).toMatchObject({ type: "heading", attrs: { level: 3 } });
    expect(parseRichTextDoc(normalized)).toEqual({
      ...headingDoc,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "mention", attrs: { id: userId, label: "Terry normalized" } }] },
        headingDoc.content[1],
      ],
    });
    const contentless = { type: "doc", content: [{ type: "heading", attrs: { level: 2 } }] } as unknown as ReturnType<typeof parseRichTextDoc>;
    expect(richTextPlainText(contentless)).toBe("");
    expect(richTextMentionIds(contentless)).toEqual([]);
  });

  it("wraps legacy plain body values in a paragraph", () => {
    expect(legacyBodyToRichTextDoc("Existing notice")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Existing notice" }] }] });
  });
});
