import { Fragment, type ReactNode } from "react";
import type { RichTextBlock, RichTextDoc, RichTextInline, RichTextListItem, RichTextMark } from "@quincy/shared";

function marked(node: ReactNode, marks: RichTextMark[] | undefined): ReactNode {
  return (marks ?? []).reduce<ReactNode>((content, mark) => {
    if (mark.type === "bold") return <strong>{content}</strong>;
    if (mark.type === "italic") return <em>{content}</em>;
    if (mark.type === "link") return <a href={mark.href} target="_blank" rel="noopener noreferrer">{content}</a>;
    return content;
  }, node);
}

function inline(node: RichTextInline, index: number): ReactNode {
  if (node.type === "mention") return <span className="rich-text__mention" key={index}>@{node.attrs.label}</span>;
  if (node.type === "hardBreak") return <br key={index} />;
  return <Fragment key={index}>{marked(node.text, node.marks)}</Fragment>;
}

function block(node: RichTextBlock | RichTextListItem, key: number): ReactNode {
  if (node.type === "paragraph") return <p key={key}>{(node.content ?? []).map(inline)}</p>;
  if (node.type === "listItem") return <li key={key}>{node.content.map(block)}</li>;
  const List = node.type === "bulletList" ? "ul" : "ol";
  return <List key={key}>{node.content.map(block)}</List>;
}

/** Safe renderer for the deliberately narrow shared document model. */
export function RichTextContent({ content, className = "" }: { content: RichTextDoc; className?: string }) {
  return <div className={`rich-text${className ? ` ${className}` : ""}`}>{content.content.map(block)}</div>;
}
