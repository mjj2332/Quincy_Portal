import { useCallback, type ReactNode } from "react";
import { VIDEO_NOTE_BODY_MAX, type RichTextDoc, type Role } from "@quincy/shared";
import { apiGet } from "../../lib/api";
import { externalApiGet } from "../../lib/external-api-response";
import { QuincyRichTextEditor } from "../QuincyRichTextEditor";
import type { MentionableUser } from "../MentionAutocomplete";

type Mentionable = MentionableUser[];

/**
 * The rich field every staff video-note form shares (#835): the composer, an edit and a reply. `@` lists the Project's video audience (`scope=video`: the people who can open a video note, not the
 * Collaboration tab's list), images and videos upload as the note's own media, and `onUploadingChange` lets the host hold Post / Save until each has landed. No link previews: the profile does not
 * allow them.
 */
export function VideoNoteEditor({ projectId, role, value, onChange, disabled, id, placeholder, onSubmit, onUploadingChange, pill, toolbarContainer, inlineStart, inlineEnd, contentClassName, contentAttributes }: {
  projectId: string;
  role: Role;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  onSubmit?: () => void;
  onUploadingChange?: (uploading: boolean) => void;
  /** The phone composer's pill (#879): see `QuincyRichTextEditorBase`. Every other form leaves these out and gets the field as ever. */
  pill?: boolean;
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
    preset="composer" id={id} value={value} onChange={onChange} limit={VIDEO_NOTE_BODY_MAX} disabled={disabled}
    loadMentionables={loadMentionables} placeholder={placeholder} onSubmit={onSubmit}
    media={{ projectId, owner: "video_note" }} onUploadingChange={onUploadingChange}
    pill={pill} toolbarContainer={toolbarContainer} inlineStart={inlineStart} inlineEnd={inlineEnd} contentClassName={contentClassName} {...(contentAttributes ? { contentAttributes } : {})}
  />;
}
