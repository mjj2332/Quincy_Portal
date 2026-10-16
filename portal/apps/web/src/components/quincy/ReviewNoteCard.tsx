import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Item, ItemContent, ItemHeader, ItemMedia } from "../reui/item";
import { IconButton } from "./icon-button";
import { InitialsAvatar } from "./InitialsAvatar";

/**
 * The note a marker press shows over the film in Full screen (#880, F3, D13): the root note only (replies stay in the notes), read-only, with Close alone. F3 has no "Show in notes":
 * Full screen has no notes list (D13; owner decision, #880 review 11).
 * Presentational: the screen hands over the author, the anchor and the body already drawn by the note renderers it already uses (so nothing about how a note renders changes). It is a
 * region, not a dialog: focus does not move into it on open (the film and its controls stay where they were), and the screen closes it on play, dismiss, exit and a Version change.
 * On the inverse surface like the rest of the viewer (ADR 0024).
 */
export function ReviewNoteCard({ author, anchor, children, onClose }: {
  author: string;
  /** The timecode (or range) the note is anchored to. */
  anchor: string;
  /** The note's body, drawn by the screen's own note renderer. */
  children: ReactNode;
  onClose: () => void;
}) {
  return <Item variant="outline" size="sm" role="region" aria-label={`Note by ${author}`} data-testid="review-note-card" className="flex-nowrap items-start bg-card text-card-foreground">
    <ItemMedia><InitialsAvatar name={author} className="size-6" /></ItemMedia>
    <ItemContent className="min-w-0">
      <ItemHeader>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--space-2)]">
          <strong data-testid="review-note-card-author" className="min-w-0 text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-snug)_var(--font-sans)] [overflow-wrap:anywhere]">{author}</strong>
          <span data-testid="review-note-card-anchor" className="text-foreground-secondary [font:var(--type-mono)] tabular-nums">{anchor}</span>
        </span>
        <IconButton aria-label="Close note" data-testid="review-note-card-close" onClick={onClose}><X aria-hidden="true" className="size-4" /></IconButton>
      </ItemHeader>
      <div data-testid="review-note-card-body" className="max-h-[30dvh] overflow-y-auto text-foreground">{children}</div>
    </ItemContent>
  </Item>;
}
