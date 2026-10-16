import type { VideoNoteThreadDto } from "@quincy/shared";
import { noteAnchorLabel } from "../../lib/video-note-view";
import { ReviewNoteCard } from "../quincy/ReviewNoteCard";
import { authorName, NoteText } from "./VideoNoteThread";

/** The staff viewer's marker card in Full screen (#880): the root note, drawn by the notes' own renderer (`NoteText`), over the film. */
export function VideoImmersiveNoteCard({ thread, timecode, onClose }: { thread: VideoNoteThreadDto; timecode: (frame: number) => string; onClose: () => void }) {
  return <ReviewNoteCard author={authorName(thread)} anchor={noteAnchorLabel(thread, timecode)} onClose={onClose}><NoteText note={thread} /></ReviewNoteCard>;
}
