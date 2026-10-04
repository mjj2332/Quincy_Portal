import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { XIcon } from "lucide-react";
import { LinkPreview } from "../../lib/rich-text-tiptap";
import { Button } from "../reui/button";
import { LinkPreviewCard } from "./LinkPreviewCard";

function LinkPreviewEditorView({ node, deleteNode, editor }: NodeViewProps) {
  const attrs = node.attrs as { previewId: string; url?: string; title?: string | null; description?: string | null; siteName?: string | null; imageMediaId?: string | null };
  return <NodeViewWrapper data-testid="link-preview-node" contentEditable={false}>
    <LinkPreviewCard
      testId="link-preview-card-editor"
      attrs={{ previewId: attrs.previewId, url: attrs.url, title: attrs.title ?? null, description: attrs.description ?? null, siteName: attrs.siteName ?? null, imageMediaId: attrs.imageMediaId ?? null }}
      actions={<Button type="button" variant="ghost" size="icon-xs" data-testid="link-preview-remove" aria-label="Remove link preview" className="absolute top-[var(--space-1)] right-[var(--space-1)] max-[721px]:size-11" onClick={() => { deleteNode(); editor.commands.focus(); }}><XIcon aria-hidden="true" /></Button>}
    />
  </NodeViewWrapper>;
}

/** The editor's `linkPreview` node with its card (and a remove control) as the node view. */
export const LinkPreviewWithView = LinkPreview.extend({
  addNodeView() { return ReactNodeViewRenderer(LinkPreviewEditorView); },
});
