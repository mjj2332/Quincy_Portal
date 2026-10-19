import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { CheckIcon } from "lucide-react";
import { RICH_TEXT_IMAGE_ALT_MAX_LENGTH } from "@quincy/shared";
import { EmbeddedImage } from "../../lib/rich-text-tiptap";
import { Button } from "../reui/button";
import { Field, FieldLabel } from "../reui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../reui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "../reui/popover";

/** The alt-text field, mounted per open so it always starts from the stored text (the link popover's pattern). */
function AltForm({ alt, inputRef, onApply }: { alt: string; inputRef: RefObject<HTMLInputElement | null>; onApply: (next: string) => void }) {
  const [draft, setDraft] = useState(alt);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The popover is portalled but React still bubbles synthetic events through the editor's ancestors: a composer inside a <form> must not see this one.
    event.stopPropagation();
    onApply(draft.trim());
  };
  const inputId = useId();
  return <form onSubmit={submit}>
    <Field>
      <FieldLabel htmlFor={inputId}>Alt text</FieldLabel>
      <InputGroup>
        <InputGroupInput id={inputId} ref={inputRef} value={draft} maxLength={RICH_TEXT_IMAGE_ALT_MAX_LENGTH} placeholder="Describe the image" data-testid="embedded-image-alt-input" onChange={(event) => setDraft(event.target.value)} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="submit" size="icon-xs" aria-label="Apply alt text"><CheckIcon aria-hidden="true" /></InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  </form>;
}

function EmbeddedImageEditorView({ node, editor, selected, updateAttributes, extension }: NodeViewProps) {
  // The node's own option (#835): the editor host says where the bytes are read from (the staff route, or a Review link's).
  const mediaUrl = (extension.options as { mediaUrl: (mediaId: string) => string }).mediaUrl;
  // The editor goes non-editable while a Save is in flight, which only a transaction announces: follow it.
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync(); editor.on("transaction", sync); editor.on("update", sync);
    return () => { editor.off("transaction", sync); editor.off("update", sync); };
  }, [editor]);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const mediaId = String(node.attrs.mediaId ?? "");
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  return <NodeViewWrapper className="rich-text__embedded-image-node" contentEditable={false}>
    <img src={mediaUrl(mediaId)} alt={alt || "Embedded image"} data-media-id={mediaId} data-drag-handle="" className="rich-text__embedded-image cursor-grab active:cursor-grabbing" />
    {(selected || open) && editable && <div className="absolute bottom-[var(--space-2)] left-[var(--space-2)]">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="secondary" size="xs" data-testid="embedded-image-alt-button" className="pointer-coarse:h-11 max-[721px]:h-11" />}>Alt text</PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} aria-labelledby={titleId} className="w-80" data-testid="embedded-image-alt-popover" initialFocus={inputRef}>
          <span id={titleId} className="sr-only">Edit alt text</span>
          <AltForm alt={alt} inputRef={inputRef} onApply={(next) => { updateAttributes({ alt: next || null }); setOpen(false); }} />
        </PopoverContent>
      </Popover>
    </div>}
  </NodeViewWrapper>;
}

/**
 * The alt-text popover on any trigger (#927 T2): a draft note's chip opens it from the file's name, which is the image's alt text by
 * default. The same form and popover as the node view's own "Alt text" control.
 */
export function EmbeddedImageAltPopover({ alt, trigger, onApply, children }: { alt: string; trigger: ReactElement; onApply: (next: string | null) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
    <PopoverContent align="start" sideOffset={8} aria-labelledby={titleId} className="w-80" data-testid="embedded-image-alt-popover" initialFocus={inputRef}>
      <span id={titleId} className="sr-only">Edit alt text</span>
      <AltForm alt={alt} inputRef={inputRef} onApply={(next) => { onApply(next || null); setOpen(false); }} />
    </PopoverContent>
  </Popover>;
}

/**
 * A note's photo in the text (#927 T2): an invisible atom, since the note draws its photos and videos as a strip of chips after the
 * text (`QuincyRichTextEditorBase`, frame C4). Not selectable or draggable, so neither the caret nor a drag can land on something unseen.
 */
export function hiddenNoteMediaView(kind: "image" | "video") {
  return () => {
    const dom = document.createElement("div");
    dom.hidden = true;
    dom.contentEditable = "false";
    dom.dataset.noteMedia = kind;
    return { dom, ignoreMutation: () => true };
  };
}
export const EmbeddedImageNoteNode = EmbeddedImage.extend({
  selectable: false,
  draggable: false,
  addNodeView() { return hiddenNoteMediaView("image"); },
});

/** The editor's `image` node with the image and its "Alt text" control (shown on the selected image) as the node view (#553). */
export const EmbeddedImageWithView = EmbeddedImage.extend({
  addNodeView() { return ReactNodeViewRenderer(EmbeddedImageEditorView); },
});
