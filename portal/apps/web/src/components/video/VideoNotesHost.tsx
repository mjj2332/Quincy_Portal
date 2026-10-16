import { useSyncExternalStore, type ReactNode } from "react";
import { roleHasCapability, type Role, type VideoDto, type VideoVersionDto } from "@quincy/shared";
import { PHONE_QUERY } from "../../lib/review-pane-geometry";
import { useMediaQuery } from "../../lib/use-media-query";
import type { NoteFormStore } from "../../lib/video-note-form-store";
import { useVideoNotes, type VideoNotesSession } from "./use-video-notes";
import { useVideoMarkup } from "./VideoMarkupOverlay";
import { useMarkerExport, type MarkerExport } from "./VideoMarkerExportMenu";
import { DEFAULT_NOTE_FILTERS, noteCounts } from "../../lib/video-note-view";
import { VideoNotesPanel } from "./VideoNotesPanel";

/**
 * Owns the notes session (query, marks, filters, the player's clock) for the Version on screen, one level above the player so the panel and
 * the player share it. This module is the whole notes UI: the review viewer loads it lazily, only when the Project's notes part is on, so a
 * Project without notes never pays for it (and the notes-off viewer is exactly the 4d-ii viewer).
 */
/** What the notes host hands the viewer: the player's props, the panel, and (#879) what the phone header and sheet need from the session: the marker export, whether the pen is down, the open count. */
export type NotesSlots = { playerProps: VideoNotesSession["playerProps"]; panel: ReactNode; markerExport: MarkerExport; drawing: boolean; openCount: number | null };

export default function VideoNotesHost({ notes, video, version, detailsRows, children }: {
  notes: { projectId: string; role: Role; userId: string | null; archived: boolean; forms: NoteFormStore; /** The Project's `markup` part is on. */ markup?: boolean; /** The Project's `export` part is on (#741 9). */ exportEnabled?: boolean; /** #835: the note the link names. */ openNoteId?: string };
  /** The Video the Version belongs to: copy and paste work between its Versions. */
  video: VideoDto;
  version: VideoVersionDto;
  /** The Version details rows, which the panel shows behind a button. */
  detailsRows: ReactNode;
  children: (slots: NotesSlots) => ReactNode;
}) {
  const session = useVideoNotes({ projectId: notes.projectId, version, role: notes.role, userId: notes.userId, archived: notes.archived, forms: notes.forms, markup: notes.markup === true, openNoteId: notes.openNoteId ?? null });
  // The drawing surface, the Draw button and the drawing stack reach the player only as these slots, built here in the notes chunk: the player never imports them, so a Project without markup pays nothing.
  const { overlay, transportActions, transportReplacement } = useVideoMarkup(session);
  // The marker export lives here, not in the panel, so the phone header's action sheet reaches the same options and request as the desktop ⋯ menu (identity-keyed by Version inside the hook).
  const exp = useMarkerExport({ enabled: notes.exportEnabled === true && roleHasCapability(session.role, "viewVideo"), projectId: session.projectId, assetId: session.assetId, userId: session.userId, title: video.title, version: version.version, threads: session.threads });
  const phone = useMediaQuery(PHONE_QUERY);
  const drawing = useSyncExternalStore(session.forms.subscribe, () => session.forms.slot(session.assetId).draw?.phase === "drawing");
  // On a phone the Draw button is the composer's pen (D11), not the player's transport row.
  const pen = phone ? transportActions : undefined;
  return <>{children({
    playerProps: { ...session.playerProps, ...(overlay ? { overlay } : {}), ...(transportActions && !phone ? { transportActions } : {}), ...(transportReplacement ? { transportReplacement } : {}) },
    panel: <VideoNotesPanel key={version.assetId} session={session} video={video} detailsRows={detailsRows} exp={exp} phone={phone} {...(pen ? { pen } : {})} />,
    // The open notes the list can show (#879 PR 3a): a deleted root nobody replied to is hidden, so it is not counted either.
    markerExport: exp, drawing, openCount: session.threads ? noteCounts(session.threads, DEFAULT_NOTE_FILTERS).totals.open : null,
  })}</>;
}
