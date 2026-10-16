import { useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PencilIcon, StepBack, StepForward } from "lucide-react";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { useFrameClockSelector, type VideoFrameClock } from "../lib/video-frame-clock";
import { cn } from "../lib/utils";
import { Button } from "../components/quincy/Button";
import { Button as ReuiButton } from "../components/reui/button";
import { InputGroup, InputGroupAddon } from "../components/reui/input-group";
import { SheetModeContext } from "../components/quincy/ReviewSheet";
import { PILL_ICON } from "../components/quincy/VideoPlayer";
import { SELECTED_HAIRLINE_PRESSED } from "../components/quincy/markup-toolbar";
import { COMPOSE_CLAMP, ComposeTray, PHONE_LINE, PILL_CHIP, PILL_SHELL, PILL_SHELL_TEXT, PillPlus, PillSend, REST_CLAMP, SHEET_TEXT, STRIP_GRID, STRIP_TEXT_BUTTON, keepFocus, shortRange, useRestPlaceholder } from "../components/quincy/compose-strip";
import { GuestNoteField } from "./GuestNoteField";
import type { GuestStrip } from "./use-guest-compose";

/** A text control in the tray, as the staff tray draws its Set in / Set out: 44px tall on a phone. */
const SMALL_BUTTON = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";
const STRIP = '[data-testid="guest-compose-strip"]';
const EDITABLE = 'textarea, [contenteditable]:not([contenteditable="false"])';
const PILL_ADDON_START = "cursor-default gap-[var(--space-1)] pb-[calc(var(--space-1)*1.5)] pl-[var(--space-1)] has-[>button]:ml-0";
const PILL_ADDON_END = "cursor-default pb-[calc(var(--space-1)*1.5)] pr-[var(--space-1)]";

/**
 * The guest's note composer on a phone (#879 PR 2, the prototype's P2 / P6 / P7 as guest): the staff phone strip, built from the same Quincy pieces (`quincy/compose-strip.tsx`),
 * on the guest's own draft (`useGuestCompose`'s `strip`), since the staff composer is bound to the staff form store and `lib/api` (`guest-boundary.guard.test.ts`).
 *
 * - At rest (browse, draw) the pill: +, the timecode chip, the field and the pen in one row, with the round Send beside it. In compose mode (the sheet's mode alone) a hint line above
 *   it, the + tray (frame step, Mark in / out, the drawing, the formatting toolbar) and Cancel under it. The field is mounted at rest for a verified guest, so the first tap raises
 *   the keyboard; while its chunk loads, and for a guest who has not verified, a shell of the same size stands in (a tap on the unverified shell asks for verification).
 * - Focus stamps the frame on screen; a draft with text keeps its anchor; an untouched one is given back at rest. An open tray and a post that is out hold compose mode. A draft
 *   that closes (posted, cancelled, another Version) blurs the field, so the sheet returns to browse with the note listed.
 */
