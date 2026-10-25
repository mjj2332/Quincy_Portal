import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { RichTextLinkPreview } from "@quincy/shared";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { XIcon } from "lucide-react";
import { LinkPreview } from "../../lib/rich-text-tiptap";
import { Button } from "../reui/button";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { keepEditorFocus } from "../reui/rich-text-editor/rich-text-toolbar";

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
      actions={<Button type="button" variant="ghost" size="icon-sm" data-testid="link-preview-remove" aria-label="Remove link preview" className="absolute top-[var(--space-2)] right-[var(--space-2)] pointer-coarse:size-11 max-[721px]:size-11" disabled={!editable} onClick={() => { if (!editor.isEditable) return; deleteNode(); returnFocus(editor); }}><XIcon aria-hidden="true" /></Button>}
    />
  </NodeViewWrapper>;
}

/** The editor's `linkPreview` node with its card (and a remove control) as the node view. */
export const LinkPreviewWithView = LinkPreview.extend({
  addNodeView() { return ReactNodeViewRenderer(LinkPreviewEditorView); },
});

/**
 * A card in the note box's text (owner decision B1, #951): an invisible atom, since the box draws its cards under the scrolling text
 * (`LinkPreviewDraftCards`), as it draws the media strip. The node keeps its place after its link, so the saved post reads as before. Not
 * selectable or draggable, so neither the caret nor a drag lands on something unseen; Backspace from the block after it removes it, as
 * it does a note's hidden photo, and undo brings it back.
 */
export const LinkPreviewApartNode = LinkPreview.extend({
  selectable: false,
  draggable: false,
  addNodeView() {
    return () => {
      const dom = document.createElement("div");
      dom.hidden = true;
      dom.contentEditable = "false";
      dom.dataset.linkPreviewApart = "";
      return { dom, ignoreMutation: () => true };
    };
  },
});

/**
 * The note box's cards (B1): every card the draft holds, in the order the document holds them, each with its ×. A press on × keeps the
 * focus where it was (a phone keeps its keyboard), and a keyboard user's focus goes back to the text, before the button unmounts (the
 * Project sheet's focus manager would otherwise park it, as for the in-text card's Remove above).
 */
export function LinkPreviewDraftCards({ cards, disabled, mediaUrl, onRemove, onFocusText }: {
  cards: readonly RichTextLinkPreview[];
  disabled: boolean;
  mediaUrl?: (mediaId: string) => string;
  onRemove: (previewId: string) => void;
  onFocusText: () => void;
}) {
  if (cards.length === 0) return null;
  const press = (event: ReactMouseEvent<HTMLButtonElement>, previewId: string) => { const hadFocus = document.activeElement === event.currentTarget; onRemove(previewId); if (hadFocus) onFocusText(); };
  return <ul data-testid="link-preview-draft-cards" role="list" aria-label="Link previews" className="m-0 flex list-none flex-col gap-[var(--space-2)] p-0">
    {cards.map(({ attrs }) => <li key={attrs.previewId} className="min-w-0">
      <LinkPreviewCard
        testId="link-preview-card-editor" interactive={false} className="my-0" {...(mediaUrl ? { mediaUrl } : {})}
        attrs={{ previewId: attrs.previewId, url: attrs.url, title: attrs.title ?? null, description: attrs.description ?? null, siteName: attrs.siteName ?? null, imageMediaId: attrs.imageMediaId ?? null }}
        actions={<Button type="button" variant="ghost" size="icon-sm" data-testid="link-preview-remove" aria-label="Remove link preview" className="absolute top-[var(--space-2)] right-[var(--space-2)] pointer-coarse:size-11 max-[721px]:size-11" disabled={disabled} onMouseDown={keepEditorFocus} onClick={(event) => press(event, attrs.previewId)}><XIcon aria-hidden="true" /></Button>}
      />
    </li>)}
  </ul>;
}
