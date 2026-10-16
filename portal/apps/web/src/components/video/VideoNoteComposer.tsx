import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PencilIcon, StepBack, StepForward } from "lucide-react";
import { VIDEO_NOTE_BODY_MAX, type Role, type VideoNoteCreateInput, type VideoNoteVisibility } from "@quincy/shared";
import { useFrameClockSelector, type VideoFrameClock } from "../../lib/video-frame-clock";
import { draftDoc, effectiveMarks, frameOnScreen, type NoteFormStore } from "../../lib/video-note-form-store";
import { EMPTY_MARKS, marksToFrames } from "../../lib/video-note-marks";
import { cn } from "../../lib/utils";
import { PHONE_QUERY } from "../../lib/review-pane-geometry";
import { useMediaQuery } from "../../lib/use-media-query";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { SheetModeContext } from "../quincy/ReviewSheet";
import { COMPOSE_CLAMP, ComposeTray, PHONE_LINE, PILL_CHIP, PillPlus, PillSend, REST_CLAMP, SHEET_TEXT, STRIP_GRID, STRIP_TEXT_BUTTON, keepFocus, shortRange, useRestPlaceholder } from "../quincy/compose-strip";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { Kbd } from "../reui/kbd";
import { VideoNoteEditor } from "./VideoNoteEditor";

const HINT: Record<VideoNoteVisibility, string> = {
  internal: "Studio only — never shown on the client link.",
  public: "Shown to the client on the review link.",
};
/** The visibility as the phone's hint line says it (C3): it is behind the + there, so the line names it. */
const VISIBILITY_LABEL: Record<VideoNoteVisibility, string> = { internal: "Internal", public: "Client-visible" };
// On a short window the list needs the height: two rows until the field is focused or holds text (the 800px query is the window's height).
/** The anchor chip, shared with the edit form. */
export const ANCHOR_CHIP_ROW = "@max-[280px]:basis-full";
export const ANCHOR_CHIP = "rounded-md bg-muted px-[var(--space-2)] py-[var(--space-1)] text-foreground [font:var(--type-mono)] tabular-nums";
/** The key hint is visual only at panel widths from 280px (the form is a size container); below that it stays for assistive tech but takes no room. */
const KBD_HINT = "@max-[280px]:sr-only";
const SMALL_BUTTON = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";
// The phone strip's classes, Cancel's focus-keeping press, the + tray, the + and the round Send are shared with the guest's composer (`quincy/compose-strip.tsx`, #879 PR 2).

/**
 * The composer at the foot of the notes panel (#741 5b). A note is anchored to the in / out marks if there are any, else to the frame
 * that was on screen when typing began (frozen: playback moving on does not move it). Post pauses, waits for that frame to be on screen
 * (10 s at most) and only then sends. Nothing retries by itself: after a network failure the note may or may not have posted, so the draft
 * is kept and the person refreshes. Visibility starts Internal every time the composer is empty and is never sticky; it is immutable once posted.
 * The draft, the marks and the request all live in the Video tab's form store, so this component only renders them and sends commands.
 *
 * On a phone (#879, the prototype's P1 / P6 / P7) it is a pill: the timecode chip, the field and the pen in one row with a round Send. Which layout shows is the
 * sheet's mode alone (`SheetModeContext`): at rest (browse, draw) only that row; in compose mode a hint line above it, a + at its start that opens the inline
 * tray (visibility, frame step, Set in / out, the formatting toolbar), and Cancel under it. The editor is the same node in every layout and across the 721px
 * crossing: each layout's pieces are siblings in fixed slots around it.
 */
