import type { ReactNode } from "react";
import type { Role, VideoVersionDto } from "@quincy/shared";
import { useVideoNotes, type DraftStore, type VideoNotesSession } from "./use-video-notes";
import { VideoNotesPanel } from "./VideoNotesPanel";

/**
 * Owns the notes session (query, marks, filters, the player's clock) for the Version on screen, one level above the player so the panel and
 * the player share it. This module is the whole notes UI: the review viewer loads it lazily, only when the Project's notes part is on, so a
 * Project without notes never pays for it (and the notes-off viewer is exactly the 4d-ii viewer).
 */
export default function VideoNotesHost({ notes, version, detailsRows, children }: {
  notes: { projectId: string; role: Role; userId: string | null; archived: boolean; drafts: DraftStore };
  version: VideoVersionDto;
  /** The Version details rows, which the panel shows behind a button. */
  detailsRows: ReactNode;
  children: (slots: { playerProps: VideoNotesSession["playerProps"]; panel: ReactNode }) => ReactNode;
}) {
  const session = useVideoNotes({ projectId: notes.projectId, version, role: notes.role, userId: notes.userId, archived: notes.archived, drafts: notes.drafts });
  return <>{children({ playerProps: session.playerProps, panel: <VideoNotesPanel key={version.assetId} session={session} detailsRows={detailsRows} /> })}</>;
}
