import { useContext, useEffect, useId, useRef, useState } from "react";
import { ATTACHMENT_RETRY_OR_REMOVE, WAIT_FOR_UPLOADS } from "../lib/attachments-core";
import type { GuestEditorTransport } from "./GuestNoteEditor";
import { useFrameClockSelector, type VideoFrameClock } from "../lib/video-frame-clock";
import type { RichTextEditorHandle } from "../components/QuincyRichTextEditorBase";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { SHEET_TEXT, SheetModeContext, usePostHold } from "../components/quincy/ReviewSheet";
import { DRAWING_NEEDS_WORDS, NoteComposerBox, rangeChip, type NoteAnchorChip } from "../components/quincy/NoteComposerBox";
import { GuestNoteField } from "./GuestNoteField";
import type { GuestStrip } from "./use-guest-compose";

const EDITABLE = 'textarea, [contenteditable]:not([contenteditable="false"])';
/** On a phone the box's text region gives way to the film's floor first (#879 fix r9): the sheet publishes `--sheet-text-room`, rounded down to whole 24px lines, one line at least, seven at most. */
const PHONE_TEXT_ROOM = "max-h-[clamp(var(--space-5),round(down,var(--sheet-text-room,calc(var(--space-5)*7)),var(--space-5)),calc(var(--space-5)*7))]";
const PHONE_TEXT_ATTRS: Record<`data-${string}`, string> = { ...SHEET_TEXT };

/**
 * The guest's note composer (#927 G1 / E1, P1–P5 on a phone): the one note box (`quincy/NoteComposerBox`), `guest` for a new note (no visibility: a guest's note is always
 * public; the pen only where the link allows drawing) and `edit` for the guest's own root note (Cancel and Save, the D4 lock, and no visibility: owner decision 2026-10-20). It renders the
 * guest's own draft (`useGuestCompose`'s `strip`), since the staff composer is bound to the staff form store and `lib/api` (`guest-boundary.guard.test.ts`).
 *
 * - The same box at every width: the rail's foot on a desktop, the review sheet's foot on a phone, floating over the film in Full screen (`floating`).
 * - The chip follows the film until the note starts (the first text, an upload, a mark, a stroke); one in/out button marks In, then Out, then clears. On a phone the focus pauses
 *   and stamps a pristine draft (D10), an untouched one is given back at rest, and a post that is out holds compose mode. A draft that closes blurs the field.
 * - The field is mounted for a verified guest, so the first tap raises the keyboard. While its chunk loads a same-size placeholder stands in; for a guest who has not verified, the
 *   field's place is one button that asks for verification.
 */
