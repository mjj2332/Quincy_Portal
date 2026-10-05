import { describe, expect, it } from "vitest";
import {
  NOTICE_BODY_MAX_LENGTH,
  NOTICE_RICH_TEXT_JSON_MAX_BYTES,
  COMMENT_MEDIA_RICH_TEXT_PROFILE,
  NOTICE_RICH_TEXT_PROFILE,
  RICH_TEXT_JSON_MAX_BYTES,
  RICH_TEXT_MAX_NESTING,
  RichTextValidationError,
  isHttpUrl,
  legacyBodyToRichTextDoc,
  normalizeRichTextMentionLabels,
  parseRichTextDoc,
  richTextDocByteLength,
  richTextLinkPreviewIds,
  richTextMediaIds,
  richTextMediaRefs,
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


describe("document profile (#492)", () => {
  const para = (text: string, extra: Record<string, unknown> = {}) => ({ type: "paragraph", ...extra, content: [{ type: "text", text }] });
  const cell = (text: string, extra: Record<string, unknown> = {}) => ({ type: "tableCell", ...extra, content: [para(text)] });
  const richDoc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "Title" }] },
      para("Aligned", { attrs: { textAlign: "right" } }),
      { type: "paragraph", content: [{ type: "text", text: "Marked", marks: [{ type: "highlight", color: "green" }] }] },
      { type: "table", content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [para("A")] }, { type: "tableHeader", content: [para("B")] }] },
        { type: "tableRow", content: [cell("1", { attrs: { colspan: 2, rowspan: 1 } })] },
      ] },
    ],
  };

  it("accepts tables, alignment and highlight under the notice profile and keeps them", () => {
    const doc = parseRichTextDoc(richDoc, NOTICE_RICH_TEXT_PROFILE);
    expect(doc).toEqual(richDoc);
  });

  it("rejects each of them under the default comment profile", () => {
    for (const block of richDoc.content.slice(0, 4)) {
      expect(() => parseRichTextDoc({ type: "doc", content: [para("ok"), block] })).toThrow(RichTextValidationError);
    }
  });

  it("keeps the comment cap at 32 KiB and raises the notice cap to 64 KiB", () => {
    const sized = (bytes: number) => ({ type: "doc", content: [para("x".repeat(bytes - 70))] });
    const forty = sized(40 * 1024);
    expect(() => parseRichTextDoc(forty)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(forty, NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
    expect(() => parseRichTextDoc(sized(NOTICE_RICH_TEXT_JSON_MAX_BYTES + 1), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(NOTICE_BODY_MAX_LENGTH).toBe(10_000);
  });

  it("bounds tables: rows, columns, spans, nesting and cell content", () => {
    const row = (cells: number) => ({ type: "tableRow", content: Array.from({ length: cells }, () => cell("x")) });
    const table = (rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });
    expect(() => parseRichTextDoc(table([row(12)]), NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
    expect(() => parseRichTextDoc(table([row(13)]), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(table(Array.from({ length: 50 }, () => row(1))), NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
    expect(() => parseRichTextDoc(table(Array.from({ length: 51 }, () => row(1))), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(table([{ type: "tableRow", content: [cell("x", { attrs: { colspan: 0, rowspan: 1 } })] }]), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(table([{ type: "tableRow", content: [cell("x", { attrs: { colspan: 1, rowspan: 1, colwidth: [10] } })] }]), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(table([{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "bulletList", content: [] }] }] }]), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "table", content: [row(1)] }] }] }] }, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("accepts a row fully covered by rowspans as content: [] and rejects an uncovered empty row", () => {
    const span = (text: string) => cell(text, { attrs: { colspan: 1, rowspan: 2 } });
    const table = (rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });
    const covered = table([{ type: "tableRow", content: [span("a"), span("b")] }, { type: "tableRow", content: [] }]);
    expect(parseRichTextDoc(covered, NOTICE_RICH_TEXT_PROFILE)).toEqual(covered);
    // Only one of two columns is covered, so the empty row is still malformed.
    const partial = table([{ type: "tableRow", content: [span("a"), cell("b")] }, { type: "tableRow", content: [] }]);
    expect(() => parseRichTextDoc(partial, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(table([{ type: "tableRow", content: [] }]), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("bounds rowspan by the 50-row limit and colspan by the 12-column limit", () => {
    const table = (rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });
    const tall = (n: number, span: number) => table([
      { type: "tableRow", content: [cell("a", { attrs: { colspan: 1, rowspan: span } })] },
      ...Array.from({ length: n - 1 }, () => ({ type: "tableRow", content: [] })),
    ]);
    expect(parseRichTextDoc(tall(13, 13), NOTICE_RICH_TEXT_PROFILE)).toEqual(tall(13, 13));
    expect(() => parseRichTextDoc(tall(50, 51), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(table([{ type: "tableRow", content: [cell("a", { attrs: { colspan: 13, rowspan: 1 } })] }]), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("rejects unknown alignment and highlight values", () => {
    expect(() => parseRichTextDoc({ type: "doc", content: [para("x", { attrs: { textAlign: "left" } })] }, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "highlight", color: "red" }] }] }] }, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "highlight", color: "yellow", css: "x" }] }] }] }, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("reads a table as tab-separated cells and newline-separated rows, finds mentions in cells, and keeps alignment through normalisation", () => {
    const withMention = {
      type: "doc",
      content: [
        para("Lead", { attrs: { textAlign: "center" } }),
        { type: "table", content: [{ type: "tableRow", content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label: "Old" } }] }] },
          cell("B"),
        ] }] },
      ],
    };
    const doc = parseRichTextDoc(withMention, NOTICE_RICH_TEXT_PROFILE);
    expect(richTextPlainText(doc)).toBe("Lead\nOld\tB");
    expect(richTextMentionIds(doc)).toEqual([userId]);
    const renamed = normalizeRichTextMentionLabels(doc, new Map([[userId, "Terry"]]));
    expect(richTextPlainText(renamed)).toBe("Lead\nTerry\tB");
    expect(renamed.content[0]).toEqual(para("Lead", { attrs: { textAlign: "center" } }));
    expect(() => parseRichTextDoc(renamed, NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
  });

  it("still parses every comment-profile document under the notice profile", () => {
    expect(parseRichTextDoc(valid, NOTICE_RICH_TEXT_PROFILE)).toEqual(parseRichTextDoc(valid));
    expect(parseRichTextDoc(taskListDoc(3, true), NOTICE_RICH_TEXT_PROFILE)).toEqual(parseRichTextDoc(taskListDoc(3, true)));
  });
});


