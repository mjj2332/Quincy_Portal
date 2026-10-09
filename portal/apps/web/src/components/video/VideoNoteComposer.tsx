import { useCallback, useEffect, useRef, useState } from "react";
import { VIDEO_NOTE_BODY_MAX, type VideoNoteCreateInput, type VideoNoteVisibility } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { useFrameClockSelector, type VideoFrameClock } from "../../lib/video-frame-clock";
import { marksToFrames, type NoteMarks } from "../../lib/video-note-marks";
import { classifyVideoNoteError } from "../../lib/video-notes-data";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { Textarea } from "../reui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { Kbd } from "../reui/kbd";

/** The unsent part of a note: kept per person and Version while the Video tab is open. Marks are not part of it (they are frames of one Version, always cleared). */
export type NoteDraft = { body: string; visibility: VideoNoteVisibility; anchorFrame: number | null };

/** How long Post waits for the browser to show the frame before it gives the draft back. */
export const FRAME_CONFIRM_TIMEOUT_MS = 10_000;

const HINT: Record<VideoNoteVisibility, string> = {
  internal: "Studio only — never shown on the client link.",
  public: "Shown to the client on the review link.",
};
const MONO = "[font:var(--type-mono)] tabular-nums";
const SMALL_BUTTON = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";

const isAbort = (error: unknown) => error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";

/**
 * The composer at the foot of the notes panel (#741 5b). A note is anchored to the in / out marks if there are any, else to the frame
 * that was on screen when typing began (frozen: playback moving on does not move it). Post pauses, waits for that frame to be on screen
 * (10 s at most) and only then sends. Nothing retries by itself: after a network failure the note may or may not have posted, so the draft
 * is kept and the person refreshes. Visibility starts Internal every time the composer is empty and is never sticky; it is immutable once posted.
 */
