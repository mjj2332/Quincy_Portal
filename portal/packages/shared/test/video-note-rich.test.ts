import { describe, expect, it } from "vitest";
import { parseRichTextDoc, RichTextValidationError, type RichTextDoc, GUEST_NOTE_RICH_TEXT_PROFILE, VIDEO_NOTE_RICH_TEXT_PROFILE, COMMENT_MEDIA_RICH_TEXT_PROFILE } from "../src/rich-text";
import { VIDEO_NOTE_BODY_MAX, videoNoteBody, videoNoteCreateInputSchema, videoNoteEditInputSchema, videoNoteReplyInputSchema } from "../src/video-notes";

const userId = "11111111-1111-4111-8111-111111111111";
const a = "22222222-2222-4222-8222-222222222222";
const b = "33333333-3333-4333-8333-333333333333";
const c = "44444444-4444-4444-8444-444444444444";
const text = (value: string) => ({ type: "text" as const, text: value });
const doc = (...content: RichTextDoc["content"]): RichTextDoc => ({ type: "doc", content });

describe("#835 video note rich text", () => {
  it("is the comment-media profile without link previews, Attachments included (#955)", () => {
    expect(VIDEO_NOTE_RICH_TEXT_PROFILE).toEqual({ ...COMMENT_MEDIA_RICH_TEXT_PROFILE, allowLinkPreviews: false, allowAttachments: true, maxAttachments: 10 });
    const withPreview = { type: "doc", content: [{ type: "paragraph", content: [text("x")] }, { type: "linkPreview", attrs: { previewId: a } }] };
    expect(() => parseRichTextDoc(withPreview, VIDEO_NOTE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
  });

  it("writes the body with @Name for a mention and no per-node placeholder", () => {
    const value = doc({ type: "paragraph", content: [text("Match "), { type: "mention", attrs: { id: userId, label: "Terry" } }, text("'s grade")] });
    expect(videoNoteBody(value)).toBe("Match @Terry's grade");
  });

  it("appends a count hint for media", () => {
    expect(videoNoteBody(doc({ type: "paragraph", content: [text("Like this")] }, { type: "image", attrs: { mediaId: a } }))).toBe("Like this [1 image]");
    expect(videoNoteBody(doc({ type: "paragraph", content: [text("Clips")] }, { type: "video", attrs: { mediaId: a } }, { type: "video", attrs: { mediaId: b } }))).toBe("Clips [2 videos]");
    expect(videoNoteBody(doc({ type: "paragraph", content: [text("Both")] }, { type: "image", attrs: { mediaId: a } }, { type: "image", attrs: { mediaId: b } }, { type: "video", attrs: { mediaId: c } }))).toBe("Both [2 images] [1 video]");
  });

  it("reads an Attachment as nothing in the text and closes with a file count (#955)", () => {
    expect(videoNoteBody(doc({ type: "paragraph", content: [text("Plan")] }, { type: "attachment", attrs: { attachmentId: a } }))).toBe("Plan [1 file]");
    expect(videoNoteBody(doc({ type: "paragraph", content: [text("All")] }, { type: "image", attrs: { mediaId: a } }, { type: "attachment", attrs: { attachmentId: b } }, { type: "attachment", attrs: { attachmentId: c } }))).toBe("All [1 image] [2 files]");
    expect(videoNoteBody(doc({ type: "attachment", attrs: { attachmentId: a } }))).toBe("[1 file]");
  });

  it("a guest's own note takes no Attachment until #956, while a guest still reads a staff note's", () => {
    const withFile = { type: "doc", content: [{ type: "paragraph", content: [text("x")] }, { type: "attachment", attrs: { attachmentId: a } }] };
    expect(GUEST_NOTE_RICH_TEXT_PROFILE).toEqual({ ...VIDEO_NOTE_RICH_TEXT_PROFILE, allowAttachments: false, maxAttachments: 0 });
    expect(() => parseRichTextDoc(withFile, GUEST_NOTE_RICH_TEXT_PROFILE)).toThrow(RichTextValidationError);
    expect(parseRichTextDoc(withFile, VIDEO_NOTE_RICH_TEXT_PROFILE).content[1]).toEqual({ type: "attachment", attrs: { attachmentId: a } });
  });

  it("a media-only note still has a body", () => {
    expect(videoNoteBody(doc({ type: "image", attrs: { mediaId: a } }))).toBe("[1 image]");
  });

  it("the body ceiling is the legacy one", () => { expect(VIDEO_NOTE_BODY_MAX).toBe(10_000); });

  it("create, reply and edit take content XOR body", () => {
    const content = doc({ type: "paragraph", content: [text("hi")] });
    const create = { startFrame: 1, visibility: "internal" as const };
    expect(videoNoteCreateInputSchema.safeParse({ ...create, body: "hi" }).success).toBe(true);
    expect(videoNoteCreateInputSchema.safeParse({ ...create, content }).success).toBe(true);
    expect(videoNoteCreateInputSchema.safeParse({ ...create }).success).toBe(false);
    expect(videoNoteCreateInputSchema.safeParse({ ...create, body: "hi", content }).success).toBe(false);
    expect(videoNoteReplyInputSchema.safeParse({ body: "hi" }).success).toBe(true);
    expect(videoNoteReplyInputSchema.safeParse({ content }).success).toBe(true);
    expect(videoNoteReplyInputSchema.safeParse({}).success).toBe(false);
    expect(videoNoteReplyInputSchema.safeParse({ body: "hi", content }).success).toBe(false);
    expect(videoNoteEditInputSchema.safeParse({ expectedRevision: 1, content }).success).toBe(true);
    expect(videoNoteEditInputSchema.safeParse({ expectedRevision: 1, body: "x", content }).success).toBe(false);
    expect(videoNoteEditInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
  });
});
