import { Fragment, type ReactNode } from "react";
import { EmbeddedImage } from "./quincy/EmbeddedImage";
import { EmbeddedVideo } from "./quincy/EmbeddedVideo";
import { LinkPreviewCard } from "./quincy/LinkPreviewCard";
import { AttachmentChip, AttachmentList } from "./quincy/AttachmentChip";
import type { RichTextAttachment, RichTextBlock, RichTextDoc, RichTextInline, RichTextListItem, RichTextMark, RichTextTableCell, RichTextTableRow, RichTextTaskItem } from "@quincy/shared";

function marked(node: ReactNode, marks: RichTextMark[] | undefined): ReactNode {
  return (marks ?? []).reduce<ReactNode>((content, mark) => {
    if (mark.type === "bold") return <strong>{content}</strong>;
    if (mark.type === "italic") return <em>{content}</em>;
    if (mark.type === "underline") return <u>{content}</u>;
    if (mark.type === "strike") return <s>{content}</s>;
    if (mark.type === "highlight") return <mark data-color={mark.color}>{content}</mark>;
    if (mark.type === "link") return <a href={mark.href} target="_blank" rel="noopener noreferrer">{content}</a>;
    return content;
  }, node);
}

function inline(node: RichTextInline, index: number): ReactNode {
  if (node.type === "mention") return <span className="rich-text__mention" key={index}>@{node.attrs.label}</span>;
  if (node.type === "hardBreak") return <br key={index} />;
  return <Fragment key={index}>{marked(node.text, node.marks)}</Fragment>;
}

function fallbackText(node: unknown): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const value = node as Record<string, unknown>;
  if (value.type === "text") return typeof value.text === "string" ? value.text : "";
  if (value.type === "mention") {
    const label = value.attrs && typeof value.attrs === "object" ? (value.attrs as Record<string, unknown>).label : undefined;
    return typeof label === "string" ? label : "";
  }
  return Array.isArray(value.content) ? value.content.map(fallbackText).join("") : "";
}

/** Alignment is a class, never inline CSS: the value is a closed set from the validator. */
const alignClass = (align: string | undefined) => align ? `rich-text__align-${align}` : undefined;
/** Matches Tiptap's `cellMinWidth` (96px per column): the table overflows its scroller below that. */
const TABLE_CELL_MIN_WIDTH = 96;

/** Where embedded media is read from (#835), and Attachments downloaded from (#952): the staff routes by default, a Review link's own for a guest. */
export type RichTextMediaUrls = { mediaUrl?: (mediaId: string) => string; posterUrl?: (mediaId: string) => string; attachmentUrl?: (attachmentId: string) => string };

function block(node: RichTextBlock | RichTextListItem | RichTextTaskItem | RichTextTableRow | RichTextTableCell, key: number, urls: RichTextMediaUrls): ReactNode {
  if (node.type === "paragraph") return <p key={key} className={alignClass(node.attrs?.textAlign)}>{(node.content ?? []).map(inline)}</p>;
  if (node.type === "heading") {
    const Heading = node.attrs.level === 2 ? "h2" : "h3";
    return <Heading key={key} className={alignClass(node.attrs.textAlign)}>{(node.content ?? []).map(inline)}</Heading>;
  }
  if (node.type === "image") return <EmbeddedImage key={key} mediaId={node.attrs.mediaId} alt={node.attrs.alt} width={node.attrs.width} height={node.attrs.height} mediaUrl={urls.mediaUrl} />;
  if (node.type === "video") return <EmbeddedVideo key={`video-${node.attrs.mediaId}`} mediaId={node.attrs.mediaId} hasPoster={node.attrs.hasPoster} mediaUrl={urls.mediaUrl} posterUrl={urls.posterUrl} />;
  if (node.type === "linkPreview") return <LinkPreviewCard key={`link-preview-${node.attrs.previewId}`} attrs={node.attrs} mediaUrl={urls.mediaUrl} />;
  if (node.type === "table") {
    const columns = Math.max(...node.content.map((row) => row.content.reduce((sum, cell) => sum + (cell.attrs?.colspan ?? 1), 0)));
    return <div key={key} className="rich-text__table-scroll"><table style={{ minWidth: columns * TABLE_CELL_MIN_WIDTH }}><tbody>{node.content.map((child, index) => block(child, index, urls))}</tbody></table></div>;
  }
  if (node.type === "tableRow") return <tr key={key}>{node.content.map((child, index) => block(child, index, urls))}</tr>;
  if (node.type === "tableCell" || node.type === "tableHeader") {
    const Cell = node.type === "tableHeader" ? "th" : "td";
    return <Cell key={key} colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>{node.content.map((child, index) => block(child, index, urls))}</Cell>;
  }
  if (node.type === "listItem") return <li key={key}>{(node.content ?? []).map((child, index) => block(child, index, urls))}</li>;
  if (node.type === "bulletList" || node.type === "orderedList") {
    const List = node.type === "bulletList" ? "ul" : "ol";
    return <List key={key}>{(node.content ?? []).map((child, index) => block(child, index, urls))}</List>;
  }
  if (node.type === "taskList") return <ul key={key} className="rich-text__task-list">{node.content.map((child, index) => block(child, index, urls))}</ul>;
  if (node.type === "taskItem") {
    const completed = node.attrs.checked;
    return <li key={key} className={`rich-text__task-item${completed ? " is-checked" : ""}`}>
      <span className="rich-text__task-indicator" data-testid="rich-text-task-indicator" aria-hidden="true">{completed ? "✓" : ""}</span>
      <div className="rich-text__task-content"><span className="sr-only" data-testid="rich-text-task-status">{completed ? "Completed" : "Not completed"}</span>{node.content.map((child, index) => block(child, index, urls))}</div>
    </li>;
  }
  return <Fragment key={key}>{fallbackText(node)}</Fragment>;
}

/**
 * The top-level blocks, with each run of consecutive Attachments (#952) drawn as one list of download chips. An Attachment is top-level only
 * (the parser refuses one anywhere else), and the editor keeps them at the end with the media, so a comment shows one list after its text.
 * The name and size are the server's served display fields; an old client that does not know the node draws nothing for it.
 */
function blocks(content: readonly RichTextBlock[], urls: RichTextMediaUrls): ReactNode[] {
  const out: ReactNode[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const child = content[index]!;
    if (child.type !== "attachment") { out.push(block(child, index, urls)); continue; }
    const run: RichTextAttachment[] = [];
    const start = index;
    while (index < content.length && content[index]!.type === "attachment") { run.push(content[index] as RichTextAttachment); index += 1; }
    index -= 1;
    out.push(<AttachmentList key={`attachments-${start}`}>{run.map((node) => <AttachmentChip key={node.attrs.attachmentId} attachmentId={node.attrs.attachmentId} name={node.attrs.name} bytes={node.attrs.bytes} attachmentUrl={urls.attachmentUrl} />)}</AttachmentList>);
  }
  return out;
}

/** Safe renderer for the deliberately narrow shared document model. */
export function RichTextContent({ content, className = "", mediaUrl, posterUrl, attachmentUrl }: { content: RichTextDoc; className?: string } & RichTextMediaUrls) {
  const urls: RichTextMediaUrls = { mediaUrl, posterUrl, attachmentUrl };
  return <div className={`rich-text${className ? ` ${className}` : ""}`}>{blocks(content.content, urls)}</div>;
}
