import { Fragment, type ReactNode } from "react";
import type { RichTextBlock, RichTextDoc, RichTextInline, RichTextListItem, RichTextMark } from "@quincy/shared";

function marked(node: ReactNode, marks: RichTextMark[] | undefined): ReactNode {
  return (marks ?? []).reduce<ReactNode>((content, mark) => {
    if (mark.type === "bold") return <strong>{content}</strong>;
    if (mark.type === "italic") return <em>{content}</em>;
    if (mark.type === "underline") return <u>{content}</u>;
    if (mark.type === "strike") return <s>{content}</s>;
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

function block(node: RichTextBlock | RichTextListItem, key: number): ReactNode {
  if (node.type === "paragraph") return <p key={key}>{(node.content ?? []).map(inline)}</p>;
  if (node.type === "heading") {
    const Heading = node.attrs.level === 2 ? "h2" : "h3";
    return <Heading key={key}>{(node.content ?? []).map(inline)}</Heading>;
  }
  if (node.type === "listItem") return <li key={key}>{(node.content ?? []).map(block)}</li>;
  if (node.type === "bulletList" || node.type === "orderedList") {
    const List = node.type === "bulletList" ? "ul" : "ol";
    return <List key={key}>{(node.content ?? []).map(block)}</List>;
  }
  return <Fragment key={key}>{fallbackText(node)}</Fragment>;
}

/** Safe renderer for the deliberately narrow shared document model. */
export function RichTextContent({ content, className = "" }: { content: RichTextDoc; className?: string }) {
  return <div className={`rich-text${className ? ` ${className}` : ""}`}>{content.content.map(block)}</div>;
}
