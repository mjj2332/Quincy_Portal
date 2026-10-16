import type { ReactNode } from "react";
import { VIDEO_NOTE_BODY_MAX, type RichTextDoc } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { QuincyRichTextEditorBase } from "../components/QuincyRichTextEditorBase";

/**
 * The rich field of a guest's note, reply and edit (#835 C): the one Quincy editor with mentions off (a guest mentions no one) and the link's own media routes injected, so it imports no staff
 * network module (`guest-boundary.guard.test.ts`). It is loaded on demand (`GuestNoteField`), so the editor's weight is not paid by a guest who only reads. No link previews: the profile does not allow them.
 * The phone composer's pill props (#879 PR 2) pass straight through, as the staff `VideoNoteEditor` passes them; every other form leaves them out and gets the field as ever.
 */
export function GuestNoteEditor({ media, value, onChange, disabled, label, placeholder, onUploadingChange, onSubmit, testId, id, pill, pillWrap, toolbarContainer, inlineStart, inlineEnd, contentClassName, contentAttributes }: {
  media: EditorMediaTransport;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  onUploadingChange?: (uploading: boolean) => void;
  onSubmit?: () => void;
  testId: string;
  /** The editable's id (the phone pill's field, which the strip focuses inside a tap). */
  id?: string;
  pill?: boolean;
  pillWrap?: boolean;
  toolbarContainer?: HTMLElement | null;
  inlineStart?: ReactNode;
  inlineEnd?: ReactNode;
  contentClassName?: string;
  contentAttributes?: Readonly<Record<`data-${string}`, string>>;
}) {
  const phonePill = pill ? { pill, ...(pillWrap !== undefined ? { pillWrap } : {}), toolbarContainer, inlineStart, inlineEnd, contentClassName, contentAttributes } : {};
  return <div data-testid={testId}>
    <QuincyRichTextEditorBase
      preset="composer" value={value} onChange={onChange} limit={VIDEO_NOTE_BODY_MAX} disabled={disabled} mentions={false}
      placeholder={placeholder} ariaLabel={label} onSubmit={onSubmit} media={media} onUploadingChange={onUploadingChange} {...(id ? { id } : {})} {...phonePill}
    />
  </div>;
}