export function VideoNoteComposer({ clock, frameCount, timecode, marks, active = true, otherForm = null, formToken, onActivate, onPhaseChange, onSent, onMark, onClearMarks, draft, onDraftChange, post, onRefresh, onWriteError }: {
  clock: VideoFrameClock | null;
  frameCount: number;
  timecode: (frame: number) => string;
  /** The marks of the composer: the panel hands over none while another form is the active one. */
  marks: NoteMarks;
  /** Whether the composer is the one active form. When it stops being, a pending frame confirmation is cancelled and the text is kept. */
  active?: boolean;
  /** An edit or reply form is open: Post, Set in and Set out are disabled (nothing else is discarded silently) and a hint says why. Typing stays allowed. */
  otherForm?: "edit" | "reply" | null;
  /** Post and the mark buttons make the composer the active form. */
  onActivate?: () => void;
  /** "confirming" and "posting" freeze the active form's marks (I and O do nothing); "posting" also stops another form opening. */
  onPhaseChange?: (phase: "idle" | "confirming" | "posting", token: number) => void;
  /** The generation of the composer's current opening: phase reports and the marks clear after a post carry it, so a late one is ignored. */
  formToken?: () => number;
  /** The request succeeded (called even if the composer has unmounted since): the host clears the stored draft this text was sent from, unless it has changed. */
  onSent?: (text: string) => void;
  /** Pause, confirm the frame on screen and mark it; the host does the confirming. */
  onMark: (kind: "in" | "out") => void;
  onClearMarks: (token?: number) => void;
  draft: NoteDraft | undefined;
  onDraftChange: (draft: NoteDraft | null) => void;
  post: (input: VideoNoteCreateInput) => Promise<unknown>;
  onRefresh: () => void;
  /** Every failed write, for the host's access handling. */
  onWriteError?: (error: unknown) => void;
}) {
  const [body, setBody] = useState(draft?.body ?? "");
  const [visibility, setVisibility] = useState<VideoNoteVisibility>(draft?.visibility ?? "internal");
  const [anchorFrame, setAnchorFrame] = useState<number | null>(draft?.anchorFrame ?? null);
  const [phase, setPhase] = useState<"idle" | "confirming" | "posting">("idle");
  const [problem, setProblem] = useState<{ text: string; refresh?: boolean; retry?: boolean } | null>(null);
  const attempt = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const formRef = useRef<HTMLFormElement>(null);
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  const currentFrame = () => { const state = clock?.getState(); return state ? (state.targetFrame ?? state.frame) : 0; };

  // A pending post belongs to this clock: a Version change or an unmount cancels it so a late confirmation can never post.
  useEffect(() => () => { attempt.current += 1; }, [clock]);
  // Rule B: while a frame is being confirmed or a request is out, the host freezes I and O and (once sent) the other forms.
  const onPhaseChangeRef = useRef(onPhaseChange);
  onPhaseChangeRef.current = onPhaseChange;
  const tokenRef = useRef<number | null>(null);
  useEffect(() => { if (tokenRef.current !== null) onPhaseChangeRef.current?.(phase, tokenRef.current); }, [phase]);
  useEffect(() => () => { if (tokenRef.current !== null) onPhaseChangeRef.current?.("idle", tokenRef.current); }, []);
  /** Back to idle with the text kept. Only a frame confirmation is cancelled; a request already sent is never touched. */
  const cancelConfirmation = useCallback(() => {
    if (phaseRef.current !== "confirming") return;
    attempt.current += 1;
    setPhase("idle");
  }, []);
  // The viewer's Escape sends this event (it cannot reach into the composer's state).
  useEffect(() => {
    const form = formRef.current;
    form?.addEventListener("quincy-notes-escape", cancelConfirmation);
    return () => { form?.removeEventListener("quincy-notes-escape", cancelConfirmation); };
  }, [cancelConfirmation]);
  useEffect(() => { if (!active) cancelConfirmation(); }, [active, cancelConfirmation]);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => { onDraftChangeRef.current(body === "" ? null : { body, visibility, anchorFrame }); }, [body, visibility, anchorFrame]);

  const pendingFrames = marksToFrames(marks, frameCount);
  const tooLong = body.length > VIDEO_NOTE_BODY_MAX;
  const canPost = clock !== null && phase === "idle" && otherForm === null && body.trim() !== "" && !tooLong;
  const frozen = phase !== "idle";

  function changeBody(next: string) {
    if (phaseRef.current !== "idle") return; // read-only from Post until the request settles
    setBody(next);
    // Composing starts at the first character: the frame on screen then is the anchor, until the text is gone again.
    if (next === "") { setAnchorFrame(null); setVisibility("internal"); }
    else if (body === "" && anchorFrame === null) setAnchorFrame(currentFrame());
  }

  function fail(error: unknown) {
    onWriteError?.(error);
    const classified = classifyVideoNoteError(error);
    switch (classified.kind) {
      case "network": setProblem({ text: "Couldn't reach the server. Your note may or may not have posted — refresh the notes to check, then post again if it isn't there.", refresh: true }); break;
      case "range": setProblem({ text: `That frame is outside this film${classified.frameCount ? ` (the last frame is ${classified.frameCount - 1})` : ""}.` }); break;
      case "archived": setProblem({ text: "This Project was archived, so the note was not posted. Your draft is kept." }); break;
      case "access": setProblem({ text: error instanceof Error && error.message ? error.message : "You no longer have access to this Project." }); break;
      default: setProblem({ text: error instanceof ApiError || error instanceof Error ? error.message || "The note could not be posted." : "The note could not be posted." });
    }
  }

  async function submit() {
    if (!canPost || !clock) return;
    const mine = (attempt.current += 1);
    const text = body.trim();
    setProblem(null);
    onActivate?.();
    tokenRef.current = formToken?.() ?? 0;
    const token = tokenRef.current;
    const sent = onSent;
    // Marked or not, Post pauses and confirms the frame first: a range on its start, a point on the frame composing began at.
    let frames = marksToFrames(marks, frameCount);
    {
      const anchor = frames ? frames.startFrame : Math.min(Math.max(0, anchorFrame ?? currentFrame()), Math.max(0, frameCount - 1));
      setPhase("confirming");
      clock.seekToFrame(anchor);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { resolve("timeout"); }, FRAME_CONFIRM_TIMEOUT_MS); });
      try {
        const confirmed = await Promise.race([clock.awaitConfirmedFrame(), timedOut]);
        if (mine !== attempt.current) return;
        if (confirmed === "timeout") { setPhase("idle"); setProblem({ text: "The frame took too long to show. Your draft is kept.", retry: true }); return; }
        // The frame on screen must be the one the note was composed at: a scrub or a step that landed first moved it.
        if (confirmed !== anchor) { setPhase("idle"); setProblem({ text: "Frame moved — Post again" }); return; }
        frames ??= { startFrame: anchor, endFrame: null };
      } catch (error) {
        if (mine !== attempt.current) return;
        setPhase("idle");
        if (!isAbort(error)) setProblem({ text: "The frame could not be confirmed. Your draft is kept.", retry: true });
        return;
      } finally { clearTimeout(timer); }
    }
    setPhase("posting");
    try {
      await post({ startFrame: frames.startFrame, ...(frames.endFrame !== null ? { endFrame: frames.endFrame } : {}), visibility, body: text });
      sent?.(text); // independent of this component's lifetime
      if (mine !== attempt.current) return;
      setBody(""); setAnchorFrame(null); setVisibility("internal"); setPhase("idle"); onClearMarks(token);
    } catch (error) {
      if (mine !== attempt.current) return;
      setPhase("idle");
      fail(error);
    }
  }

  const anchorText = pendingFrames
    ? marks.in !== null && marks.out !== null ? `In ${timecode(marks.in)} → Out ${timecode(marks.out)}` : marks.in !== null ? `In ${timecode(marks.in)}` : `Out ${timecode(marks.out!)}`
    : `Note at ${timecode(anchorFrame ?? liveFrame)}`;
  const label = phase === "confirming" ? "Confirming…" : phase === "posting" ? "Posting…" : problem?.retry ? "Retry" : "Post";

  return <form
    ref={formRef}
    data-testid="video-note-composer"
    data-notes-form="composer"
    data-phase={phase}
    data-dirty={body !== "" ? "true" : "false"}
    className="grid gap-[var(--space-2)]"
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
  >
    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <span data-testid="video-note-anchor" aria-live="off" className={`text-foreground ${MONO}`}>{anchorText}</span>
      <Button type="button" variant="secondary" data-testid="video-note-set-in" className={SMALL_BUTTON} disabled={clock === null || frozen || otherForm !== null} onClick={() => { onActivate?.(); onMark("in"); }}>Set in <Kbd>I</Kbd></Button>
      <Button type="button" variant="secondary" data-testid="video-note-set-out" className={SMALL_BUTTON} disabled={clock === null || frozen || otherForm !== null} onClick={() => { onActivate?.(); onMark("out"); }}>Set out <Kbd>O</Kbd></Button>
      {pendingFrames && <Button type="button" variant="text" data-testid="video-note-clear-marks" disabled={frozen} onClick={() => { onClearMarks(); }}>Clear marks</Button>}
    </div>
    <label className="sr-only" htmlFor="video-note-body">Add a note</label>
    <Textarea
      id="video-note-body"
      value={body}
      placeholder="Add a note at this frame…"
      readOnly={frozen}
      onChange={(event) => { changeBody(event.target.value); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
    />
    {tooLong && <Notice tone="critical" role="alert">{`Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.`}</Notice>}
    {problem && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{problem.text}</span>{problem.refresh && <Button type="button" variant="text" data-testid="video-note-refresh" onClick={onRefresh}>Refresh notes</Button>}</Notice>}
    <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
      <div className="grid gap-[var(--space-1)]">
        <ToggleGroup
          variant="outline" size="sm" spacing={0} aria-label="Who can see this note"
          value={[visibility]} disabled={frozen}
          onValueChange={(next) => { const picked = next[0]; if (phaseRef.current === "idle" && (picked === "internal" || picked === "public")) setVisibility(picked); }}
        >
          <ToggleGroupItem value="internal" data-testid="video-note-visibility-internal">Internal</ToggleGroupItem>
          <ToggleGroupItem value="public" data-testid="video-note-visibility-public">Client-visible</ToggleGroupItem>
        </ToggleGroup>
        <span data-testid="video-note-visibility-hint" className="text-foreground-secondary [font:var(--type-label)]">{HINT[visibility]}</span>
      </div>
      <Button type="submit" data-testid="video-note-post" disabled={!canPost}>{label}</Button>
    </div>
    {otherForm !== null && <span data-testid="video-note-other-form-hint" className="text-foreground-secondary [font:var(--type-label)]">{`Finish or cancel the open ${otherForm} first.`}</span>}
    {clock === null && <span className="text-foreground-secondary [font:var(--type-label)]">Loading the film…</span>}
  </form>;
}
