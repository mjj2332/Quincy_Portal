import { useEffect, useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { XIcon } from "lucide-react";
import { LinkPreview } from "../../lib/rich-text-tiptap";
import { Button } from "../reui/button";
import { LinkPreviewCard } from "./LinkPreviewCard";

/** Tiptap's `focus` command defers to the next frame. An enclosing dialog's focus manager parks focus on its popup the moment the focused Remove button leaves the DOM, so the editor takes focus synchronously (its selection is already where the card was) and the command then settles scroll and selection. */
function returnFocus(editor: NodeViewProps["editor"]) {
  if (!editor.isDestroyed) editor.view.focus();
  editor.commands.focus();
}

function LinkPreviewEditorView({ node, deleteNode, editor }: NodeViewProps) {
  // The editor goes non-editable while a Save is in flight, which only a transaction announces: follow it, so Remove cannot take out a card the request already holds.
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync(); editor.on("transaction", sync); editor.on("update", sync);
    return () => { editor.off("transaction", sync); editor.off("update", sync); };
  }, [editor]);
  const attrs = node.attrs as { previewId: string; url?: string; title?: string | null; description?: string | null; siteName?: string | null; imageMediaId?: string | null };
  return <NodeViewWrapper className="rich-text__link-preview" data-testid="link-preview-node" contentEditable={false}>
    <LinkPreviewCard
      testId="link-preview-card-editor"
      interactive={false}
      attrs={{ previewId: attrs.previewId, url: attrs.url, title: attrs.title ?? null, description: attrs.description ?? null, siteName: attrs.siteName ?? null, imageMediaId: attrs.imageMediaId ?? null }}
      actions={<Button type="button" variant="ghost" size="icon-sm" data-testid="link-preview-remove" aria-label="Remove link preview" className="absolute top-[var(--space-1)] right-[var(--space-1)] pointer-coarse:size-11 max-[721px]:size-11" disabled={!editable} onClick={() => { if (!editor.isEditable) return; deleteNode(); returnFocus(editor); }}><XIcon aria-hidden="true" /></Button>}
    />
  </NodeViewWrapper>;
}

/** The editor's `linkPreview` node with its card (and a remove control) as the node view. */
export const LinkPreviewWithView = LinkPreview.extend({
  addNodeView() { return ReactNodeViewRenderer(LinkPreviewEditorView); },
});
