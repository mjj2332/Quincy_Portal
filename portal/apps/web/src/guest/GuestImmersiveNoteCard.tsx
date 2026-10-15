import type { GuestNoteThreadDto } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { ReviewNoteCard } from "../components/quincy/ReviewNoteCard";
import { noteAnchorLabel } from "../lib/video-note-view";
import { NoteText } from "./GuestNoteItem";

/** The guest page's marker card in Full screen (#880): the root note, drawn by the guest notes' own renderer, over the film. */
export function GuestImmersiveNoteCard({ thread, timecode, media, onClose, onShowInNotes }: { thread: GuestNoteThreadDto; timecode: (frame: number) => string; media: EditorMediaTransport; onClose: () => void; onShowInNotes: () => void }) {
  return <ReviewNoteCard author={thread.author.name} anchor={noteAnchorLabel(thread, timecode)} onClose={onClose} onShowInNotes={onShowInNotes}><NoteText note={thread} media={media} /></ReviewNoteCard>;
}
