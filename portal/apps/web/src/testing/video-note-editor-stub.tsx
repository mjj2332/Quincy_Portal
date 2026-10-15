import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { legacyBodyToRichTextDoc, videoNoteBody, type RichTextDoc } from "@quincy/shared";

/**
 * A plain textarea standing in for the rich `VideoNoteEditor` in the Video tab's panel tests (#835). Those tests are about the notes panel, the form store and the frame clock, not about Tiptap; the
 * rich field has its own tests. Typing sends a one-paragraph document, which is what the real field sends for plain text.
 *
 * The phone pill's props (#879 fix) are honoured the way the real field places them: `inlineStart` / `inlineEnd` around the text, and a stand-in formatting toolbar (one Bold button)
 * portalled into `toolbarContainer` when that is an element. The inline toolbar of the desktop field is not stood in for.
 */
export function VideoNoteEditor({ id, value, onChange, disabled, placeholder, onSubmit, toolbarContainer, inlineStart, inlineEnd, contentClassName, pill }: { id?: string; value: RichTextDoc; onChange: (value: RichTextDoc) => void; disabled?: boolean; placeholder?: string; onSubmit?: () => void; toolbarContainer?: HTMLElement | null; inlineStart?: ReactNode; inlineEnd?: ReactNode; contentClassName?: string; pill?: boolean }) {
  const toolbar = <div role="toolbar" aria-label="Formatting" data-testid="stub-toolbar"><button type="button" data-testid="stub-bold">B</button></div>;
  const area = <textarea
    id={id} value={videoNoteBody(value)} placeholder={placeholder} readOnly={disabled} className={contentClassName}
    onChange={(event) => { onChange(event.target.value === "" ? { type: "doc", content: [{ type: "paragraph" }] } : legacyBodyToRichTextDoc(event.target.value)); }}
    onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit?.(); } }}
  />;
  // One shape at every width (the real field keeps its editor across the 721px crossing), so a node-identity test can hold on to the textarea.
  return <div data-testid="stub-field" data-pill={pill ? "true" : undefined}>
    {inlineStart !== undefined ? <div data-testid="stub-inline-start">{inlineStart}</div> : null}
    {area}
    {inlineEnd !== undefined ? <div data-testid="stub-inline-end">{inlineEnd}</div> : null}
    {toolbarContainer ? createPortal(toolbar, toolbarContainer) : null}
  </div>;
}
