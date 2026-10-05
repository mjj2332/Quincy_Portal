/**
 * The small, portable rich-text document accepted by collaboration surfaces.
 * This intentionally describes JSON, not HTML: browser editors are convenience
 * clients while this parser remains the trust boundary for every write.
 */
export const RICH_TEXT_HIGHLIGHT_COLORS = ["yellow", "green", "blue"] as const;
export type RichTextHighlightColor = (typeof RICH_TEXT_HIGHLIGHT_COLORS)[number];
export const RICH_TEXT_TEXT_ALIGNS = ["center", "right", "justify"] as const;
export type RichTextTextAlign = (typeof RICH_TEXT_TEXT_ALIGNS)[number];
export type RichTextMark = { type: "bold" | "italic" | "underline" | "strike" } | { type: "link"; href: string } | { type: "highlight"; color: RichTextHighlightColor };
export type RichTextText = { type: "text"; text: string; marks?: RichTextMark[] };
export type RichTextMention = { type: "mention"; attrs: { id: string; label: string } };
export type RichTextHardBreak = { type: "hardBreak" };
export type RichTextInline = RichTextText | RichTextMention | RichTextHardBreak;
/** An omitted `textAlign` is left-aligned; only the three non-default alignments are stored. */
export type RichTextParagraph = { type: "paragraph"; attrs?: { textAlign: RichTextTextAlign }; content?: RichTextInline[] };
export type RichTextHeading = { type: "heading"; attrs: { level: 2 | 3; textAlign?: RichTextTextAlign }; content?: RichTextInline[] };
export type RichTextListItem = { type: "listItem"; content: Array<RichTextParagraph | RichTextBulletList | RichTextOrderedList | RichTextTaskList> };
export type RichTextBulletList = { type: "bulletList"; content: RichTextListItem[] };
export type RichTextOrderedList = { type: "orderedList"; content: RichTextListItem[] };
export type RichTextTaskItem = { type: "taskItem"; attrs: { checked: boolean }; content: [RichTextParagraph, ...(RichTextParagraph | RichTextBulletList | RichTextOrderedList | RichTextTaskList)[]] };
export type RichTextTaskList = { type: "taskList"; content: RichTextTaskItem[] };
/** Cell spans are stored only when not 1x1. Cells hold paragraphs only (no nested lists or tables). */
export type RichTextTableCell = { type: "tableCell" | "tableHeader"; attrs?: { colspan: number; rowspan: number }; content: RichTextParagraph[] };
export type RichTextTableRow = { type: "tableRow"; content: RichTextTableCell[] };
export type RichTextTable = { type: "table"; content: RichTextTableRow[] };
/** An image placed in a post (#493). It names stored media by id and never carries a URL or bytes. */
export type RichTextImage = { type: "image"; attrs: { mediaId: string } };
/** A video placed in a post (#494). Like an image it names stored media by id and never carries a URL or bytes. */
export type RichTextVideo = { type: "video"; attrs: { mediaId: string } };
export type RichTextMediaNode = RichTextImage | RichTextVideo;
export type RichTextBlock = RichTextParagraph | RichTextHeading | RichTextBulletList | RichTextOrderedList | RichTextTaskList | RichTextTable | RichTextImage | RichTextVideo;
/** Every node a tree walk can meet. */
export type RichTextTreeNode = RichTextBlock | RichTextListItem | RichTextTaskItem | RichTextTableRow | RichTextTableCell | RichTextInline;
export type RichTextDoc = { type: "doc"; content: RichTextBlock[] };

export const RICH_TEXT_JSON_MAX_BYTES = 32 * 1024;
/** The Notice board's document preset (#492, images #496): longer posts, so a wider JSON cap and character cap. */
export const NOTICE_RICH_TEXT_JSON_MAX_BYTES = 64 * 1024;
export const NOTICE_BODY_MAX_LENGTH = 10_000;
export const RICH_TEXT_MAX_NESTING = 8;
export const RICH_TEXT_TABLE_MAX_ROWS = 50;
export const RICH_TEXT_TABLE_MAX_COLUMNS = 12;
export const STAFF_NAME_MAX_LENGTH = 200;

