import { describe, expect, it } from "vitest";
import {
  COMMENT_MEDIA_RICH_TEXT_PROFILE,
  COMMENT_RICH_TEXT_PROFILE,
  GUEST_NOTE_RICH_TEXT_PROFILE,
  NOTICE_RICH_TEXT_PROFILE,
  RICH_TEXT_ATTACHMENT_PLACEHOLDER,
  RichTextValidationError,
  VIDEO_NOTE_RICH_TEXT_PROFILE,
  normalizeRichTextMentionLabels,
  parseRichTextDoc,
  richTextAttachmentIds,
  richTextMentionIds,
  richTextMentionsToText,
  richTextPlainText,
  type RichTextDoc,
} from "../src/rich-text";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const text = (value: string) => ({ type: "text" as const, text: value });
const para = (value: string) => ({ type: "paragraph" as const, content: [text(value)] });
const attachment = (n: number, extra: Record<string, unknown> = {}) => ({ type: "attachment", attrs: { attachmentId: id(n), ...extra } });
const parse = (content: unknown[], profile = COMMENT_MEDIA_RICH_TEXT_PROFILE) => parseRichTextDoc({ type: "doc", content }, profile);

describe("attachment node (#952)", () => {
  it("is accepted on the Project discussion's profile and stores only its id", () => {
    const doc = parse([para("See the plan"), attachment(1, { name: "plan.pdf", bytes: 1200 })]);
    expect(doc.content[1]).toEqual({ type: "attachment", attrs: { attachmentId: id(1) } });
    expect(richTextAttachmentIds(doc)).toEqual([id(1)]);
  });

  it("is refused on the comment and Guest note profiles until their tickets turn it on", () => {
    for (const profile of [COMMENT_RICH_TEXT_PROFILE, GUEST_NOTE_RICH_TEXT_PROFILE]) {
      expect(() => parse([para("x"), attachment(1)], profile)).toThrow(RichTextValidationError);
    }
    expect(GUEST_NOTE_RICH_TEXT_PROFILE.allowAttachments).toBe(false);
  });

  it("is accepted on a staff Video note, ten at most (#955)", () => {
    expect(richTextAttachmentIds(parse([para("x"), attachment(1)], VIDEO_NOTE_RICH_TEXT_PROFILE))).toEqual([id(1)]);
    expect(() => parse([para("x"), ...Array.from({ length: 11 }, (_, n) => attachment(n + 1))], VIDEO_NOTE_RICH_TEXT_PROFILE)).toThrow("A post may have at most 10 attachments");
  });

  it("is accepted on the Notice board's profile (#954), 10 a notice, beside its images and a table", () => {
    const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [para("Day")] }] }] };
    const files = Array.from({ length: 10 }, (_, n) => attachment(n + 1, { name: "rota.pdf", bytes: 9 }));
    const doc = parse([para("Rota"), table, { type: "image", attrs: { mediaId: id(100) } }, ...files], NOTICE_RICH_TEXT_PROFILE);
    expect(richTextAttachmentIds(doc)).toHaveLength(10);
    expect(doc.content.at(-1)).toEqual({ type: "attachment", attrs: { attachmentId: id(10) } });
    expect(() => parse([para("Rota"), ...files, attachment(11)], NOTICE_RICH_TEXT_PROFILE)).toThrow("A post may have at most 10 attachments");
  });

  it("lives at the top level only", () => {
    expect(() => parse([{ type: "bulletList", content: [{ type: "listItem", content: [attachment(1)] }] }])).toThrow(RichTextValidationError);
  });

  it("refuses a non-UUID id, an unknown key and a malformed display field", () => {
    expect(() => parse([{ type: "attachment", attrs: { attachmentId: "nope" } }])).toThrow("Attachment id must be a UUID");
    expect(() => parse([attachment(1, { url: "https://x" })])).toThrow(RichTextValidationError);
    expect(() => parse([attachment(1, { name: 3 })])).toThrow(RichTextValidationError);
  });

  it("allows 10 a post, counted separately from images", () => {
    const images = Array.from({ length: 10 }, (_, n) => ({ type: "image", attrs: { mediaId: id(100 + n) } }));
    const files = Array.from({ length: 10 }, (_, n) => attachment(n + 1));
    expect(richTextAttachmentIds(parse([para("x"), ...images, ...files]))).toHaveLength(10);
    expect(() => parse([para("x"), ...files, attachment(11)])).toThrow("A post may have at most 10 attachments");
  });

  it("may be placed once", () => {
    expect(() => parse([attachment(1), attachment(1)])).toThrow("An attachment may be placed only once in a document");
  });

  it("makes an attachment-only post non-empty, read as a placeholder", () => {
    const doc = parse([attachment(1)]);
    expect(richTextPlainText(doc)).toBe(RICH_TEXT_ATTACHMENT_PLACEHOLDER);
    expect(RICH_TEXT_ATTACHMENT_PLACEHOLDER).toBe("[attachment]");
  });

  it("survives the mention helpers", () => {
    const doc: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: id(50), label: "Old" } }] }, { type: "attachment", attrs: { attachmentId: id(1), name: "a.pdf", bytes: 3 } }] };
    expect(richTextMentionIds(doc)).toEqual([id(50)]);
    expect(normalizeRichTextMentionLabels(doc, new Map([[id(50), "New"]])).content[1]).toEqual({ type: "attachment", attrs: { attachmentId: id(1) } });
    expect(richTextMentionsToText(doc).content[1]).toEqual(doc.content[1]);
  });
});
