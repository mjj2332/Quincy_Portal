import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VIDEO_NOTE_BODY_MAX, type Role, type VideoNoteCreateInput, type VideoNoteVisibility } from "@quincy/shared";
import { useFrameClockSelector, type VideoFrameClock } from "../../lib/video-frame-clock";
import { draftDoc, effectiveMarks, frameOnScreen, type NoteFormStore } from "../../lib/video-note-form-store";
import { EMPTY_MARKS } from "../../lib/video-note-marks";
import { cn } from "../../lib/utils";
import { PHONE_QUERY } from "../../lib/review-pane-geometry";
import { useMediaQuery } from "../../lib/use-media-query";
import type { RichTextEditorHandle } from "../QuincyRichTextEditorBase";
import { Button } from "../quincy/Button";
import { DRAWING_NEEDS_WORDS, NoteComposerBox, rangeChip, type NoteAnchorChip } from "../quincy/NoteComposerBox";
import { SHEET_TEXT, SheetModeContext, usePostHold } from "../quincy/ReviewSheet";
import { MARKUP_FULL_TEXT, type NoteDrawControls } from "./VideoMarkupOverlay";
import { VideoNoteEditor } from "./VideoNoteEditor";

/** A line in the box above its tools (a lock, a problem). Label type: the box is quiet, so these are text, not cards. */
const LINE = "m-0 [font:var(--type-label)]";
/** The phone box at rest shows one line of the draft (P1: two rows); in compose mode the sheet publishes the room left above the keyboard (`--sheet-text-room`), at most the box's seven lines. */
const REST_TEXT = "max-h-[var(--space-5)] overflow-hidden";
const COMPOSE_TEXT = "max-h-[clamp(var(--space-5),var(--sheet-text-room,calc(var(--space-5)*7)),calc(var(--space-5)*7))]";
const PLACEHOLDER = "Add a note at this frame… Use @ to mention a colleague.";

/**
 * The composer at the foot of the notes panel (#741 5b; #927 frames C1, C2, C4–C7, P1, P3–P5): the shared `NoteComposerBox` in its staff variant. A note is anchored to
 * the in / out marks if there are any, else to the frame on screen when the note started: its first text, its first upload or its first stroke (the store freezes it; a
 * phone also stamps it on focus, D10, since focus pauses the film there). Until then the chip follows the playhead. Post pauses, waits for that frame to be on screen
 * (10 s at most) and only then sends. Nothing retries by itself: after a network failure the note may or may not have posted, so the draft is kept and the person
 * refreshes. Visibility starts Internal every time the composer is empty and is never sticky; it is immutable once posted. Send needs text or media (D2): a drawing
 * alone is not a note. The draft, the marks and the request all live in the Video tab's form store, so this component only renders them and sends commands.
 *
 * The pen and the drawing row are `useVideoMarkup`'s (`draw`): the pen pauses and brings the frame up, then the row takes the tools' place until ‹ or Esc, and Clear is
 * how a drawing goes. On a phone the box is the sheet's foot (`SheetModeContext`): one line of text and the tools at rest, the whole draft in compose mode.
 */