/**
 * What a surface may store. The default is the comment profile (Project discussion, #491); the
 * Notice board's document profile is a strict superset (#492), so an old row always still parses.
 */
export type RichTextProfile = { readonly maxBytes: number; readonly allowTables: boolean; readonly allowAlign: boolean; readonly allowHighlight: boolean; readonly allowMedia: boolean; readonly allowVideo: boolean };
export const COMMENT_RICH_TEXT_PROFILE: RichTextProfile = { maxBytes: RICH_TEXT_JSON_MAX_BYTES, allowTables: false, allowAlign: false, allowHighlight: false, allowMedia: false, allowVideo: false };
export const NOTICE_RICH_TEXT_PROFILE: RichTextProfile = { maxBytes: NOTICE_RICH_TEXT_JSON_MAX_BYTES, allowTables: true, allowAlign: true, allowHighlight: true, allowMedia: true, allowVideo: false };
/** Project discussion (#493, #494): the comment profile plus embedded images and videos. The Notice board's profile takes images too (#496), never video. */
export const COMMENT_MEDIA_RICH_TEXT_PROFILE: RichTextProfile = { ...COMMENT_RICH_TEXT_PROFILE, allowMedia: true, allowVideo: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export class RichTextValidationError extends Error {
  constructor(message: string) { super(message); this.name = "RichTextValidationError"; }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RichTextValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new RichTextValidationError(`${label} contains an unsupported attribute`);
}

function classifyHref(value: unknown): "ok" | "empty" | "relative" | "protocol" {
  if (typeof value !== "string" || !value) return "empty";
  let url: URL;
  try { url = new URL(value); } catch { return "relative"; }
  return url.protocol === "http:" || url.protocol === "https:" ? "ok" : "protocol";
}

function httpUrl(value: unknown): string {
  const classification = classifyHref(value);
  if (classification === "empty") throw new RichTextValidationError("Link href must be a non-empty string");
  if (classification === "relative") throw new RichTextValidationError("Link href must be an absolute HTTP(S) URL");
  if (classification === "protocol") throw new RichTextValidationError("Link href must use HTTP(S)");
  return value as string;
}

/** Browser-safe counterpart to the server validator; server errors remain specific. */
export function isHttpUrl(value: unknown): boolean { return classifyHref(value) === "ok"; }

function parseMarks(value: unknown, profile: RichTextProfile): RichTextMark[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RichTextValidationError("Text marks must be an array");
  return value.map((item) => {
    const mark = record(item, "Mark");
    if (mark.type === "bold" || mark.type === "italic" || mark.type === "underline" || mark.type === "strike") {
      onlyKeys(mark, ["type"], "Mark");
      return { type: mark.type };
    }
    if (mark.type === "link") {
      onlyKeys(mark, ["type", "href"], "Link mark");
      return { type: "link", href: httpUrl(mark.href) };
    }
    if (mark.type === "highlight" && profile.allowHighlight) {
      onlyKeys(mark, ["type", "color"], "Highlight mark");
      if (!(RICH_TEXT_HIGHLIGHT_COLORS as readonly unknown[]).includes(mark.color)) throw new RichTextValidationError("Highlight color is not supported");
      return { type: "highlight", color: mark.color as RichTextHighlightColor };
    }
    throw new RichTextValidationError("Unsupported mark");
  });
}

function parseInline(value: unknown, profile: RichTextProfile): RichTextInline {
  const node = record(value, "Inline node");
  if (node.type === "text") {
    onlyKeys(node, ["type", "text", "marks"], "Text node");
    if (typeof node.text !== "string" || !node.text) throw new RichTextValidationError("Text nodes must not be empty");
    return node.marks === undefined ? { type: "text", text: node.text } : { type: "text", text: node.text, marks: parseMarks(node.marks, profile) };
  }
  if (node.type === "mention") {
    onlyKeys(node, ["type", "attrs"], "Mention node");
    const attrs = record(node.attrs, "Mention attributes");
    onlyKeys(attrs, ["id", "label"], "Mention attributes");
    if (typeof attrs.id !== "string" || !UUID.test(attrs.id)) throw new RichTextValidationError("Mention id must be a UUID");
    if (typeof attrs.label !== "string" || !attrs.label.trim() || attrs.label.length > STAFF_NAME_MAX_LENGTH) throw new RichTextValidationError("Mention label is invalid");
    return { type: "mention", attrs: { id: attrs.id, label: attrs.label } };
  }
  if (node.type === "hardBreak") {
    onlyKeys(node, ["type"], "Hard break");
    return { type: "hardBreak" };
  }
  throw new RichTextValidationError("Unsupported inline node");
}

function contentArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new RichTextValidationError(`${label} content must be an array`);
  return value;
}

