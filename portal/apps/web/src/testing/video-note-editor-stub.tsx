import { legacyBodyToRichTextDoc, videoNoteBody, type RichTextDoc } from "@quincy/shared";

/**
 * A plain textarea standing in for the rich `VideoNoteEditor` in the Video tab's panel tests (#835). Those tests are about the notes panel, the form store and the frame clock, not about Tiptap; the
 * rich field has its own tests. Typing sends a one-paragraph document, which is what the real field sends for plain text.
 */
export function VideoNoteEditor({ id, value, onChange, disabled, placeholder, onSubmit }: { id?: string; value: RichTextDoc; onChange: (value: RichTextDoc) => void; disabled?: boolean; placeholder?: string; onSubmit?: () => void }) {
  return <textarea
    id={id} value={videoNoteBody(value)} placeholder={placeholder} readOnly={disabled}
    onChange={(event) => { onChange(event.target.value === "" ? { type: "doc", content: [{ type: "paragraph" }] } : legacyBodyToRichTextDoc(event.target.value)); }}
    onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit?.(); } }}
  />;
}
