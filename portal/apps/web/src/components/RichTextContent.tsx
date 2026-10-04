import { Fragment, type ReactNode } from "react";
import { EmbeddedImage } from "./quincy/EmbeddedImage";
import { EmbeddedVideo } from "./quincy/EmbeddedVideo";
import { LinkPreviewCard } from "./quincy/LinkPreviewCard";
import type { RichTextBlock, RichTextDoc, RichTextInline, RichTextListItem, RichTextMark, RichTextTableCell, RichTextTableRow, RichTextTaskItem } from "@quincy/shared";

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

function block(node: RichTextBlock | RichTextListItem | RichTextTaskItem | RichTextTableRow | RichTextTableCell, key: number): ReactNode {
  if (node.type === "paragraph") return <p key={key} className={alignClass(node.attrs?.textAlign)}>{(node.content ?? []).map(inline)}</p>;
  if (node.type === "heading") {
    const Heading = node.attrs.level === 2 ? "h2" : "h3";
    return <Heading key={key} className={alignClass(node.attrs.textAlign)}>{(node.content ?? []).map(inline)}</Heading>;
  }
  if (node.type === "image") return <EmbeddedImage key={key} mediaId={node.attrs.mediaId} />;
  if (node.type === "video") return <EmbeddedVideo key={key} mediaId={node.attrs.mediaId} />;
  if (node.type === "linkPreview") return <LinkPreviewCard key={key} attrs={node.attrs} />;
  if (node.type === "table") {
    const columns = Math.max(...node.content.map((row) => row.content.reduce((sum, cell) => sum + (cell.attrs?.colspan ?? 1), 0)));
    return <div key={key} className="rich-text__table-scroll"><table style={{ minWidth: columns * TABLE_CELL_MIN_WIDTH }}><tbody>{node.content.map(block)}</tbody></table></div>;
  }
  if (node.type === "tableRow") return <tr key={key}>{node.content.map(block)}</tr>;
  if (node.type === "tableCell" || node.type === "tableHeader") {
    const Cell = node.type === "tableHeader" ? "th" : "td";
    return <Cell key={key} colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>{node.content.map(block)}</Cell>;
  }
  if (node.type === "listItem") return <li key={key}>{(node.content ?? []).map(block)}</li>;
  if (node.type === "bulletList" || node.type === "orderedList") {
    const List = node.type === "bulletList" ? "ul" : "ol";
    return <List key={key}>{(node.content ?? []).map(block)}</List>;
  }
  if (node.type === "taskList") return <ul key={key} className="rich-text__task-list">{node.content.map(block)}</ul>;
  if (node.type === "taskItem") {
    const completed = node.attrs.checked;
    return <li key={key} className={`rich-text__task-item${completed ? " is-checked" : ""}`}>
      <span className="rich-text__task-indicator" data-testid="rich-text-task-indicator" aria-hidden="true">{completed ? "✓" : ""}</span>
      <div className="rich-text__task-content"><span className="sr-only" data-testid="rich-text-task-status">{completed ? "Completed" : "Not completed"}</span>{node.content.map(block)}</div>
    </li>;
  }
  return <Fragment key={key}>{fallbackText(node)}</Fragment>;
}

/** Safe renderer for the deliberately narrow shared document model. */
export function RichTextContent({ content, className = "" }: { content: RichTextDoc; className?: string }) {
  return <div className={`rich-text${className ? ` ${className}` : ""}`}>{content.content.map(block)}</div>;
}
