import type { GuestNoteThreadDto } from "@quincy/shared";
import type { GuestReadMedia } from "./guest-api";
import { ReviewNoteCard } from "../components/quincy/ReviewNoteCard";
import { noteAnchorLabel } from "../lib/video-note-view";
import { NoteText } from "./GuestNoteItem";

/** The guest page's marker card in Full screen (#880): the root note, drawn by the guest notes' own renderer, over the film. */
export function GuestImmersiveNoteCard({ thread, timecode, media, onClose }: { thread: GuestNoteThreadDto; timecode: (frame: number) => string; media: GuestReadMedia; onClose: () => void }) {
  return <ReviewNoteCard author={thread.author.name} anchor={noteAnchorLabel(thread, timecode)} onClose={onClose}><NoteText note={thread} media={media} /></ReviewNoteCard>;
}