export function GuestNoteComposer({ strip, clock, timecode, media, verified, onShellPress }: {
  strip: GuestStrip;
  clock: VideoFrameClock | null;
  timecode: (frame: number) => string;
  media: EditorMediaTransport;
  /** A verified guest gets the field; one who is not gets the shell, which asks for verification. */
  verified: boolean;
  onShellPress: () => void;
}) {
  const sheet = useContext(SheetModeContext);
  const mode = sheet?.mode ?? "browse";
  const composing = mode === "compose";
  const trayId = useId();
  const fieldId = useId();
  const [trayToolbar, setTrayToolbar] = useState<HTMLDivElement | null>(null);
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  // By the strip's mark, as the staff strip finds its form (`closest`), not by node identity.
  const blurInStrip = () => { const active = document.activeElement; if (active instanceof HTMLElement && active.closest(STRIP) !== null) active.blur(); };

  // A post sent from the strip holds compose mode until it settles (the strip shows its phase), as the staff strip does (C7).
  const fromCompose = useRef(false);
  useEffect(() => { if (!strip.pending) fromCompose.current = false; }, [strip.pending]);
  const postHold = strip.pending && fromCompose.current;
  const setHold = sheet?.setHold;
  useEffect(() => { setHold?.("tray", strip.tray); }, [setHold, strip.tray]);
  useEffect(() => { setHold?.("post", postHold); }, [setHold, postHold]);
  useEffect(() => () => { setHold?.("tray", false); setHold?.("post", false); }, [setHold]);
  // A draft that closes (a post landed, an unchanged edit, another Version) gives the focus up, so compose mode ends the ordinary way.
  const wasOpen = useRef(strip.open);
  useEffect(() => { if (wasOpen.current && !strip.open) blurInStrip(); wasOpen.current = strip.open; });
  // An untouched new draft is given back at rest: the chip follows the film again and the range button asks for a note first.
  const { releaseIfPristine } = strip;
  useEffect(() => { if (mode === "browse") releaseIfPristine(); });
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

  // The pill's placeholder at rest ends at a word (#879 PR 3a); compose mode shows it whole. The field's host is also the compose hook's (`strip.fieldHost`).
  const restPlaceholder = useRestPlaceholder(strip.penDown ? "Add a note with this drawing…" : "Add a note…", !composing);
  const { fieldHost } = strip;
  const restRef = restPlaceholder.ref;
  const fieldRef = useCallback((element: HTMLDivElement | null) => { fieldHost(element); restRef(element); }, [fieldHost, restRef]);

  const send = () => { fromCompose.current = composing; strip.send(); };
  const cancel = () => { blurInStrip(); strip.cancel(); };

  const { frames, ranged } = strip;
  const from = frames ? timecode(frames.startFrame) : "";
  const to = ranged && frames?.endFrame != null ? timecode(frames.endFrame - 1) : "";
  const point = strip.open && frames ? frames.startFrame : liveFrame;
  const merged = strip.strokes > 0 && !ranged && frames !== null && strip.drawFrame === frames.startFrame;
  const hint = !strip.clockReady ? "Loading the film…"
    : strip.editing ? (strip.lockHint ?? `Editing your note · ${ranged ? `from ${from} to ${to}` : `at ${timecode(point)}`}`)
    : strip.open && frames === null ? "No frame marked · Mark in from the + options"
    : ranged ? `From ${from} to ${to}`
    : `Paused at ${timecode(point)} · the note is stamped here`;
  const lineShown = composing || strip.problem !== null || (strip.open && strip.editing) || !strip.clockReady || strip.latest !== null;

  const chip = <span data-testid="guest-composer-anchor" aria-live="off" className={PILL_CHIP}>
    <span className="sr-only">{ranged ? `Note from ${from} to ${to}: ` : merged ? "Note with a drawing at " : "Note at "}</span>
    {merged && <PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" />}
    <span aria-hidden={ranged ? true : undefined}>{ranged ? shortRange(from, to) : timecode(point)}</span>
  </span>;
  const plus = (disabled: boolean) => <PillPlus testId="guest-composer-extras" open={strip.tray} controls={trayId} disabled={disabled} onToggle={() => { strip.setTray(!strip.tray); }} />;
  const pen = (disabled: boolean): ReactNode => (strip.canDraw
    ? <ReuiButton
      type="button" variant="ghost" size="icon" data-testid="guest-composer-draw" aria-label={strip.drawLabel} aria-pressed={strip.penDown} disabled={disabled}
      className={cn("aria-pressed:bg-secondary", SELECTED_HAIRLINE_PRESSED, PILL_ICON)} onClick={strip.pen}
    ><PencilIcon aria-hidden="true" /></ReuiButton>
    : undefined);
  const shell = (loading: boolean) => <PillShell start={<>{plus(true)}{chip}</>} end={pen(true)} loading={loading} {...(loading ? {} : { onPress: onShellPress })} />;

  const stepDisabled = !strip.clockReady || strip.pending || strip.penDown;
  const markDisabled = stepDisabled || strip.marksLocked;
  const sendLabel = strip.editing ? (strip.pending ? "Saving…" : "Save") : (strip.pending ? "Posting…" : "Post note");

  return <form
    data-testid="guest-compose-strip" data-open={strip.open ? "true" : "false"} data-compose={composing ? "true" : "false"}
    aria-label={strip.editing ? "Edit note" : "New note"} noValidate className={STRIP_GRID}
    onSubmit={(event) => { event.preventDefault(); send(); }}
  >
    {/* The line above the pill. A problem takes its place (and shows at rest too); after an edit conflict the latest saved text follows it, whole, in its own scroll. */}
    {lineShown && <div className={cn(PHONE_LINE, "grid gap-[var(--space-1)]")}>
      {strip.problem !== null
        ? <p role="alert" data-testid="guest-composer-problem" className="m-0 max-h-[var(--space-9)] overflow-y-auto text-destructive-wash-foreground">{strip.problem}</p>
        : <p data-testid="guest-composer-stamp" className="m-0 line-clamp-2 text-foreground-secondary">{hint}</p>}
      {strip.latest !== null && <p data-testid="guest-composer-latest" className="m-0 max-h-[var(--space-9)] overflow-y-auto whitespace-pre-wrap text-foreground-secondary [overflow-wrap:anywhere]">{`Latest saved version: ${strip.latest}`}</p>}
    </div>}
    {/* The + tray (C1), inline above the pill, so it is always above the keyboard. Mounted for the whole phone layout: the toolbar's portal target stays put. */}
    <ComposeTray open={strip.tray} id={trayId} testId="guest-composer-tray" toolbarRef={setTrayToolbar}>
      <Button type="button" variant="secondary" data-testid="guest-composer-step-back" aria-label="Back one frame" className="min-h-11 min-w-11" disabled={stepDisabled} onClick={() => { strip.step(-1); }}><StepBack aria-hidden="true" /></Button>
      <Button type="button" variant="secondary" data-testid="guest-composer-step-forward" aria-label="Forward one frame" className="min-h-11 min-w-11" disabled={stepDisabled} onClick={() => { strip.step(1); }}><StepForward aria-hidden="true" /></Button>
      <Button type="button" variant="secondary" data-testid="guest-composer-mark-in" className={SMALL_BUTTON} disabled={markDisabled} onClick={() => { strip.mark("in"); }}>Mark in</Button>
      <Button type="button" variant="secondary" data-testid="guest-composer-mark-out" className={SMALL_BUTTON} disabled={markDisabled} onClick={() => { strip.mark("out"); }}>Mark out</Button>
      {strip.marks.out !== null && <Button type="button" variant="text" data-testid="guest-composer-clear-marks" className={SMALL_BUTTON} disabled={markDisabled} onClick={strip.clearMarks}>Clear marks</Button>}
      {strip.strokes > 0 && !merged && strip.drawFrame !== null && <span data-testid="guest-composer-drawing" className={PILL_CHIP}><span className="sr-only">Drawing on </span><PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" />{timecode(strip.drawFrame)}</span>}
      {(strip.keptDrawing || strip.drawingRemoved) && <span data-testid="guest-composer-drawing" className="text-foreground-secondary [font:var(--type-label)]">{strip.keptDrawing ? "This note has a drawing" : "The drawing will be removed when you save"}</span>}
      {strip.canDraw && (strip.strokes > 0 || strip.keptDrawing) && <Button type="button" variant="text" data-testid="guest-composer-remove-drawing" className={SMALL_BUTTON} disabled={strip.pending || strip.penDown} onClick={strip.removeDrawing}>Remove drawing</Button>}
    </ComposeTray>
    <div
      ref={fieldRef} data-testid="guest-composer-field" className="col-start-1 row-start-3 min-w-0 [&_[contenteditable]]:text-[length:var(--text-base)]"
      // A phone note is stamped when typing begins (D10): focusing the field pauses the film and stamps the frame on screen, so nothing moves it before the first keystroke.
      onFocusCapture={(event) => { if (event.target instanceof Element && event.target.matches(EDITABLE)) strip.focusStamp(); }}
    >
      {verified
        ? <GuestNoteField
          key={strip.editorKey} testId="guest-composer-body" id={fieldId} label="Your note" placeholder={restPlaceholder.text}
          media={media} value={strip.doc} disabled={strip.pending} onChange={strip.setDoc} onUploadingChange={strip.setUploading} onSubmit={send}
          pill pillWrap={composing} toolbarContainer={trayToolbar} inlineStart={<>{plus(strip.pending || strip.penDown)}{chip}</>} inlineEnd={pen(strip.penDisabled)}
          contentClassName={composing ? COMPOSE_CLAMP : REST_CLAMP} contentAttributes={SHEET_TEXT} fallback={shell(true)}
        />
        : shell(false)}
    </div>
    <PillSend testId="guest-composer-post" label={sendLabel} disabled={strip.pending || strip.penDown || strip.uploading || strip.empty || !strip.clockReady} pending={strip.pending} />
    {composing && <div className="col-span-2 row-start-4 flex justify-end">
      {/* Cancel keeps the field's focus on press like Send: a blur first would drop the keyboard and move the strip under the finger, and the tap would miss. */}
      <Button type="button" variant="text" data-testid="guest-composer-cancel" className={STRIP_TEXT_BUTTON} disabled={strip.pending} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={cancel}>Cancel</Button>
    </div>}
  </form>;
}

/**
 * The pill without its editor (#879 PR 2): the same input-group pill, chip and pen at the same size, standing in while the editor's chunk loads (busy), and for a guest who has not
 * verified, where the field's place is one button that asks for verification.
 */
function PillShell({ start, end, loading, onPress }: { start: ReactNode; end: ReactNode; loading: boolean; onPress?: () => void }) {
  return <InputGroup variant="pill" data-testid="guest-compose-shell" aria-busy={loading || undefined} className={PILL_SHELL}>
    <InputGroupAddon align="inline-start" className={PILL_ADDON_START}>{start}</InputGroupAddon>
    <div className="relative flex min-w-0 flex-1 py-[var(--space-2)]">
      <span aria-hidden="true" className={PILL_SHELL_TEXT}>Add a note…</span>
      {loading && <span className="sr-only">Loading the note field…</span>}
      {onPress && <ReuiButton type="button" variant="ghost" data-testid="guest-compose-shell-open" aria-label="Add a note" className="absolute inset-0 h-auto min-h-0 max-[721px]:min-h-0 hover:bg-transparent" onClick={onPress} />}
    </div>
    {end !== undefined && <InputGroupAddon align="inline-end" className={PILL_ADDON_END}>{end}</InputGroupAddon>}
  </InputGroup>;
}
