import { frameLabel, type FrameLabelVersion, type VideoNoteDto, type VideoNoteThreadDto, type VideoVersionDto } from "@quincy/shared";

/**
 * Shared shaping for the video tools (#963; #964 and #972 reuse it). Pure functions over route JSON: no dispatch, no D1.
 *
 * - `versionTiming` / `timecodeLabel`: what a frame is called on one Version.
 * - `untrustedGuestText`: guest-written values in one delimited string the AI client is told never to obey (see `../instructions.ts`).
 * - `formatNote` / `formatThread`: a note or thread as a tool returns it, with `authorKind`, timecode labels, and guest text moved into `untrustedGuestText`.
 */

/** What a Version's frames need to be labelled and bounded: its rate, length and timecode base, as `GET /videos` carries them. */
export type VersionTiming = FrameLabelVersion & { frameCount: number };

export const versionTiming = (version: VideoVersionDto): VersionTiming => ({
  fps: version.fps, frameCount: version.frameCount, startTimecodeFrames: version.startTimecodeFrames, tcNominalFps: version.tcNominalFps, tcDropFrame: version.tcDropFrame,
});

/** The SMPTE timecode of a 0-based frame on this Version (start timecode and drop-frame included), as the browser shows it by default. */
export const timecodeLabel = (frame: number, version: FrameLabelVersion): string => frameLabel(frame, "timecode", version);

export type AuthorKind = "guest" | "staff";

export const UNTRUSTED_GUEST_OPEN = "<untrusted-guest-text>";
export const UNTRUSTED_GUEST_CLOSE = "</untrusted-guest-text>";

/**
 * Guest-written values as one delimited string: `<untrusted-guest-text>{json}</untrusted-guest-text>`. The JSON has `<`, `>` and `&` written as
 * `<` / `>` / `&`, so a guest cannot type the closing delimiter and step outside it; `JSON.parse` of the inner text gives the values back.
 */
export function untrustedGuestText(values: Record<string, unknown>): string {
  const json = JSON.stringify(values).replace(/[<>&]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${UNTRUSTED_GUEST_OPEN}${json}${UNTRUSTED_GUEST_CLOSE}`;
}

/** A note as a tool returns it: the route's DTO plus `authorKind` and timecodes, with guest-written text only inside `untrustedGuestText`. */
export type McpVideoNote = Omit<VideoNoteDto, "body" | "content" | "author" | "copiedFrom"> & {
  authorKind: AuthorKind;
  author: VideoNoteDto["author"] | { kind: "guest"; id: string; email?: string };
  copiedFrom: VideoNoteDto["copiedFrom"] | { version: number; authorRole: string } | null;
  body?: string;
  content?: VideoNoteDto["content"];
  /** Present when any of this note's text was written by a Guest reviewer: the note's own author, or the guest a staff copy was pasted from. */
  untrustedGuestText?: string;
  /** Labels of `startFrame`, `endFrame` (exclusive) and `drawingFrame`; null when the frame is null or the Version's timing is unknown. */
  startTimecode: string | null;
  endTimecode: string | null;
  drawingTimecode: string | null;
};
export type McpVideoThread = McpVideoNote & { replies: McpVideoNote[] };

/**
 * Shapes one note. A guest author's name, the body and the rich `content` move into `untrustedGuestText`; so do the body and the original
 * author's name of a staff copy pasted from a guest note (`copiedFrom.authorRole === "guest"`), whose `authorKind` stays "staff" (the row's author).
 */
export function formatNote(note: VideoNoteDto, timing: VersionTiming | null): McpVideoNote {
  const { body, content, author, copiedFrom, ...rest } = note;
  const label = (frame: number | null) => (frame === null || timing === null ? null : timecodeLabel(frame, timing));
  const labels = { startTimecode: label(note.startFrame), endTimecode: label(note.endFrame), drawingTimecode: label(note.drawingFrame) };
  const copiedFromGuest = copiedFrom !== null && copiedFrom.authorRole === "guest";
  if (author.kind === "staff" && !copiedFromGuest) return { ...rest, authorKind: "staff", author, copiedFrom, body, ...(content !== undefined ? { content } : {}), ...labels };
  const guest: Record<string, unknown> = {};
  let shownAuthor: McpVideoNote["author"] = author;
  if (author.kind === "guest") { const { name, ...kept } = author; guest.name = name; shownAuthor = kept; }
  guest.body = body;
  if (content !== undefined) guest.content = content;
  let shownCopiedFrom: McpVideoNote["copiedFrom"] = copiedFrom;
  if (copiedFrom !== null && copiedFromGuest) { const { authorName, ...kept } = copiedFrom; guest.copiedFromAuthorName = authorName; shownCopiedFrom = kept; }
  return { ...rest, authorKind: author.kind, author: shownAuthor, copiedFrom: shownCopiedFrom, untrustedGuestText: untrustedGuestText(guest), ...labels };
}

/** A thread: the root and each reply shaped on its own (a guest can reply to a staff note and the other way round). */
export function formatThread(thread: VideoNoteThreadDto, timing: VersionTiming | null): McpVideoThread {
  const { replies, ...root } = thread;
  return { ...formatNote(root, timing), replies: replies.map((reply) => formatNote(reply, timing)) };
}
