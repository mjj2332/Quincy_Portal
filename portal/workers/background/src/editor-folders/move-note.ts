/**
 * The `editor_folder_mappings.move_note` format and the move limits a reader of it needs.
 *
 * Kept import-free on purpose: the app worker imports this to surface blocked and stuck moves
 * (#163), and must not pull the Dropbox client or the move state machine into its bundle.
 */

/**
 * How many times a commit may fail AFTER Dropbox has already reported the tree at its new
 * location before the move stops being retried and is escalated instead.
 *
 * This is the one genuinely dangerous state in the feature: the world has changed and the database
 * has not. Retrying is right for a transient D1 failure and wrong for a deterministic one — a
 * UNIQUE collision fails identically every minute, forever, while the project's Editor pipeline
 * stays fenced and nobody is told. Past this limit the mapping stays `moving` (so the fence holds
 * and no sync runs against a path that no longer exists) but takeover stops, the note says plainly
 * that Dropbox and the database disagree, and an audit row records it for a human to find.
 */
export const MOVE_COMMIT_ATTEMPT_LIMIT = 3;

/** `<code>: <sentence>` — the one place the note is joined. */
export function formatMoveNote(code: string, detail: string): string {
  return `${code}: ${detail}`;
}

/** The inverse of `formatMoveNote`. A note with no separator is treated as a bare code. */
export function parseMoveNote(note: string): { code: string; detail: string } {
  const separator = note.indexOf(": ");
  if (separator === -1) return { code: note, detail: note };
  return { code: note.slice(0, separator), detail: note.slice(separator + 2) };
}