export function GuestNoteComposer({ strip, clock, timecode, media, verified, onShellPress, phone = false, floating = false }: {
  strip: GuestStrip;
  clock: VideoFrameClock | null;
  timecode: (frame: number) => string;
  /** The link's media and file routes (#956): what the field uploads through. */
  media: GuestEditorTransport;
  /** A verified guest gets the field; one who is not gets the shell, which asks for verification. */
  verified: boolean;
  onShellPress: () => void;
  phone?: boolean;
  /** Full screen's box over the film. */
  floating?: boolean;
}) {
  const sheet = useContext(SheetModeContext);
  const inSheet = phone && sheet !== null;
  const mode = sheet?.mode ?? "browse";
  const fieldId = useId();
  const editor = useRef<RichTextEditorHandle | null>(null);
  const [stripHost, setStripHost] = useState<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  const blurInBox = () => { const active = document.activeElement; if (active instanceof HTMLElement && boxRef.current?.contains(active)) active.blur(); };

  // A post sent from compose mode holds it until it settles, as the staff phone composer does (C7).
  const fromCompose = useRef(false);
  useEffect(() => { if (!strip.pending) fromCompose.current = false; }, [strip.pending]);
  const postHold = strip.pending && fromCompose.current;
  usePostHold(inSheet ? sheet.setHold : undefined, postHold);
  // A draft that closes (a post landed, an unchanged edit, another Version) gives the focus up, so a phone's compose mode ends the ordinary way.
  const wasOpen = useRef(strip.open);
  useEffect(() => { if (wasOpen.current && !strip.open && phone) blurInBox(); wasOpen.current = strip.open; });
  // An untouched new draft is given back at rest on a phone: the chip follows the film again.
  const { releaseIfPristine } = strip;
  useEffect(() => { if (inSheet && mode === "browse") releaseIfPristine(); });
  // An edit's text lands through the field's own content sync (a child effect, so before this one): the caret goes to its end.
  useEffect(() => {
    if (!strip.editing) return;
    const field = document.getElementById(fieldId);
    if (!field || document.activeElement !== field) return;
    if (field instanceof HTMLTextAreaElement) { field.setSelectionRange(field.value.length, field.value.length); return; }
    const selection = window.getSelection();
    selection?.selectAllChildren(field);
    selection?.collapseToEnd();
  }, [strip.editing, fieldId]);

  const send = () => { fromCompose.current = mode === "compose"; strip.send(); };
  const cancel = () => { if (phone) blurInBox(); strip.cancel(); };

  const { frames, rangeMarks } = strip;
  const chip: NoteAnchorChip = rangeChip(rangeMarks, liveFrame, timecode, { onClear: strip.clearRange, disabled: strip.pending || strip.marksLocked })
    ?? { kind: "point", at: timecode(strip.following || frames === null ? liveFrame : frames.startFrame), following: strip.following };
  const busy = strip.pending || !strip.clockReady;
  const range = {
    marks: rangeMarks, onPress: (step: "in" | "out" | "clear") => { if (step === "clear") strip.clearRange(); else strip.mark(step); },
    disabled: busy || strip.penDown || strip.marksLocked || !verified, ...(strip.marksLocked && strip.lockHint ? { reason: strip.lockHint } : {}),
  };
  // D4: editing the range locks the pen (and a drawing locks the range, above), each with the reason as its title.
  const pen = strip.canDraw ? { onPress: strip.pen, disabled: !verified || (strip.penDisabled && !strip.penDown), ...(strip.penDisabled && strip.lockHint ? { reason: strip.lockHint } : {}) } : undefined;
  const attach = { onPick: () => { editor.current?.pickMedia(); }, disabled: strip.pending || !verified };
  // D2: a drawing alone is not a note.
  const reason = strip.empty && strip.strokes > 0 ? DRAWING_NEEDS_WORDS : strip.uploading ? WAIT_FOR_UPLOADS : strip.failedFiles > 0 ? ATTACHMENT_RETRY_OR_REMOVE : undefined;
  const blocked = busy || strip.uploading || strip.failedFiles > 0 || strip.empty;

  const placeholder = phone ? "Add a note…" : "Add a note at this frame…";
  const shell = (loading: boolean) => <span data-testid="guest-compose-shell" aria-busy={loading || undefined} className="relative block min-h-[var(--space-5)]">
    <span aria-hidden="true" className="text-muted-foreground">{placeholder}</span>
    {loading && <span className="sr-only">Loading the note field…</span>}
    {/* Only a hit area over the placeholder, so Base UI's unstyled button rather than a styled Button whose height and hover it would undo. */}
    {!loading && <ButtonPrimitive type="button" data-testid="guest-compose-shell-open" aria-label="Add a note" className="absolute inset-0 cursor-text" onClick={onShellPress} />}
  </span>;
  const field = <div
    ref={strip.fieldHost} data-testid="guest-composer-field" className="min-w-0"
    // A phone note is stamped when typing begins (D10): focusing the field pauses the film and stamps the frame on screen. A desktop's focus alone leaves the chip following (#927).
    onFocusCapture={phone ? (event) => { if (event.target instanceof Element && event.target.matches(EDITABLE)) strip.focusStamp(); } : undefined}
  >
    {verified
      ? <GuestNoteField
        key={strip.editorKey} ref={editor} testId="guest-composer-body" id={fieldId} label={strip.editing ? "Edit your note" : "Your note"} placeholder={placeholder}
        media={media} value={strip.doc} disabled={strip.pending} onChange={strip.setDoc} onUploadingChange={strip.setUploading} onFailedFilesChange={strip.setFailedFiles} onSubmit={send}
        stripContainer={stripHost} bubbleDocked={phone} bubbleDockTo={() => boxRef.current?.querySelector('[data-testid="note-composer-box"]') ?? null} fallback={shell(true)}
      />
      : shell(false)}
  </div>;
  const notice = strip.problem !== null || strip.latest !== null || strip.refused || !strip.clockReady
    ? <div className="flex flex-col gap-[var(--space-1)] text-foreground-secondary [font:var(--type-label)]">
      {!strip.clockReady && <p data-testid="guest-composer-stamp" className="m-0">Loading the film…</p>}
      {strip.refused && <p role="status" className="m-0">That is as much drawing as one note can hold. Undo a stroke to add more.</p>}
      {strip.problem !== null && <p role="alert" data-testid="guest-composer-problem" className="m-0 max-h-[var(--space-9)] overflow-y-auto text-destructive-wash-foreground">{strip.problem}</p>}
      {strip.latest !== null && <p data-testid="guest-composer-latest" className="m-0 max-h-[var(--space-9)] overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{`Latest saved version: ${strip.latest}`}</p>}
    </div>
    : null;

  const common = {
    field, strip: <div ref={setStripHost} className="empty:hidden" />, notice, attach, phone, floating, foot: true, chip, drawn: strip.strokes > 0 || strip.keptDrawing, range, ...(pen ? { pen } : {}), draw: strip.draw,
    testId: "guest-composer", formAttributes: { "data-open": strip.open ? "true" : "false" } as Record<`data-${string}`, string>,
    ...(phone ? { textClassName: PHONE_TEXT_ROOM, textAttributes: PHONE_TEXT_ATTRS } : {}),
  };
  return <div ref={boxRef} className="contents">
    {strip.editing
      ? <NoteComposerBox {...common} variant="edit" label="Edit note" save={{ onSave: send, onCancel: cancel, disabled: blocked, ...(reason ? { reason } : {}), pending: strip.pending }} />
      : <NoteComposerBox {...common} variant="guest" label="Add a note" send={{ label: "Post note", onSend: send, disabled: blocked, ...(reason ? { reason } : {}), pending: strip.pending }} />}
  </div>;
}
