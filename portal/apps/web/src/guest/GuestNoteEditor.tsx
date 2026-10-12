import { VIDEO_NOTE_BODY_MAX, type RichTextDoc } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { QuincyRichTextEditorBase } from "../components/QuincyRichTextEditorBase";

/**
 * The rich field of a guest's note, reply and edit (#835 C): the one Quincy editor with mentions off (a guest mentions no one) and the link's own media routes injected, so it imports no staff
 * network module (`guest-boundary.guard.test.ts`). It is loaded on demand (`GuestNoteField`), so the editor's weight is not paid by a guest who only reads. No link previews: the profile does not allow them.
 */
export function GuestNoteEditor({ media, value, onChange, disabled, label, placeholder, onUploadingChange, onSubmit, testId }: {
  media: EditorMediaTransport;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  onUploadingChange?: (uploading: boolean) => void;
  onSubmit?: () => void;
  testId: string;
}) {
  return <div data-testid={testId}>
    <QuincyRichTextEditorBase
      preset="composer" value={value} onChange={onChange} limit={VIDEO_NOTE_BODY_MAX} disabled={disabled} mentions={false}
      placeholder={placeholder} ariaLabel={label} onSubmit={onSubmit} media={media} onUploadingChange={onUploadingChange}
    />
  </div>;
}