describe("image node (#493)", () => {
  const mediaA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const mediaB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const image = (mediaId: unknown, extra: Record<string, unknown> = {}) => ({ type: "image", attrs: { mediaId, ...extra } });
  const withImages = (...nodes: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Look" }] }, ...nodes] });

  it("is rejected by the default comment profile, and accepted at the top level by the notice profile (#496)", () => {
    expect(() => parseRichTextDoc(withImages(image(mediaA)))).toThrow(RichTextValidationError);
    const input = withImages(image(mediaA), image(mediaB));
    expect(parseRichTextDoc(input, NOTICE_RICH_TEXT_PROFILE)).toEqual(input);
    expect(richTextMediaIds(parseRichTextDoc(input, NOTICE_RICH_TEXT_PROFILE))).toEqual([mediaA, mediaB]);
    const inCell = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [image(mediaA)] }] }] }] };
    expect(() => parseRichTextDoc(inCell, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    const inList = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, image(mediaA)] }] }] };
    expect(() => parseRichTextDoc(inList, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("is accepted under the comment media profile, referenced by id only, and read back in document order", () => {
    const input = withImages(image(mediaB), image(mediaA));
    const doc = parseRichTextDoc(input, COMMENT_MEDIA_RICH_TEXT_PROFILE);
    expect(doc).toEqual(input);
    expect(richTextMediaIds(doc)).toEqual([mediaB, mediaA]);
    expect(richTextMediaIds(parseRichTextDoc(valid))).toEqual([]);
  });

  it("is strict: only a UUID mediaId, no extra attributes or keys, and only at the top level", () => {
    const profile = COMMENT_MEDIA_RICH_TEXT_PROFILE;
    const bad = [
      withImages(image("not-a-uuid")),
      withImages(image(undefined)),
      withImages(image(mediaA, { src: "https://evil.test/x.png" })),
      withImages(image(mediaA, { src: "data:image/png;base64,AAAA" })),
      withImages({ type: "image" }),
      withImages({ type: "image", attrs: { mediaId: mediaA }, content: [] }),
      withImages({ type: "image", attrs: { mediaId: mediaA }, src: "x" }),
      { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, image(mediaA)] }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }, image(mediaA)] }] },
    ];
    for (const value of bad) expect(() => parseRichTextDoc(value, profile), JSON.stringify(value)).toThrow(RichTextValidationError);
  });

  it("rejects a duplicated media id", () => {
    expect(() => parseRichTextDoc(withImages(image(mediaA), image(mediaA)), COMMENT_MEDIA_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("reads as [image] in plain text, so an image-only post is valid and a notification body has a placeholder", () => {
    const only = parseRichTextDoc({ type: "doc", content: [image(mediaA)] }, COMMENT_MEDIA_RICH_TEXT_PROFILE);
    expect(richTextPlainText(only)).toBe("[image]");
    expect(richTextPlainText(parseRichTextDoc(withImages(image(mediaA), image(mediaB)), COMMENT_MEDIA_RICH_TEXT_PROFILE))).toBe("Look\n[image]\n[image]");
  });

  it("survives mention-label normalisation untouched", () => {
    const doc = parseRichTextDoc(withImages(image(mediaA)), COMMENT_MEDIA_RICH_TEXT_PROFILE);
    expect(normalizeRichTextMentionLabels(doc, new Map())).toEqual(doc);
  });

  it("keeps the comment media profile identical to the comment profile otherwise", () => {
    expect(() => parseRichTextDoc({ type: "doc", content: [{ type: "table", content: [] }] }, COMMENT_MEDIA_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(parseRichTextDoc(valid, COMMENT_MEDIA_RICH_TEXT_PROFILE)).toEqual(parseRichTextDoc(valid));
  });
});

describe("video node (#494)", () => {
  const mediaA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const mediaB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const mediaC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const video = (mediaId: unknown, extra: Record<string, unknown> = {}) => ({ type: "video", attrs: { mediaId, ...extra } });
  const image = (mediaId: unknown) => ({ type: "image", attrs: { mediaId } });
  const withNodes = (...nodes: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Look" }] }, ...nodes] });

  it("is accepted under the comment media profile only, never the default, comment or notice profiles", () => {
    const input = withNodes(video(mediaA));
    expect(parseRichTextDoc(input, COMMENT_MEDIA_RICH_TEXT_PROFILE)).toEqual(input);
    expect(() => parseRichTextDoc(input)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(input, NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("reads media ids and kinds in document order, images and videos together", () => {
    const doc = parseRichTextDoc(withNodes(video(mediaB), image(mediaA), video(mediaC)), COMMENT_MEDIA_RICH_TEXT_PROFILE);
    expect(richTextMediaIds(doc)).toEqual([mediaB, mediaA, mediaC]);
    expect(richTextMediaRefs(doc)).toEqual([{ id: mediaB, kind: "video" }, { id: mediaA, kind: "image" }, { id: mediaC, kind: "video" }]);
    expect(richTextMediaRefs(parseRichTextDoc(valid))).toEqual([]);
  });

  it("is strict: only a UUID mediaId, no extra attributes or keys, and only at the top level", () => {
    const profile = COMMENT_MEDIA_RICH_TEXT_PROFILE;
    const bad = [
      withNodes(video("not-a-uuid")),
      withNodes(video(undefined)),
      withNodes(video(mediaA, { src: "https://evil.test/v.mp4" })),
      withNodes({ type: "video" }),
      withNodes({ type: "video", attrs: { mediaId: mediaA }, content: [] }),
      withNodes({ type: "video", attrs: { mediaId: mediaA }, src: "x" }),
      { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, video(mediaA)] }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }, video(mediaA)] }] },
    ];
    for (const value of bad) expect(() => parseRichTextDoc(value, profile), JSON.stringify(value)).toThrow(RichTextValidationError);
  });

  it("places one media id only once across images and videos", () => {
    expect(() => parseRichTextDoc(withNodes(video(mediaA), video(mediaA)), COMMENT_MEDIA_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(withNodes(video(mediaA), image(mediaA)), COMMENT_MEDIA_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("reads as [video] in plain text, so a video-only post is valid, and survives mention-label normalisation", () => {
    const only = parseRichTextDoc({ type: "doc", content: [video(mediaA)] }, COMMENT_MEDIA_RICH_TEXT_PROFILE);
    expect(richTextPlainText(only)).toBe("[video]");
    expect(richTextPlainText(parseRichTextDoc(withNodes(video(mediaA), image(mediaB)), COMMENT_MEDIA_RICH_TEXT_PROFILE))).toBe("Look\n[video]\n[image]");
    expect(normalizeRichTextMentionLabels(only, new Map())).toEqual(only);
    expect(richTextMentionIds(only)).toEqual([]);
  });
});

describe("link preview node (#497)", () => {
  const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const idC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const idD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const card = (previewId: unknown, extra: Record<string, unknown> = {}) => ({ type: "linkPreview", attrs: { previewId, ...extra } });
  const withNodes = (...nodes: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See ", marks: [] }, { type: "text", text: "this", marks: [{ type: "link", href: "https://example.test/a" }] }] }, ...nodes] });

  it("is accepted under the comment media and notice profiles, never the default comment profile", () => {
    const input = withNodes(card(idA));
    expect(parseRichTextDoc(input, COMMENT_MEDIA_RICH_TEXT_PROFILE)).toEqual(input);
    expect(parseRichTextDoc(input, NOTICE_RICH_TEXT_PROFILE)).toEqual(input);
    expect(() => parseRichTextDoc(input)).toThrow(RichTextValidationError);
  });

  it("is top level only and an exact node", () => {
    const bad = [
      withNodes(card("not-a-uuid")),
      withNodes(card(undefined)),
      withNodes({ type: "linkPreview" }),
      withNodes({ type: "linkPreview", attrs: { previewId: idA }, content: [] }),
      withNodes({ type: "linkPreview", attrs: { previewId: idA }, src: "x" }),
      withNodes(card(idA, { href: "https://evil.test" })),
      { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, card(idA)] }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }, card(idA)] }] },
    ];
    for (const value of bad) {
      expect(() => parseRichTextDoc(value, COMMENT_MEDIA_RICH_TEXT_PROFILE), JSON.stringify(value)).toThrow(RichTextValidationError);
      expect(() => parseRichTextDoc(value, NOTICE_RICH_TEXT_PROFILE), JSON.stringify(value)).toThrow(RichTextValidationError);
    }
  });

  it("allows three cards and refuses a fourth or a repeated id", () => {
    expect(richTextLinkPreviewIds(parseRichTextDoc(withNodes(card(idA), card(idB), card(idC)), COMMENT_MEDIA_RICH_TEXT_PROFILE))).toEqual([idA, idB, idC]);
    expect(() => parseRichTextDoc(withNodes(card(idA), card(idB), card(idC), card(idD)), COMMENT_MEDIA_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(() => parseRichTextDoc(withNodes(card(idA), card(idA)), NOTICE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("drops the display fields a served document carries, so a forged title is never stored", () => {
    const served = withNodes(card(idA, { url: "https://example.test/a", title: "Forged", description: "Forged", siteName: "Forged", imageMediaId: idB }));
    expect(parseRichTextDoc(served, COMMENT_MEDIA_RICH_TEXT_PROFILE)).toEqual(withNodes(card(idA)));
    expect(parseRichTextDoc(withNodes(card(idA, { title: null, imageMediaId: null })), NOTICE_RICH_TEXT_PROFILE)).toEqual(withNodes(card(idA)));
  });

  it("adds nothing to plain text, mention ids or media ids, and survives mention-label normalisation", () => {
    const doc = parseRichTextDoc(withNodes(card(idA), { type: "image", attrs: { mediaId: idB } }), COMMENT_MEDIA_RICH_TEXT_PROFILE);
    expect(richTextPlainText(doc)).toBe("See this\n[image]");
    expect(richTextMentionIds(doc)).toEqual([]);
    expect(richTextMediaIds(doc)).toEqual([idB]);
    expect(normalizeRichTextMentionLabels(doc, new Map())).toEqual(doc);
  });

  it("never makes a document with only a card valid, because the link text is what counts", () => {
    expect(() => parseRichTextDoc({ type: "doc", content: [card(idA)] }, COMMENT_MEDIA_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });
});
