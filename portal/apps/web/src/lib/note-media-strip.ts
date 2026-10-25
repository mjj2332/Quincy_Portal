import type { RichTextAttachment, RichTextBlock, RichTextDoc, RichTextMediaNode } from "@quincy/shared";

/**
 * A posted note's Attachments (#955), apart from the rest: the note reads its text, its media strip, then its files as one list of download
 * chips (C4 `.cmp-file`). An Attachment is top-level only, so this is a partition of the blocks, in order. Display only, like `splitNoteMedia`.
 */
export function splitNoteFiles(doc: RichTextDoc): { rest: RichTextDoc; files: RichTextAttachment[] } {
  const files = doc.content.filter((block): block is RichTextAttachment => block.type === "attachment");
  return { rest: files.length ? { type: "doc", content: doc.content.filter((block) => block.type !== "attachment") } : doc, files };
}

/**
 * A posted note's text and its media, apart (#927 T1): the note reads as its words, then one strip of thumbnails. Media is only ever a
 * top-level block (a list item or a table cell cannot hold one), so the split is a partition of the document's blocks, in order.
 *
 * Display only: the stored document is never rewritten. An old note with a picture between two paragraphs keeps it there in storage
 * and round-trips through Edit unchanged; only the reading view gathers it into the strip. The input is not touched; `text` is a new
 * document over the same block objects.
 *
 * `text` is null when nothing but media and empty paragraphs is left (a media-only note: the editor leaves an empty paragraph beside a
 * picture), so the reader does not draw a blank line above the strip.
 */
export type NoteMediaSplit = { text: RichTextDoc | null; media: RichTextMediaNode[] };

const isMedia = (block: RichTextBlock): block is RichTextMediaNode => block.type === "image" || block.type === "video";
const isEmptyParagraph = (block: RichTextBlock) => block.type === "paragraph" && (block.content ?? []).length === 0;

export function splitNoteMedia(doc: RichTextDoc): NoteMediaSplit {
  const text: RichTextBlock[] = [];
  const media: RichTextMediaNode[] = [];
  for (const block of doc.content) {
    if (isMedia(block)) media.push(block);
    else text.push(block);
  }
  return { text: text.every(isEmptyParagraph) ? null : { type: "doc", content: text }, media };
}
