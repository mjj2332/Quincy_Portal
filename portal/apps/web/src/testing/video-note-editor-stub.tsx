import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { legacyBodyToRichTextDoc, videoNoteBody, type RichTextDoc } from "@quincy/shared";

/**
 * A plain textarea standing in for the rich `VideoNoteEditor` in the Video tab's panel tests (#835). Those tests are about the notes panel, the form store and the frame clock, not about Tiptap; the
 * rich field has its own tests. Typing sends a one-paragraph document, which is what the real field sends for plain text.
 *
 * The phone pill's props (#879 fix) are honoured the way the real field places them: `inlineStart` / `inlineEnd` around the text, and a stand-in formatting toolbar (one Bold button)
 * portalled into `toolbarContainer` when that is an element. The inline toolbar of the desktop field is not stood in for.
 *
 * The note preset's handle (#927) is stood in for too: `pickMedia()` (the box's paperclip) starts one upload at once, as a picked file does (`onUploadingChange(true)`),
 * and the `stub-upload-done` button ends it. Nothing is added to the draft: the strip has its own tests.
 */
export function VideoNoteEditor({ id, value, onChange, disabled, placeholder, onSubmit, onUploadingChange, ref, toolbarContainer, inlineStart, inlineEnd, contentClassName, contentAttributes, pill, pillWrap }: { id?: string; value: RichTextDoc; onChange: (value: RichTextDoc) => void; disabled?: boolean; placeholder?: string; onSubmit?: () => void; onUploadingChange?: (uploading: boolean) => void; ref?: Ref<{ pickMedia: () => void; focus: () => void }>; toolbarContainer?: HTMLElement | null; inlineStart?: ReactNode; inlineEnd?: ReactNode; contentClassName?: string; contentAttributes?: Readonly<Record<`data-${string}`, string>>; pill?: boolean; pillWrap?: boolean }) {
  useImperativeHandle(ref, () => ({
    pickMedia: () => { onUploadingChange?.(true); },
    focus: () => { document.getElementById(id ?? "")?.focus(); },
  }), [onUploadingChange, id]);
  const toolbar = <div role="toolbar" aria-label="Formatting" data-testid="stub-toolbar"><button type="button" data-testid="stub-bold">B</button></div>;
  const area = <textarea
    id={id} value={videoNoteBody(value)} placeholder={placeholder} readOnly={disabled} className={contentClassName} {...contentAttributes}
    onChange={(event) => { onChange(event.target.value === "" ? { type: "doc", content: [{ type: "paragraph" }] } : legacyBodyToRichTextDoc(event.target.value)); }}
    onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit?.(); } }}
  />;
  // One shape at every width (the real field keeps its editor across the 721px crossing), so a node-identity test can hold on to the textarea.
  return <div data-testid="stub-field" data-pill={pill ? "true" : undefined} data-pill-wrap={pill && pillWrap !== undefined ? String(pillWrap) : undefined}>
    {inlineStart !== undefined ? <div data-testid="stub-inline-start">{inlineStart}</div> : null}
    {area}
    {inlineEnd !== undefined ? <div data-testid="stub-inline-end">{inlineEnd}</div> : null}
    {toolbarContainer ? createPortal(toolbar, toolbarContainer) : null}
    {onUploadingChange ? <button type="button" hidden data-testid="stub-upload-done" onClick={() => { onUploadingChange(false); }} /> : null}
  </div>;
}
