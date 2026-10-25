import { useCallback, type ReactNode, type Ref } from "react";
import { VIDEO_NOTE_BODY_MAX, type RichTextDoc, type Role } from "@quincy/shared";
import { apiGet } from "../../lib/api";
import { externalApiGet } from "../../lib/external-api-response";
import { QuincyRichTextEditor } from "../QuincyRichTextEditor";
import type { RichTextEditorHandle } from "../QuincyRichTextEditorBase";
import type { MentionableUser } from "../MentionAutocomplete";

type Mentionable = MentionableUser[];

/**
 * The rich field every staff video-note form shares (#835): the composer, an edit and a reply. `@` lists the Project's video audience (`scope=video`: the people who can open a video note, not the
 * Collaboration tab's list), images, videos and files (#955) upload as the note's own, and `onUploadingChange` lets the host hold Post / Save until each has landed. No link previews: the profile does not
 * allow them. It is the `note` preset (#927): no fixed toolbar but a bubble over a selection, and the photos and videos as a strip after the text; the box's
 * paperclip opens the picker through `ref`, and `stripContainer` puts the strip in the box's slot.
 */
export function VideoNoteEditor({ projectId, role, value, onChange, disabled, id, placeholder, onSubmit, onUploadingChange, onFailedFilesChange, ref, stripContainer, bubbleDockTo, bubbleDocked, pill, pillWrap, toolbarContainer, inlineStart, inlineEnd, contentClassName, contentAttributes }: {
  projectId: string;
  role: Role;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  onSubmit?: () => void;
  onUploadingChange?: (uploading: boolean) => void;
  /** How many files failed to upload (#955): the host holds Send or Save until each is retried or removed, so a note never goes out missing a file. */
  onFailedFilesChange?: (count: number) => void;
  /** The editor's handle (#927): `pickMedia()` for the box's paperclip. */
  ref?: Ref<RichTextEditorHandle>;
  /** Where the draft strip renders (#927): see `QuincyRichTextEditorBase`. */
  stripContainer?: HTMLElement | null;
  /** On a phone, the element the bubble docks to (the box, frame P2). */
  bubbleDockTo?: () => Element | null;
  /** Whether the bubble docks (the box's phone layout); below 721px when absent. */
  bubbleDocked?: boolean;
  /** The phone composer's pill (#879): see `QuincyRichTextEditorBase`. Every other form leaves these out and gets the field as ever. */
  pill?: boolean;
  pillWrap?: boolean;
  toolbarContainer?: HTMLElement | null;
  inlineStart?: ReactNode;
  inlineEnd?: ReactNode;
  contentClassName?: string;
  contentAttributes?: Readonly<Record<`data-${string}`, string>>;
}) {
  const loadMentionables = useCallback(async (query: string): Promise<Mentionable> => {
    const path = `/api/mentionable-users?scope=video&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query)}`;
    const response = role === "external_editor" ? await externalApiGet("mentionable", path) as { users: Mentionable } : await apiGet<{ users: Mentionable }>(path);
    return response.users;
  }, [projectId, role]);
  return <QuincyRichTextEditor
    preset="note" ref={ref} {...(stripContainer !== undefined ? { stripContainer } : {})} bubbleDockTo={bubbleDockTo} {...(bubbleDocked !== undefined ? { bubbleDocked } : {})} id={id} value={value} onChange={onChange} limit={VIDEO_NOTE_BODY_MAX} disabled={disabled}
    loadMentionables={loadMentionables} placeholder={placeholder} onSubmit={onSubmit}
    media={{ projectId, owner: "video_note" }} attachments={{ projectId, owner: "video_note" }} onUploadingChange={onUploadingChange} onFailedFilesChange={onFailedFilesChange}
    pill={pill} {...(pillWrap !== undefined ? { pillWrap } : {})} toolbarContainer={toolbarContainer} inlineStart={inlineStart} inlineEnd={inlineEnd} contentClassName={contentClassName} {...(contentAttributes ? { contentAttributes } : {})}
  />;
}