export function VideoNoteComposer({ store, assetId, clock, frameCount, timecode, post, onRefresh, markup = false, rich, pen }: {
  store: NoteFormStore;
  assetId: string;
  clock: VideoFrameClock | null;
  frameCount: number;
  timecode: (frame: number) => string;
  post: (input: VideoNoteCreateInput) => Promise<unknown>;
  onRefresh: () => void;
  /** The Project's `markup` part is on: a drawing in the draft shows as a chip, and Post sends it. */
  markup?: boolean;
  /** The rich field (#835): the Project and the person's role, which the @ list and the upload routes need. */
  rich: { projectId: string; role: Role };
  /** The Draw button on a phone (#879, D11): it sits inside the pill, and pressing it hides the keyboard before drawing starts. */
  pen?: ReactNode;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const sheet = useContext(SheetModeContext);
  const [focused, setFocused] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Cancel remounts the field: unmounting aborts its pending uploads and drops their cards.
  const [editorKey, setEditorKey] = useState(0);
  const slot = useSyncExternalStore(store.subscribe, () => store.slot(assetId));
  const { composer, open, op } = slot;
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  // While an edit or reply is open the marks are its (the composer takes none, and Post, Set in and Set out are disabled with a hint).
  const marks = open ? EMPTY_MARKS : effectiveMarks(slot.marks, clock).value;
  const phase = op?.form === "composer" ? op.phase : "idle";
  const otherForm = open?.kind ?? null;
  const problem = composer.problem;
  const visibility: VideoNoteVisibility = composer.visibility;

  const drawn = markup && slot.markup.items.length > 0 && slot.markup.drawingFrame !== null ? slot.markup : null;
  const drawingNow = markup && slot.draw !== null;
  const pendingFrames = marksToFrames(marks, frameCount);
  const tooLong = composer.body.length > VIDEO_NOTE_BODY_MAX;
  const canPost = clock !== null && op === null && otherForm === null && composer.body.trim() !== "" && !tooLong && !uploading;
  const frozen = phase !== "idle";
  const submit = () => { if (canPost && clock) void store.post(assetId, { clock, frameCount, send: post, markup }); };
  const mark = (kind: "in" | "out") => { if (clock) store.mark(assetId, kind, frameOnScreen(clock.getState()), clock); };

  // The anchor is only the timecode (or the in -> out pair); "Note at" stays for screen readers.
  // A drawing on the anchor frame is one chip, not two identical timecodes; with in / out marks the anchor reads differently and the drawing keeps its own chip.
  const merged = drawn !== null && !pendingFrames;
  const anchorText = pendingFrames
    ? marks.in !== null && marks.out !== null ? `In ${timecode(marks.in)} → Out ${timecode(marks.out)}` : marks.in !== null ? `In ${timecode(marks.in)}` : `Out ${timecode(marks.out!)}`
    : timecode(drawn?.drawingFrame ?? composer.anchorFrame ?? liveFrame);
  const label = phase === "confirming" ? "Confirming…" : phase === "posting" ? "Posting…" : problem?.retry ? "Retry" : "Post";

  // The phone layout follows the sheet's mode and nothing else (#879 fix). Outside a phone sheet (a composer rendered on its own) the field's focus and the tray stand in for it.
  const trayOpen = phone && slot.extras;
  const composing = phone && (sheet ? sheet.mode === "compose" : focused || trayOpen);
  // The pill's placeholder at rest ends at a word (#879 PR 3a); compose mode shows it whole.
  const restPlaceholder = useRestPlaceholder(drawingNow ? "Add a note with this drawing…" : "Add a note…", phone && !composing);
  const trayId = useId();
  const [trayToolbar, setTrayToolbar] = useState<HTMLDivElement | null>(null);
  // A post sent from the compose strip holds compose mode until it settles (the strip shows its phase); a success then returns to browse with the note listed (C7).
  const fromCompose = useRef(false);
  const posting = op?.form === "composer";
  const postHold = posting && fromCompose.current;
  const send = () => { fromCompose.current = composing; submit(); };
  const setHold = sheet?.setHold;
  useEffect(() => { setHold?.("tray", trayOpen); }, [setHold, trayOpen]);
  useEffect(() => { setHold?.("post", postHold); }, [setHold, postHold]);
  useEffect(() => () => { setHold?.("tray", false); setHold?.("post", false); }, [setHold]);
  const wasPosting = useRef(false);
  useEffect(() => {
    if (posting) { wasPosting.current = true; return; }
    if (!wasPosting.current) return;
    wasPosting.current = false;
    const held = fromCompose.current;
    fromCompose.current = false;
    if (held && problem === null) { const active = document.activeElement; if (active instanceof HTMLElement && active.closest('[data-notes-form="composer"]') !== null) active.blur(); }
  }, [posting, problem]);
  // An empty draft abandoned at rest gives its stamp back, so the chip follows the film again; the tray is a phone thing and closes off one.
  useEffect(() => { if (phone && !composing && composer.body === "" && composer.anchorFrame !== null) store.stamp(assetId, null); }, [phone, composing, composer.body, composer.anchorFrame, store, assetId]);
  useEffect(() => { if (!phone && slot.extras) store.setExtras(assetId, false); }, [phone, slot.extras, store, assetId]);

  // Cancel discards and ends compose: in the sheet its blur does that; in a phone's Full screen the screen's close does (it puts the focus on Add note, as the toggle does).
  const cancel = () => {
    store.discardComposer(assetId); setEditorKey((k) => k + 1);
    if (sheet?.onCancel) { sheet.onCancel(); return; }
    const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body) active.blur();
  };
  const frameStep = (delta: number) => {
    if (!clock) return;
    const target = Math.min(Math.max(0, frameOnScreen(clock.getState()) + delta), Math.max(0, frameCount - 1));
    clock.step(delta);
    // The composer's own frame step moves the stamp of an empty point draft (the hint follows it); once there is text the anchor stays frozen.
    if (composer.body === "" && !pendingFrames) store.stamp(assetId, target);
  };
  const stepDisabled = clock === null || frozen || drawingNow || otherForm !== null;
  const stampFrame = drawn?.drawingFrame ?? composer.anchorFrame ?? liveFrame;
  const hintText = clock === null ? "Loading the film…"
    : otherForm !== null ? `Finish or cancel the open ${otherForm} first.`
    : `${VISIBILITY_LABEL[visibility]} · ${pendingFrames ? anchorText : `paused at ${timecode(stampFrame)} · the note is stamped here`}`;
  const chipText = pendingFrames
    ? marks.in !== null && marks.out !== null ? shortRange(timecode(marks.in), timecode(marks.out)) : anchorText
    : timecode(stampFrame);
  const lineShown = composing || problem !== null || tooLong || otherForm !== null || clock === null;
  const chip = <span data-testid="video-note-anchor" aria-live="off" className={PILL_CHIP}>
    {!pendingFrames && <span className="sr-only">{merged ? "Note with a drawing at " : "Note at "}</span>}
    {pendingFrames && <span className="sr-only">{`Note from ${anchorText}: `}</span>}
    {merged && <PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" />}
    <span aria-hidden={pendingFrames ? true : undefined}>{chipText}</span>
  </span>;
  const plus = <PillPlus testId="video-note-extras" open={trayOpen} controls={trayId} disabled={otherForm !== null || frozen} onToggle={() => { store.setExtras(assetId, !trayOpen); }} />;
  const penSlot = pen !== undefined ? <span data-testid="video-note-pen" className="contents" onClickCapture={() => { store.setExtras(assetId, false); const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body) active.blur(); }}>{pen}</span> : null;

  return <form
    data-testid="video-note-composer"
    data-notes-form="composer"
    data-compose={phone ? (composing ? "true" : "false") : undefined}
    className={cn(phone
      ? STRIP_GRID
      : "@container grid gap-[var(--space-2)] max-[721px]:grid-cols-[minmax(0,1fr)_auto] max-[721px]:items-end", otherForm !== null && "opacity-60")}
    data-size-container="true"
    data-locked={otherForm !== null ? "true" : "false"}
    onSubmit={(event) => { event.preventDefault(); send(); }}
  >
    {!phone && <div className="grid gap-[var(--space-2)]" data-testid="video-note-marks">
      <span data-testid="video-note-anchor" aria-live="off" className={cn(ANCHOR_CHIP, ANCHOR_CHIP_ROW, "justify-self-start")}>{!pendingFrames && <span className="sr-only">{merged ? "Note with a drawing at " : "Note at "}</span>}{merged && <PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" />}{anchorText}</span>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <Button type="button" variant="secondary" data-testid="video-note-set-in" className={SMALL_BUTTON} disabled={clock === null || frozen || drawingNow || otherForm !== null} aria-keyshortcuts="I" onClick={() => { mark("in"); }}>Set in <Kbd className={KBD_HINT}>I</Kbd></Button>
      <Button type="button" variant="secondary" data-testid="video-note-set-out" className={SMALL_BUTTON} disabled={clock === null || frozen || drawingNow || otherForm !== null} aria-keyshortcuts="O" onClick={() => { mark("out"); }}>Set out <Kbd className={KBD_HINT}>O</Kbd></Button>
      {pendingFrames && <Button type="button" variant="text" data-testid="video-note-clear-marks" disabled={frozen || drawingNow} onClick={() => { store.clearMarks(assetId); }}>Clear marks</Button>}
      </div>
    </div>}
    {!phone && drawn && <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      {!merged && <span data-testid="video-note-drawing-chip" className={cn(ANCHOR_CHIP, ANCHOR_CHIP_ROW)}><span className="sr-only">Drawing on </span><PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" />{timecode(drawn.drawingFrame!)}</span>}
      <Button type="button" variant="text" data-testid="video-note-remove-drawing" className={SMALL_BUTTON} disabled={frozen} onClick={() => { store.clearMarkup(assetId); }}>Remove drawing</Button>
    </div>}
    {/* Phone: the line above the pill. A problem takes its place (and shows at rest too), so the strip never grows a row for it. */}
    {phone && lineShown && (problem !== null || tooLong
      ? <div role="alert" data-testid="video-note-problem" className={cn(PHONE_LINE, "flex items-center gap-[var(--space-2)] text-destructive")}>
        <span className="min-w-0 flex-1 line-clamp-2">{tooLong ? `Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.` : problem!.text}</span>
        {!tooLong && problem!.refresh && <Button type="button" variant="text" data-testid="video-note-refresh" className={SMALL_BUTTON} onClick={onRefresh}>Refresh notes</Button>}
      </div>
      // The clamp lives on an inner node: a grid item that clips (line-clamp) may shrink to nothing when the strip runs short, and the hint must render whole (#879 fix).
      : <div className={PHONE_LINE}><p data-testid="video-note-stamp" className="m-0 line-clamp-2 text-foreground-secondary">{hintText}</p></div>)}
    {/* Phone: the + tray (Q1, C1), inline above the pill and inside the strip, so it is always above the keyboard. Mounted for the whole phone layout (the toolbar's portal target stays put). */}
    {phone && <ComposeTray open={trayOpen} id={trayId} testId="video-note-tray" toolbarRef={setTrayToolbar}>
        <ToggleGroup
          variant="outline" size="sm" spacing={0} aria-label="Who can see this note"
          value={[visibility]} disabled={frozen}
          onValueChange={(next) => { const picked = next[0]; if (!frozen && (picked === "internal" || picked === "public")) store.setVisibility(assetId, picked); }}
        >
          <ToggleGroupItem value="internal" data-testid="video-note-visibility-internal">Internal</ToggleGroupItem>
          <ToggleGroupItem value="public" data-testid="video-note-visibility-public">Client-visible</ToggleGroupItem>
        </ToggleGroup>
        <Button type="button" variant="secondary" data-testid="video-note-step-back" aria-label="Back one frame" className="min-h-11 min-w-11" disabled={stepDisabled} onClick={() => { frameStep(-1); }}><StepBack aria-hidden="true" /></Button>
        <Button type="button" variant="secondary" data-testid="video-note-step-forward" aria-label="Forward one frame" className="min-h-11 min-w-11" disabled={stepDisabled} onClick={() => { frameStep(1); }}><StepForward aria-hidden="true" /></Button>
        <Button type="button" variant="secondary" data-testid="video-note-set-in" className={SMALL_BUTTON} disabled={stepDisabled} onClick={() => { mark("in"); }}>Set in</Button>
        <Button type="button" variant="secondary" data-testid="video-note-set-out" className={SMALL_BUTTON} disabled={stepDisabled} onClick={() => { mark("out"); }}>Set out</Button>
        {pendingFrames && <Button type="button" variant="text" data-testid="video-note-clear-marks" className={SMALL_BUTTON} disabled={frozen || drawingNow} onClick={() => { store.clearMarks(assetId); }}>Clear marks</Button>}
        {drawn && !merged && <span data-testid="video-note-drawing-chip" className={PILL_CHIP}><span className="sr-only">Drawing on </span><PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" />{timecode(drawn.drawingFrame!)}</span>}
        {drawn && <Button type="button" variant="text" data-testid="video-note-remove-drawing" className={SMALL_BUTTON} disabled={frozen} onClick={() => { store.clearMarkup(assetId); }}>Remove drawing</Button>}
    </ComposeTray>}
    <label className="sr-only" htmlFor="video-note-body">Add a note</label>
    <div
      ref={restPlaceholder.ref}
      data-testid="video-note-editor"
      className={cn("max-[721px]:col-start-1 max-[721px]:row-start-3 max-[721px]:[&_[contenteditable]]:text-[length:var(--text-base)]", phone && "min-w-0")}
      onKeyDownCapture={(event) => { if (frozen) event.preventDefault(); }}
      // A phone note is stamped when typing begins (D10): focusing the field pauses the film on the frame the note will anchor to and stamps it in the form store, so nothing moves it before the first keystroke.
      onFocusCapture={() => { setFocused(true); if (phone && clock) { clock.pause(); store.stamp(assetId, frameOnScreen(clock.getState())); } }}
      onBlurCapture={(event) => { if (!(event.relatedTarget instanceof Element && event.currentTarget.contains(event.relatedTarget))) setFocused(false); }}
    >
      <VideoNoteEditor key={editorKey} id="video-note-body" projectId={rich.projectId} role={rich.role} value={draftDoc(composer.content, composer.body)} disabled={frozen} placeholder={phone ? restPlaceholder.text : "Add a note at this frame… Use @ to mention a colleague."}
        onChange={(doc) => { if (!frozen) store.setContent(assetId, doc, clock ? frameOnScreen(clock.getState()) : 0); }} onSubmit={send} onUploadingChange={setUploading}
        {...(phone ? { pill: true, pillWrap: composing, toolbarContainer: trayToolbar, inlineStart: <>{plus}{chip}</>, ...(penSlot ? { inlineEnd: penSlot } : {}), contentClassName: composing ? COMPOSE_CLAMP : REST_CLAMP, contentAttributes: SHEET_TEXT } : {})}
      />
    </div>
    {!phone && tooLong && <Notice tone="critical" role="alert">{`Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.`}</Notice>}
    {!phone && problem && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{problem.text}</span>{problem.refresh && <Button type="button" variant="text" data-testid="video-note-refresh" onClick={onRefresh}>Refresh notes</Button>}</Notice>}
    {!phone && <div className="grid gap-[var(--space-1)]">
      <ToggleGroup
        variant="outline" size="sm" spacing={0} aria-label="Who can see this note"
        value={[visibility]} disabled={frozen}
        onValueChange={(next) => { const picked = next[0]; if (!frozen && (picked === "internal" || picked === "public")) store.setVisibility(assetId, picked); }}
      >
        <ToggleGroupItem value="internal" data-testid="video-note-visibility-internal">Internal</ToggleGroupItem>
        <ToggleGroupItem value="public" data-testid="video-note-visibility-public">Client-visible</ToggleGroupItem>
      </ToggleGroup>
      <span data-testid="video-note-visibility-hint" className="text-foreground-secondary [font:var(--type-label)]">{HINT[visibility]}</span>
    </div>}
    {/* Post stays at the left edge whether or not the composer is locked; the lock hint follows it. */}
    {!phone && <div className="flex flex-wrap items-center justify-start gap-[var(--space-2)]">
      <Button type="submit" data-testid="video-note-post" disabled={!canPost}>{label}</Button>
      {otherForm !== null && <span data-testid="video-note-other-form-hint" className="text-foreground-secondary [font:var(--type-label)]">{`Finish or cancel the open ${otherForm} first.`}</span>}
    </div>}
    {!phone && clock === null && <span className="text-foreground-secondary [font:var(--type-label)]">Loading the film…</span>}
    {/* Phone: the round Send (C5), icon-only; its phase is a spinner and its name. A press never takes the focus, so the keyboard stays and nothing jumps before the post. */}
    {phone && <PillSend testId="video-note-post" label={label} disabled={!canPost} pending={frozen} />}
    {phone && composing && <div className="col-span-2 row-start-4 flex justify-end">
      {/* Cancel keeps the field's focus on press like Send: a blur first would drop the keyboard and move the strip under the finger, and the tap would miss (#879 fix). */}
      <Button type="button" variant="text" data-testid="video-note-cancel" className={STRIP_TEXT_BUTTON} disabled={frozen} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={cancel}>Cancel</Button>
    </div>}
  </form>;
}