function parseTextAlign(value: unknown, label: string, profile: RichTextProfile): RichTextTextAlign {
  if (!profile.allowAlign) throw new RichTextValidationError(`${label} contains an unsupported attribute`);
  if (!(RICH_TEXT_TEXT_ALIGNS as readonly unknown[]).includes(value)) throw new RichTextValidationError("Text alignment is not supported");
  return value as RichTextTextAlign;
}

function parseParagraph(node: Record<string, unknown>, profile: RichTextProfile): RichTextParagraph {
  onlyKeys(node, ["type", "attrs", "content"], "Paragraph");
  let attrs: RichTextParagraph["attrs"];
  if (node.attrs !== undefined) {
    const raw = record(node.attrs, "Paragraph attributes");
    onlyKeys(raw, ["textAlign"], "Paragraph attributes");
    attrs = { textAlign: parseTextAlign(raw.textAlign, "Paragraph attributes", profile) };
  }
  return {
    type: "paragraph",
    ...(attrs ? { attrs } : {}),
    ...(node.content === undefined ? {} : { content: contentArray(node.content, "Paragraph").map((item) => parseInline(item, profile)) }),
  };
}

/** A column span is bounded by the column limit, a row span by the row limit. */
function spanOf(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new RichTextValidationError(`${label} span is invalid`);
  return value as number;
}

function parseTable(node: Record<string, unknown>, profile: RichTextProfile): RichTextTable {
  onlyKeys(node, ["type", "content"], "Table");
  const rows = contentArray(node.content, "Table");
  if (!rows.length || rows.length > RICH_TEXT_TABLE_MAX_ROWS) throw new RichTextValidationError("Tables must have between 1 and 50 rows");
  // Rows still covered by an earlier row's rowspan, per column. A row whose every column is covered
  // has no cells of its own (Tiptap emits it as `content: []`), so it is valid only then.
  let pending: number[] = [];
  const widths: number[] = [];
  const emptyRows: Array<{ index: number; covered: number; contiguous: boolean }> = [];
  const parsed = rows.map((rowValue, rowIndex) => {
    const row = record(rowValue, "Table row");
    if (row.type !== "tableRow") throw new RichTextValidationError("Tables may contain only rows");
    onlyKeys(row, ["type", "content"], "Table row");
    const cells = contentArray(row.content, "Table row");
    const next = pending.map((remaining) => Math.max(remaining - 1, 0));
    let col = 0;
    const skipCovered = () => { while ((pending[col] ?? 0) > 0) col += 1; };
    const parsedCells = cells.map((cellValue) => {
      const cell = record(cellValue, "Table cell");
      if (cell.type !== "tableCell" && cell.type !== "tableHeader") throw new RichTextValidationError("Table rows may contain only cells");
      onlyKeys(cell, ["type", "attrs", "content"], "Table cell");
      let attrs: RichTextTableCell["attrs"];
      let colspan = 1;
      let rowspan = 1;
      if (cell.attrs !== undefined) {
        const raw = record(cell.attrs, "Table cell attributes");
        onlyKeys(raw, ["colspan", "rowspan"], "Table cell attributes");
        colspan = raw.colspan === undefined ? 1 : spanOf(raw.colspan, "Column", RICH_TEXT_TABLE_MAX_COLUMNS);
        rowspan = raw.rowspan === undefined ? 1 : spanOf(raw.rowspan, "Row", RICH_TEXT_TABLE_MAX_ROWS);
        if (colspan !== 1 || rowspan !== 1) attrs = { colspan, rowspan };
      }
      skipCovered();
      for (let offset = 0; offset < colspan; offset += 1) next[col + offset] = Math.max(next[col + offset] ?? 0, rowspan - 1);
      col += colspan;
      if (col > RICH_TEXT_TABLE_MAX_COLUMNS) throw new RichTextValidationError("Tables may have at most 12 columns");
      const content = contentArray(cell.content, "Table cell").map((item) => {
        const child = record(item, "Table cell node");
        if (child.type !== "paragraph") throw new RichTextValidationError("Table cells may contain paragraphs only");
        return parseParagraph(child, profile);
      });
      if (!content.length) throw new RichTextValidationError("Table cells must not be empty");
      return { type: cell.type, ...(attrs ? { attrs } : {}), content } as RichTextTableCell;
    });
    if (parsedCells.length) {
      skipCovered();
      widths.push(col);
    } else {
      const covered = pending.filter((remaining) => remaining > 0).length;
      emptyRows.push({ index: rowIndex, covered, contiguous: pending.slice(0, covered).every((remaining) => remaining > 0) });
    }
    pending = next;
    return { type: "tableRow" as const, content: parsedCells };
  });
  const tableWidth = Math.max(0, ...widths);
  for (const empty of emptyRows) {
    if (!empty.covered || !empty.contiguous || empty.covered !== tableWidth) throw new RichTextValidationError("Table rows must have cells");
  }
  return { type: "table", content: parsed };
}

