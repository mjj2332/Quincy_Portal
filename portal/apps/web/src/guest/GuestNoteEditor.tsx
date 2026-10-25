import type { ReactNode, Ref } from "react";
import { VIDEO_NOTE_BODY_MAX, type RichTextDoc } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import type { EditorAttachmentTransport } from "../lib/attachments-core";
import { QuincyRichTextEditorBase, type RichTextEditorHandle } from "../components/QuincyRichTextEditorBase";

/** What the guest's field uploads through: the link's media routes, and its Attachment routes (`files`, #956). `guest-api.ts`'s `createGuestMediaTransport` builds both. */
export type GuestEditorTransport = EditorMediaTransport & { files: EditorAttachmentTransport };

/**
 * The rich field of a guest's note, reply and edit (#835 C): the one Quincy editor with mentions off (a guest mentions no one) and the link's own media routes injected, so it imports no staff
 * network module (`guest-boundary.guard.test.ts`). It is loaded on demand (`GuestNoteField`), so the editor's weight is not paid by a guest who only reads. No link previews: the profile does not allow them.
 * The phone composer's pill props (#879 PR 2) pass straight through, as the staff `VideoNoteEditor` passes them; every other form leaves them out and gets the field as ever.
 * It is the `note` preset (#927), as the staff editor is: `ref` gives the box's paperclip the picker, and `stripContainer` the strip's place.
 * Files (#956): the paperclip takes any file; a photo or video embeds, anything else is an Attachment through the link's own routes, with the guest's limits (25 MB, five a note). A file
 * that failed to upload is counted to the host (`onFailedFilesChange`), whose Post or Save waits until it is retried or removed, as a staff note's does.
 */
export function GuestNoteEditor({ media, value, onChange, disabled, label, placeholder, onUploadingChange, onFailedFilesChange, onSubmit, testId, id, ref, stripContainer, bubbleDockTo, bubbleDocked, pill, pillWrap, toolbarContainer, inlineStart, inlineEnd, contentClassName, contentAttributes }: {
  media: GuestEditorTransport;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  onUploadingChange?: (uploading: boolean) => void;
  onFailedFilesChange?: (failed: number) => void;
  onSubmit?: () => void;
  testId: string;
  /** The editable's id (the phone pill's field, which the strip focuses inside a tap). */
  id?: string;
  /** The editor's handle (#927): `pickMedia()` for the box's paperclip. */
  ref?: Ref<RichTextEditorHandle>;
  /** Where the draft strip renders (#927): see `QuincyRichTextEditorBase`. */
  stripContainer?: HTMLElement | null;
  /** On a phone, the element the bubble docks to (the box, frame P2). */
  bubbleDockTo?: () => Element | null;
  /** Whether the bubble docks (the box's phone layout); below 721px when absent. */
  bubbleDocked?: boolean;
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
      preset="note" ref={ref} {...(stripContainer !== undefined ? { stripContainer } : {})} bubbleDockTo={bubbleDockTo} {...(bubbleDocked !== undefined ? { bubbleDocked } : {})} value={value} onChange={onChange} limit={VIDEO_NOTE_BODY_MAX} disabled={disabled} mentions={false}
      placeholder={placeholder} ariaLabel={label} onSubmit={onSubmit} media={media} attachments={media.files} onUploadingChange={onUploadingChange} onFailedFilesChange={onFailedFilesChange} {...(id ? { id } : {})} {...phonePill}
    />
  </div>;
}
