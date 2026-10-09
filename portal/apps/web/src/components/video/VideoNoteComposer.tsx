import { useSyncExternalStore } from "react";
import { VIDEO_NOTE_BODY_MAX, type VideoNoteCreateInput, type VideoNoteVisibility } from "@quincy/shared";
import { useFrameClockSelector, type VideoFrameClock } from "../../lib/video-frame-clock";
import { effectiveMarks, frameOnScreen, type NoteFormStore } from "../../lib/video-note-form-store";
import { EMPTY_MARKS, marksToFrames } from "../../lib/video-note-marks";
import { cn } from "../../lib/utils";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { Textarea } from "../reui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { Kbd } from "../reui/kbd";

const HINT: Record<VideoNoteVisibility, string> = {
  internal: "Studio only — never shown on the client link.",
  public: "Shown to the client on the review link.",
};
const MONO = "[font:var(--type-mono)] tabular-nums";
// On a short window the list needs the height: two rows until the field is focused or holds text (the 800px query is the window's height).
const SHORT_TEXTAREA = "[@media(max-height:800px)]:min-h-16 [@media(max-height:800px)]:focus:min-h-24 [@media(max-height:800px)]:[&:not(:placeholder-shown)]:min-h-24";
/** The anchor chip, shared with the edit form. */
export const ANCHOR_CHIP = "rounded-md bg-muted px-[var(--space-2)] py-[var(--space-1)] text-foreground [font:var(--type-mono)] tabular-nums";
/** The key hint is visual only at panel widths from 280px (the form is a size container); below that it stays for assistive tech but takes no room. */
const KBD_HINT = "@max-[280px]:sr-only";
const SMALL_BUTTON = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * The composer at the foot of the notes panel (#741 5b). A note is anchored to the in / out marks if there are any, else to the frame
 * that was on screen when typing began (frozen: playback moving on does not move it). Post pauses, waits for that frame to be on screen
 * (10 s at most) and only then sends. Nothing retries by itself: after a network failure the note may or may not have posted, so the draft
 * is kept and the person refreshes. Visibility starts Internal every time the composer is empty and is never sticky; it is immutable once posted.
 * The draft, the marks and the request all live in the Video tab's form store, so this component only renders them and sends commands.
 */
export function VideoNoteComposer({ store, assetId, clock, frameCount, timecode, post, onRefresh }: {
  store: NoteFormStore;
  assetId: string;
  clock: VideoFrameClock | null;
  frameCount: number;
  timecode: (frame: number) => string;
  post: (input: VideoNoteCreateInput) => Promise<unknown>;
  onRefresh: () => void;
}) {
  const slot = useSyncExternalStore(store.subscribe, () => store.slot(assetId));
  const { composer, open, op } = slot;
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  // While an edit or reply is open the marks are its (the composer takes none, and Post, Set in and Set out are disabled with a hint).
  const marks = open ? EMPTY_MARKS : effectiveMarks(slot.marks, clock).value;
  const phase = op?.form === "composer" ? op.phase : "idle";
  const otherForm = open?.kind ?? null;
  const problem = composer.problem;
  const visibility: VideoNoteVisibility = composer.visibility;

  const pendingFrames = marksToFrames(marks, frameCount);
  const tooLong = composer.body.length > VIDEO_NOTE_BODY_MAX;
  const canPost = clock !== null && op === null && otherForm === null && composer.body.trim() !== "" && !tooLong;
  const frozen = phase !== "idle";
  const submit = () => { if (canPost && clock) void store.post(assetId, { clock, frameCount, send: post }); };
  const mark = (kind: "in" | "out") => { if (clock) store.mark(assetId, kind, frameOnScreen(clock.getState()), clock); };

  // The anchor is only the timecode (or the in -> out pair); "Note at" stays for screen readers.
  const anchorText = pendingFrames
    ? marks.in !== null && marks.out !== null ? `In ${timecode(marks.in)} → Out ${timecode(marks.out)}` : marks.in !== null ? `In ${timecode(marks.in)}` : `Out ${timecode(marks.out!)}`
    : timecode(composer.anchorFrame ?? liveFrame);
  const label = phase === "confirming" ? "Confirming…" : phase === "posting" ? "Posting…" : problem?.retry ? "Retry" : "Post";

  return <form
    data-testid="video-note-composer"
    data-notes-form="composer"
    className={cn("@container grid gap-[var(--space-2)]", otherForm !== null && "opacity-60")}
    data-size-container="true"
    data-locked={otherForm !== null ? "true" : "false"}
    onSubmit={(event) => { event.preventDefault(); submit(); }}
  >
    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <span data-testid="video-note-anchor" aria-live="off" className={ANCHOR_CHIP}>{!pendingFrames && <span className="sr-only">Note at </span>}{anchorText}</span>
      <Button type="button" variant="secondary" data-testid="video-note-set-in" className={SMALL_BUTTON} disabled={clock === null || frozen || otherForm !== null} aria-keyshortcuts="I" onClick={() => { mark("in"); }}>Set in <Kbd className={KBD_HINT}>I</Kbd></Button>
      <Button type="button" variant="secondary" data-testid="video-note-set-out" className={SMALL_BUTTON} disabled={clock === null || frozen || otherForm !== null} aria-keyshortcuts="O" onClick={() => { mark("out"); }}>Set out <Kbd className={KBD_HINT}>O</Kbd></Button>
      {pendingFrames && <Button type="button" variant="text" data-testid="video-note-clear-marks" disabled={frozen} onClick={() => { store.clearMarks(assetId); }}>Clear marks</Button>}
    </div>
    <label className="sr-only" htmlFor="video-note-body">Add a note</label>
    <Textarea
      id="video-note-body"
      value={composer.body}
      placeholder="Add a note at this frame…"
      readOnly={frozen}
      className={SHORT_TEXTAREA}
      onChange={(event) => { if (!frozen) store.setBody(assetId, event.target.value, clock ? frameOnScreen(clock.getState()) : 0); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
    />
    {tooLong && <Notice tone="critical" role="alert">{`Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.`}</Notice>}
    {problem && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{problem.text}</span>{problem.refresh && <Button type="button" variant="text" data-testid="video-note-refresh" onClick={onRefresh}>Refresh notes</Button>}</Notice>}
    <div className="grid gap-[var(--space-1)]">
      <ToggleGroup
        variant="outline" size="sm" spacing={0} aria-label="Who can see this note"
        value={[visibility]} disabled={frozen}
        onValueChange={(next) => { const picked = next[0]; if (!frozen && (picked === "internal" || picked === "public")) store.setVisibility(assetId, picked); }}
      >
        <ToggleGroupItem value="internal" data-testid="video-note-visibility-internal">Internal</ToggleGroupItem>
        <ToggleGroupItem value="public" data-testid="video-note-visibility-public">Client-visible</ToggleGroupItem>
      </ToggleGroup>
      <span data-testid="video-note-visibility-hint" className="text-foreground-secondary [font:var(--type-label)]">{HINT[visibility]}</span>
    </div>
    {/* Post stays at the left edge whether or not the composer is locked; the lock hint follows it. */}
    <div className="flex flex-wrap items-center justify-start gap-[var(--space-2)]">
      <Button type="submit" data-testid="video-note-post" disabled={!canPost}>{label}</Button>
      {otherForm !== null && <span data-testid="video-note-other-form-hint" className="text-foreground-secondary [font:var(--type-label)]">{`Finish or cancel the open ${otherForm} first.`}</span>}
    </div>
    {clock === null && <span className="text-foreground-secondary [font:var(--type-label)]">Loading the film…</span>}
  </form>;
}