function parseBlock(value: unknown, depth: number, profile: RichTextProfile, itemKind: "listItem" | "taskItem" | false = false, insideListItem = false): RichTextBlock | RichTextListItem | RichTextTaskItem {
  if (depth > RICH_TEXT_MAX_NESTING) throw new RichTextValidationError("Rich-text nesting is too deep");
  const node = record(value, "Rich-text node");
  if (node.type === "paragraph") return parseParagraph(node, profile);
  if (node.type === "image") {
    if (!profile.allowMedia || depth > 0 || itemKind || insideListItem) throw new RichTextValidationError("Unsupported rich-text node");
    onlyKeys(node, ["type", "attrs"], "Image");
    const attrs = record(node.attrs, "Image attributes");
    onlyKeys(attrs, ["mediaId"], "Image attributes");
    if (typeof attrs.mediaId !== "string" || !UUID.test(attrs.mediaId)) throw new RichTextValidationError("Image media id must be a UUID");
    return { type: "image", attrs: { mediaId: attrs.mediaId } };
  }
  if (node.type === "video") {
    if (!profile.allowMedia || !profile.allowVideo || depth > 0 || itemKind || insideListItem) throw new RichTextValidationError("Unsupported rich-text node");
    onlyKeys(node, ["type", "attrs"], "Video");
    const attrs = record(node.attrs, "Video attributes");
    onlyKeys(attrs, ["mediaId"], "Video attributes");
    if (typeof attrs.mediaId !== "string" || !UUID.test(attrs.mediaId)) throw new RichTextValidationError("Video media id must be a UUID");
    return { type: "video", attrs: { mediaId: attrs.mediaId } };
  }
  if (node.type === "table") {
    if (!profile.allowTables || depth > 0) throw new RichTextValidationError("Unsupported rich-text node");
    return parseTable(node, profile);
  }
  if (node.type === "heading") {
    if (insideListItem) throw new RichTextValidationError("Headings may not be inside list items");
    onlyKeys(node, ["type", "attrs", "content"], "Heading");
    const attrs = record(node.attrs, "Heading attributes");
    onlyKeys(attrs, ["level", "textAlign"], "Heading attributes");
    if (attrs.level !== 2 && attrs.level !== 3) throw new RichTextValidationError("Heading level must be 2 or 3");
    const textAlign = attrs.textAlign === undefined ? undefined : parseTextAlign(attrs.textAlign, "Heading attributes", profile);
    return { type: "heading", attrs: { level: attrs.level, ...(textAlign ? { textAlign } : {}) }, ...(node.content === undefined ? {} : { content: contentArray(node.content, "Heading").map((item) => parseInline(item, profile)) }) };
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    onlyKeys(node, ["type", "content"], "List");
    const content = contentArray(node.content, "List").map((item) => parseBlock(item, depth + 1, profile, "listItem", insideListItem));
    if (!content.length || content.some((item) => item.type !== "listItem")) throw new RichTextValidationError("Lists may contain only list items");
    return { type: node.type, content: content as RichTextListItem[] };
  }
  if (node.type === "taskList") {
    onlyKeys(node, ["type", "content"], "Task list");
    const content = contentArray(node.content, "Task list").map((item) => parseBlock(item, depth + 1, profile, "taskItem", insideListItem));
    if (!content.length || content.some((item) => item.type !== "taskItem")) throw new RichTextValidationError("Task lists may contain only task items");
    return { type: "taskList", content: content as RichTextTaskItem[] };
  }
  if (node.type === "listItem") {
    if (itemKind !== "listItem") throw new RichTextValidationError("List items must be inside a list");
    onlyKeys(node, ["type", "content"], "List item");
    const content = contentArray(node.content, "List item").map((item) => parseBlock(item, depth + 1, profile, false, true));
    if (!content.length || content.some((item) => item.type !== "paragraph" && item.type !== "bulletList" && item.type !== "orderedList" && item.type !== "taskList")) throw new RichTextValidationError("List items may contain paragraphs and nested lists only");
    return { type: "listItem", content: content as RichTextListItem["content"] };
  }
  if (node.type === "taskItem") {
    if (itemKind !== "taskItem") throw new RichTextValidationError("Task items must be inside a task list");
    onlyKeys(node, ["type", "attrs", "content"], "Task item");
    const attrs = record(node.attrs, "Task item attributes");
    onlyKeys(attrs, ["checked"], "Task item attributes");
    if (typeof attrs.checked !== "boolean") throw new RichTextValidationError("Task item checked must be a boolean");
    const content = contentArray(node.content, "Task item").map((item) => parseBlock(item, depth + 1, profile, false, true));
    if (!content.length || content[0]?.type !== "paragraph" || content.some((item) => item.type !== "paragraph" && item.type !== "bulletList" && item.type !== "orderedList" && item.type !== "taskList")) throw new RichTextValidationError("Task items must start with a paragraph followed by paragraphs or nested lists");
    return { type: "taskItem", attrs: { checked: attrs.checked }, content: content as RichTextTaskItem["content"] };
  }
  throw new RichTextValidationError("Unsupported rich-text node");
}

