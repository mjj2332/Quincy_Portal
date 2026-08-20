/**
 * The small, portable rich-text document accepted by collaboration surfaces.
 * This intentionally describes JSON, not HTML: browser editors are convenience
 * clients while this parser remains the trust boundary for every write.
 */
export type RichTextMark = { type: "bold" | "italic" | "underline" | "strike" } | { type: "link"; href: string };
export type RichTextText = { type: "text"; text: string; marks?: RichTextMark[] };
export type RichTextMention = { type: "mention"; attrs: { id: string; label: string } };
export type RichTextHardBreak = { type: "hardBreak" };
export type RichTextInline = RichTextText | RichTextMention | RichTextHardBreak;
export type RichTextParagraph = { type: "paragraph"; content?: RichTextInline[] };
export type RichTextHeading = { type: "heading"; attrs: { level: 2 | 3 }; content?: RichTextInline[] };
export type RichTextListItem = { type: "listItem"; content: Array<RichTextParagraph | RichTextBulletList | RichTextOrderedList> };
export type RichTextBulletList = { type: "bulletList"; content: RichTextListItem[] };
export type RichTextOrderedList = { type: "orderedList"; content: RichTextListItem[] };
export type RichTextBlock = RichTextParagraph | RichTextHeading | RichTextBulletList | RichTextOrderedList;
export type RichTextDoc = { type: "doc"; content: RichTextBlock[] };

export const RICH_TEXT_JSON_MAX_BYTES = 32 * 1024;
export const RICH_TEXT_MAX_NESTING = 8;
export const STAFF_NAME_MAX_LENGTH = 200;

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

function parseMarks(value: unknown): RichTextMark[] | undefined {
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
    throw new RichTextValidationError("Unsupported mark");
  });
}

function parseInline(value: unknown): RichTextInline {
  const node = record(value, "Inline node");
  if (node.type === "text") {
    onlyKeys(node, ["type", "text", "marks"], "Text node");
    if (typeof node.text !== "string" || !node.text) throw new RichTextValidationError("Text nodes must not be empty");
    return node.marks === undefined ? { type: "text", text: node.text } : { type: "text", text: node.text, marks: parseMarks(node.marks) };
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

function parseBlock(value: unknown, depth: number, mayBeListItem = false, insideListItem = false): RichTextBlock | RichTextListItem {
  if (depth > RICH_TEXT_MAX_NESTING) throw new RichTextValidationError("Rich-text nesting is too deep");
  const node = record(value, "Rich-text node");
  if (node.type === "paragraph") {
    onlyKeys(node, ["type", "content"], "Paragraph");
    if (node.content === undefined) return { type: "paragraph" };
    return { type: "paragraph", content: contentArray(node.content, "Paragraph").map(parseInline) };
  }
  if (node.type === "heading") {
    if (insideListItem) throw new RichTextValidationError("Headings may not be inside list items");
    onlyKeys(node, ["type", "attrs", "content"], "Heading");
    const attrs = record(node.attrs, "Heading attributes");
    onlyKeys(attrs, ["level"], "Heading attributes");
    if (attrs.level !== 2 && attrs.level !== 3) throw new RichTextValidationError("Heading level must be 2 or 3");
    return { type: "heading", attrs: { level: attrs.level }, ...(node.content === undefined ? {} : { content: contentArray(node.content, "Heading").map(parseInline) }) };
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    onlyKeys(node, ["type", "content"], "List");
    const content = contentArray(node.content, "List").map((item) => parseBlock(item, depth + 1, true, insideListItem));
    if (!content.length || content.some((item) => item.type !== "listItem")) throw new RichTextValidationError("Lists may contain only list items");
    return { type: node.type, content: content as RichTextListItem[] };
  }
  if (node.type === "listItem") {
    if (!mayBeListItem) throw new RichTextValidationError("List items must be inside a list");
    onlyKeys(node, ["type", "content"], "List item");
    const content = contentArray(node.content, "List item").map((item) => parseBlock(item, depth + 1, false, true));
    if (!content.length || content.some((item) => item.type === "listItem")) throw new RichTextValidationError("List items may contain paragraphs and nested lists only");
    return { type: "listItem", content: content as RichTextListItem["content"] };
  }
  throw new RichTextValidationError("Unsupported rich-text node");
}

/** Parses and copies untrusted JSON into the exact stored contract. */
export function parseRichTextDoc(value: unknown): RichTextDoc {
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new RichTextValidationError("Rich-text payload is not JSON serializable"); }
  if (!json || encoder.encode(json).byteLength > RICH_TEXT_JSON_MAX_BYTES) throw new RichTextValidationError("Rich-text payload is too large");
  const doc = record(value, "Rich-text document");
  onlyKeys(doc, ["type", "content"], "Rich-text document");
  if (doc.type !== "doc") throw new RichTextValidationError("Rich-text document must be a doc");
  const content = contentArray(doc.content, "Rich-text document").map((item) => parseBlock(item, 0));
  if (!content.length || content.some((item) => item.type === "listItem")) throw new RichTextValidationError("Rich-text document must contain paragraphs or lists");
  const parsed = { type: "doc" as const, content: content as RichTextBlock[] };
  if (!richTextPlainText(parsed).trim()) throw new RichTextValidationError("Rich-text document must not be empty");
  return parsed;
}

function textFromBlock(block: RichTextBlock | RichTextListItem): string {
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
  const visit = (node: RichTextBlock | RichTextListItem | RichTextInline) => {
    if (node.type === "mention") { if (!ids.includes(node.attrs.id)) ids.push(node.attrs.id); return; }
    if (node.type === "text" || node.type === "hardBreak") return;
    if (node.type === "paragraph" || node.type === "heading") { for (const child of node.content ?? []) visit(child); return; }
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of doc.content) visit(block);
  return ids;
}

/** Replaces untrusted display labels after the server has resolved eligible users. */
export function normalizeRichTextMentionLabels(doc: RichTextDoc, namesById: ReadonlyMap<string, string>): RichTextDoc {
  const normalize = (node: RichTextBlock | RichTextListItem | RichTextInline): RichTextBlock | RichTextListItem | RichTextInline => {
    if (node.type === "mention") {
      const label = namesById.get(node.attrs.id);
      if (label === undefined) throw new RichTextValidationError("Mention target is not eligible");
      return { type: "mention", attrs: { id: node.attrs.id, label: label.slice(0, STAFF_NAME_MAX_LENGTH) } };
    }
    if (node.type === "text") return node.marks ? { ...node, marks: node.marks.map((mark) => ({ ...mark })) } : { ...node };
    if (node.type === "hardBreak") return { ...node };
    if (node.type === "paragraph") return { type: "paragraph", ...(node.content ? { content: node.content.map(normalize) as RichTextInline[] } : {}) };
    if (node.type === "heading") return { type: "heading", attrs: { ...node.attrs }, ...(node.content ? { content: node.content.map(normalize) as RichTextInline[] } : {}) };
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === "content" && Array.isArray(value) ? value.map(normalize) : value])) as RichTextBlock | RichTextListItem;
  };
  return { type: "doc", content: doc.content.map(normalize) as RichTextBlock[] };
}

/** Presents old plain-text rows through the same DTO without a migration backfill. */
export function legacyBodyToRichTextDoc(body: string): RichTextDoc {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] };
}