export function VideoNoteComposer({ store, assetId, clock, frameCount, timecode, post, onRefresh, markup = false, rich, draw }: {
  store: NoteFormStore;
  assetId: string;
  clock: VideoFrameClock | null;
  frameCount: number;
  timecode: (frame: number) => string;
  post: (input: VideoNoteCreateInput) => Promise<unknown>;
  onRefresh: () => void;
  /** The Project's `markup` part is on: a drawing in the draft shows on the chip, and Post sends it. */
  markup?: boolean;
  /** The rich field (#835): the Project and the person's role, which the @ list and the upload routes need. */
  rich: { projectId: string; role: Role };
  /** The pen and the drawing row (`useVideoMarkup`). Absent: no pen. */
  draw?: NoteDrawControls;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const sheet = useContext(SheetModeContext);
  const [focused, setFocused] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const editor = useRef<RichTextEditorHandle>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const slot = useSyncExternalStore(store.subscribe, () => store.slot(assetId));
  const { composer, open, op } = slot;
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  // While an edit or reply is open the marks are its (the composer takes none, and Send and in / out are locked with the reason).
  const marks = open ? EMPTY_MARKS : effectiveMarks(slot.marks, clock).value;
  const phase = op?.form === "composer" ? op.phase : "idle";
  const otherForm = open?.kind ?? null;
  const problem = composer.problem;
  const visibility: VideoNoteVisibility = composer.visibility;

  const drawn = markup && slot.markup.items.length > 0 && slot.markup.drawingFrame !== null ? slot.markup : null;
  const drawingNow = markup && slot.draw !== null;
  const tooLong = composer.body.length > VIDEO_NOTE_BODY_MAX;
  const hasText = composer.body.trim() !== "";
  const canPost = clock !== null && op === null && otherForm === null && hasText && !tooLong && !uploading;
  const frozen = phase !== "idle";
  const submit = () => { if (canPost && clock) void store.post(assetId, { clock, frameCount, send: post, markup }); };
  const mark = (kind: "in" | "out") => { if (clock) store.mark(assetId, kind, frameOnScreen(clock.getState()), clock); };

  // The chip: In → Out (Out follows the playhead until it is marked), else the anchor. A drawing puts the pencil on it; it never has a chip of its own.
  const chip: NoteAnchorChip = rangeChip(marks, liveFrame, timecode, { onClear: () => { store.clearMarks(assetId); }, disabled: frozen || drawingNow })
    ?? (marks.out !== null
      ? { kind: "point", at: timecode(marks.out), following: false }
      : { kind: "point", at: timecode(drawn?.drawingFrame ?? composer.anchorFrame ?? liveFrame), following: composer.anchorFrame === null && drawn === null });
  const label = phase === "confirming" ? "Confirming…" : phase === "posting" ? "Posting…" : problem?.retry ? "Retry" : "Post note";
  const lock = clock === null ? "Loading the film…" : otherForm !== null ? `Finish or cancel the open ${otherForm} first.` : null;
  const sendReason = lock ?? (uploading ? "Wait for the uploads to finish." : tooLong ? `Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.` : !hasText && drawn ? DRAWING_NEEDS_WORDS : undefined);

  // The phone layout follows the sheet's mode and nothing else (#879 fix). Outside a phone sheet (a composer rendered on its own) the field's focus stands in for it.
  const composing = phone && (sheet ? sheet.mode === "compose" : focused);
  // A post sent from compose mode holds it until the post settles (the box shows its phase); a success then returns to browse with the note listed.
  const fromCompose = useRef(false);
  const posting = op?.form === "composer";
  const postHold = posting && fromCompose.current;
  const send = () => { fromCompose.current = composing; submit(); };
  usePostHold(sheet?.setHold, postHold);
  const wasPosting = useRef(false);
  useEffect(() => {
    if (posting) { wasPosting.current = true; return; }
    if (!wasPosting.current) return;
    wasPosting.current = false;
    const held = fromCompose.current;
    fromCompose.current = false;
    if (held && problem === null) { const active = document.activeElement; if (active instanceof HTMLElement && active.closest('[data-notes-form="composer"]') !== null) active.blur(); }
  }, [posting, problem]);
  // A phone draft abandoned at rest with nothing in it (no text, no media, no stroke) gives its focus stamp back, so the chip follows the film again.
  const strokes = slot.markup.items.length;
  useEffect(() => { if (phone && !composing && composer.body === "" && strokes === 0 && composer.anchorFrame !== null) store.stamp(assetId, null); }, [phone, composing, composer.body, strokes, composer.anchorFrame, store, assetId]);
  // The first accepted upload starts the note (#927): its frame is the anchor from then on.
  const onUploadingChange = (next: boolean) => { setUploading(next); if (next && clock) store.freeze(assetId, frameOnScreen(clock.getState())); };

  const notice = <>
    {(tooLong || problem !== null) && <div role="alert" data-testid="video-note-problem" className={cn(LINE, "flex flex-wrap items-center justify-between gap-x-[var(--space-2)] text-destructive")}>
      <span className="min-w-0 flex-1">{tooLong ? `Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.` : problem!.text}</span>
      {!tooLong && problem!.refresh && <Button type="button" variant="text" data-testid="video-note-refresh" className="min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={onRefresh}>Refresh notes</Button>}
    </div>}
    {draw?.full && <p role="status" data-testid="video-markup-full" className={cn(LINE, "text-warning-foreground")}>{MARKUP_FULL_TEXT}</p>}
    {lock !== null && <p data-testid="video-note-other-form-hint" className={cn(LINE, "text-foreground-secondary")}>{lock}</p>}
  </>;

  const field = <div
    ref={fieldRef}
    data-testid="video-note-editor"
    onKeyDownCapture={(event) => { if (frozen) event.preventDefault(); }}
    // A phone note is stamped when typing begins (D10): focusing the field pauses the film on the frame the note will anchor to and stamps it, so nothing moves it before the first keystroke.
    onFocusCapture={() => { setFocused(true); if (phone && clock) { clock.pause(); store.stamp(assetId, frameOnScreen(clock.getState())); } }}
    onBlurCapture={(event) => { if (!(event.relatedTarget instanceof Element && event.currentTarget.contains(event.relatedTarget))) setFocused(false); }}
  >
    <label className="sr-only" htmlFor="video-note-body">Add a note</label>
    <VideoNoteEditor
      ref={editor} id="video-note-body" projectId={rich.projectId} role={rich.role} value={draftDoc(composer.content, composer.body)} disabled={frozen}
      placeholder={phone ? (drawn ? "Add a note with this drawing…" : "Add a note…") : PLACEHOLDER}
      onChange={(doc) => { if (!frozen) store.setContent(assetId, doc, clock ? frameOnScreen(clock.getState()) : 0); }} onSubmit={send} onUploadingChange={onUploadingChange}
      stripContainer={strip} bubbleDocked={phone} bubbleDockTo={() => fieldRef.current?.closest('[data-testid="note-composer-box"]') ?? null}
    />
  </div>;

  return <NoteComposerBox
    variant="staff" label="Add a note" testId="video-note-composer" phone={phone} floating={sheet?.floating === true}
    // The panel's foot draws the hairline and the gutter (it follows the phone's notes head), so the box draws no foot of its own.
    className={cn(otherForm !== null && "opacity-60")}
    formAttributes={{ "data-notes-form": "composer", "data-locked": otherForm !== null ? "true" : "false", ...(phone ? { "data-compose": composing ? "true" : "false" } : {}) }}
    {...(phone ? { textClassName: composing ? COMPOSE_TEXT : REST_TEXT, textAttributes: SHEET_TEXT } : {})}
    field={field}
    strip={<div ref={setStrip} data-testid="video-note-strip" className="empty:hidden" />}
    notice={notice}
    chip={chip} drawn={drawn !== null}
    range={{ marks, onPress: (step) => { if (step === "clear") store.clearMarks(assetId); else mark(step); }, ...(lock !== null || frozen || drawingNow ? { disabled: true, ...(lock ? { reason: lock } : {}) } : {}) }}
    attach={{ onPick: () => { editor.current?.pickMedia(); }, ...(frozen || otherForm !== null ? { disabled: true, ...(lock ? { reason: lock } : {}) } : {}) }}
    {...(draw?.pen ? { pen: draw.pen } : {})}
    draw={draw?.row ?? null}
    visibility={{ value: visibility, disabled: frozen, onChange: (next) => { if (!frozen) store.setVisibility(assetId, next); } }}
    send={{ label, onSend: send, disabled: !canPost, pending: frozen, ...(sendReason ? { reason: sendReason } : {}) }}
  />;
}