/** Parses and copies untrusted JSON into the exact stored contract. */
export function parseRichTextDoc(value: unknown, profile: RichTextProfile = COMMENT_RICH_TEXT_PROFILE): RichTextDoc {
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new RichTextValidationError("Rich-text payload is not JSON serializable"); }
  if (!json || encoder.encode(json).byteLength > profile.maxBytes) throw new RichTextValidationError("Rich-text payload is too large");
  const doc = record(value, "Rich-text document");
  onlyKeys(doc, ["type", "content"], "Rich-text document");
  if (doc.type !== "doc") throw new RichTextValidationError("Rich-text document must be a doc");
  const content = contentArray(doc.content, "Rich-text document").map((item) => parseBlock(item, 0, profile));
  if (!content.length || content.some((item) => item.type === "listItem" || item.type === "taskItem")) throw new RichTextValidationError("Rich-text document must contain paragraphs or lists");
  const parsed = { type: "doc" as const, content: content as RichTextBlock[] };
  const mediaIds = richTextMediaIds(parsed);
  if (new Set(mediaIds).size !== mediaIds.length) throw new RichTextValidationError("A media item may be placed only once in a document");
  if (!richTextPlainText(parsed).trim()) throw new RichTextValidationError("Rich-text document must not be empty");
  return parsed;
}

/** UTF-8 serialized width used by both the client guard and the server trust boundary. */
export function richTextDocByteLength(doc: RichTextDoc): number {
  return encoder.encode(JSON.stringify(doc)).byteLength;
}

/** What an image reads as wherever the document is shown as text (a notification body, a search). */
export const RICH_TEXT_IMAGE_PLACEHOLDER = "[image]";
export const RICH_TEXT_VIDEO_PLACEHOLDER = "[video]";

function textFromBlock(block: RichTextBlock | RichTextListItem | RichTextTaskItem | RichTextTableRow | RichTextTableCell): string {
  // Cells are tab-separated and rows newline-separated, so a table reads as plain text in a
  // notification and counts toward the character limit the way it reads.
  if (block.type === "image") return RICH_TEXT_IMAGE_PLACEHOLDER;
  if (block.type === "video") return RICH_TEXT_VIDEO_PLACEHOLDER;
  if (block.type === "table") return block.content.map((row) => row.content.map((cell) => cell.content.map(textFromBlock).filter(Boolean).join("\n")).join("\t")).join("\n");
  if (block.type === "paragraph" || block.type === "heading") return (block.content ?? []).map((node) => node.type === "text" ? node.text : node.type === "hardBreak" ? "\n" : node.attrs.label).join("");
  if (block.type === "listItem") return (block.content ?? []).map(textFromBlock).filter(Boolean).join("\n");
  return (block.content ?? []).map(textFromBlock).filter(Boolean).join("\n");
}

/** Plain text is used for searchable legacy fallbacks and semantic character limits. */
export function richTextPlainText(doc: RichTextDoc): string {
  return doc.content.map(textFromBlock).filter(Boolean).join("\n");
}

/** Returns stable, de-duplicated mention ids in document order. */
export function richTextMentionIds(doc: RichTextDoc): string[] {
  const ids: string[] = [];
  const visit = (node: RichTextTreeNode) => {
    if (node.type === "mention") { if (!ids.includes(node.attrs.id)) ids.push(node.attrs.id); return; }
    if (node.type === "text" || node.type === "hardBreak" || node.type === "image" || node.type === "video") return;
    if (node.type === "paragraph" || node.type === "heading") { for (const child of node.content ?? []) visit(child); return; }
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of doc.content) visit(block);
  return ids;
}

/** Returns the media an image or video node names, with each node's kind, in document order. */
export function richTextMediaRefs(doc: RichTextDoc): Array<{ id: string; kind: "image" | "video" }> {
  const refs: Array<{ id: string; kind: "image" | "video" }> = [];
  for (const block of doc.content) if (block.type === "image" || block.type === "video") refs.push({ id: block.attrs.mediaId, kind: block.type });
  return refs;
}

/** Returns the media ids an image or video node names, in document order. */
export function richTextMediaIds(doc: RichTextDoc): string[] {
  return richTextMediaRefs(doc).map((ref) => ref.id);
}

/** Replaces untrusted display labels after the server has resolved eligible users. */
export function normalizeRichTextMentionLabels(doc: RichTextDoc, namesById: ReadonlyMap<string, string>): RichTextDoc {
  const normalize = (node: RichTextTreeNode): RichTextTreeNode => {
    if (node.type === "mention") {
      const label = namesById.get(node.attrs.id);
      if (label === undefined) throw new RichTextValidationError("Mention target is not eligible");
      return { type: "mention", attrs: { id: node.attrs.id, label: label.slice(0, STAFF_NAME_MAX_LENGTH) } };
    }
    if (node.type === "text") return node.marks ? { ...node, marks: node.marks.map((mark) => ({ ...mark })) } : { ...node };
    if (node.type === "hardBreak") return { ...node };
    if (node.type === "image") return { type: "image", attrs: { mediaId: node.attrs.mediaId } };
    if (node.type === "video") return { type: "video", attrs: { mediaId: node.attrs.mediaId } };
    if (node.type === "paragraph") return { type: "paragraph", ...(node.attrs ? { attrs: { ...node.attrs } } : {}), ...(node.content ? { content: node.content.map(normalize) as RichTextInline[] } : {}) };
    if (node.type === "heading") return { type: "heading", attrs: { ...node.attrs }, ...(node.content ? { content: node.content.map(normalize) as RichTextInline[] } : {}) };
    if (node.type === "taskItem") return { type: "taskItem", attrs: { ...node.attrs }, content: node.content.map(normalize) as RichTextTaskItem["content"] };
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === "content" && Array.isArray(value) ? value.map(normalize) : value])) as RichTextBlock | RichTextListItem;
  };
  return { type: "doc", content: doc.content.map(normalize) as RichTextBlock[] };
}

/** Presents old plain-text rows through the same DTO without a migration backfill. */
export function legacyBodyToRichTextDoc(body: string): RichTextDoc {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] };
}
