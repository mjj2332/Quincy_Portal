import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { Maximize, Pause, Play, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { framesToTimecode, rationalToNumber, type VideoVersionDto } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { useVideoFrameClock } from "../../lib/video-frame-clock";
import { playerKeyAction, type PlayerKeyAction } from "../../lib/video-player-keys";
import { nextShuttleRate } from "../../lib/video-shuttle";
import { usePictureBox } from "../../lib/use-picture-box";
import { Button } from "../reui/button";
import { Kbd, KbdGroup } from "../reui/kbd";
import { Slider } from "../reui/slider";
import { Toggle } from "../reui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";
import { Notice } from "./Notice";

/** What the player reads of a Version: where it streams, how it is timed, and how its timecode is labelled. */
export type VideoPlayerVersion = Pick<VideoVersionDto, "streamUrl" | "fps" | "frameCount" | "width" | "height" | "tcNominalFps" | "tcDropFrame" | "startTimecodeFrames" | "hasAudio">;

/** For a host that owns the keyboard scope (the review dialog): hands it the player's shortcut handler. True when the key was the player's. */
export type VideoPlayerControl = { handleKeyDown(event: KeyboardEvent | ReactKeyboardEvent): boolean };

const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";
const MONO = "[font:var(--type-mono)] tabular-nums";
// The Kbd primitive paints bg-muted, which the inverse surface does not remap; these chips take the Lightbox's SHORTCUT_KBD skin instead.
const LEGEND_KBD = "rounded-[var(--radius-xs)] border border-solid border-[length:var(--border-width-hair)] border-border bg-secondary px-[var(--space-1)] text-foreground [font:var(--weight-regular)_var(--text-2xs)/1.4_var(--font-mono)]";
// What the timecode chip needs to show its frame part: mono glyph advance plus padding, border and the offset from the picture's edge.
const CHIP_GLYPH_PX = 9;
const CHIP_CHROME_PX = 40;
const LEGEND = "flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-foreground-secondary [font:var(--type-label)] pointer-coarse:hidden max-[721px]:hidden";

function IconTip({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent>{label}{keys && <Kbd>{keys}</Kbd>}</TooltipContent>
  </Tooltip>;
}

/**
 * The frame-accurate review player (#741 4d-ii), Quincy-owned and reusable by the guest page (12b): the stage (a `<video>` with no
 * native controls, no download, no picture-in-picture), the timecode chip drawn inside the picture (not the letterbox band), the
 * scrubber, the transport and the shortcuts. Everything frame-related goes through one `useVideoFrameClock`; the SMPTE label always
 * comes from the Version's stored start timecode and drop-frame flag, never re-derived from the frame rate.
 *
 * Key it by Version (`key={assetId}`): a new Version is a new element, a new clock, paused at frame 0. It assumes an inverse
 * surface (`data-surface="inverse"`) around it, like the Lightbox. `keyboard="self"` listens on the player; `"host"` leaves the
 * scope to the caller, who forwards events to `controlRef.handleKeyDown`.
 */
export function VideoPlayer({ version, title, controlRef, keyboard = "self", className }: {
  version: VideoPlayerVersion;
  title: string;
  controlRef?: Ref<VideoPlayerControl>;
  keyboard?: "self" | "host";
  className?: string;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [muted, setMutedState] = useState(false);
  const playerRef = useRef<HTMLElement | null>(null);
  const clock = useVideoFrameClock(video, version);
  const box = usePictureBox(video, { width: version.width, height: version.height });

  const base = useMemo(() => ({ nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }), [version.tcNominalFps, version.tcDropFrame]);
  const start = version.startTimecodeFrames ?? 0;
  const timecode = useCallback((frame: number) => framesToTimecode(frame, base, start), [base, start]);
  const lastFrame = Math.max(0, version.frameCount - 1);
  const shownFrame = clock.targetFrame ?? clock.frame;
  const fullscreenAvailable = typeof document !== "undefined" && document.fullscreenEnabled === true;

  const chipTimecode = timecode(clock.frame);
  const chipFull = `${chipTimecode} · frame ${clock.frame}`;
  const chip = box && box.width >= chipFull.length * CHIP_GLYPH_PX + CHIP_CHROME_PX ? chipFull : chipTimecode;

  const apply = useCallback((action: PlayerKeyAction) => {
    switch (action.type) {
      case "toggle": if (nextShuttleRate(clock.rate, "toggle") === 0) clock.pause(); else clock.play(); break;
      case "forward": {
        const next = nextShuttleRate(clock.rate, "forward");
        if (next === 0) clock.pause(); else if (next > 0) clock.setRate(next); else clock.reverse(-next);
        break;
      }
      case "reverse": {
        const next = nextShuttleRate(clock.rate, "reverse");
        if (next === 0) clock.pause(); else if (next < 0) clock.reverse(-next); else clock.setRate(next);
        break;
      }
      case "step": clock.step(action.delta); break;
      case "home": clock.seekToFrame(0); break;
      case "end": clock.seekToFrame(lastFrame); break;
    }
  }, [clock, lastFrame]);

  /** K is down: J / L step a frame (the NLE chord). Cleared by its keyup anywhere, and by losing focus. */
  const kHeld = useRef(false);
  useEffect(() => {
    const release = () => { kHeld.current = false; };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === "k" || event.key === "K") release(); };
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => { document.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", release); };
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent | ReactKeyboardEvent): boolean => {
    const native = "nativeEvent" in event ? event.nativeEvent : event;
    const action = playerKeyAction(native, { k: kHeld.current });
    if (!action) return false;
    if (native.key === "k" || native.key === "K") kHeld.current = true;
    event.preventDefault();
    apply(action);
    return true;
  }, [apply]);
  useImperativeHandle(controlRef, () => ({ handleKeyDown }), [handleKeyDown]);

  const toggleMuted = (next: boolean) => { setMutedState(next); clock.setMuted(next); };
  const playLabel = clock.playing ? "Pause" : "Play";

  return <section
    ref={playerRef}
    aria-label="Player"
    data-testid="video-player"
    tabIndex={-1}
    onKeyDown={keyboard === "self" ? (event) => { handleKeyDown(event); } : undefined}
    className={cn("flex min-h-0 min-w-0 flex-col gap-[var(--space-3)] focus-visible:!outline-none [&:fullscreen]:bg-background [&:fullscreen]:p-[var(--space-4)]", className)}
  >
    <div
      data-testid="video-stage"
      style={{ "--stage-ratio": `${version.width}/${version.height}` } as React.CSSProperties}
      className="relative min-h-0 w-full flex-1 overflow-hidden bg-invert text-invert-foreground max-[721px]:mx-auto max-[721px]:max-h-[55dvh] max-[721px]:flex-none max-[721px]:[aspect-ratio:var(--stage-ratio)]"
    >
      <video
        ref={setVideo}
        src={version.streamUrl}
        aria-label={title}
        preload="auto"
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload noremoteplayback"
        onContextMenu={(event) => { event.preventDefault(); }}
        onError={() => { setFailed(true); }}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {box && <div data-testid="video-picture-box" className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        <span data-testid="video-timecode-chip" aria-hidden="true" className={cn("absolute bottom-[var(--space-2)] left-[var(--space-2)] max-w-[calc(100%-var(--space-4))] overflow-hidden whitespace-nowrap border border-invert-foreground/20 bg-invert px-[var(--space-2)] py-[var(--space-1)] text-invert-foreground", MONO)}>{chip}</span>
      </div>}
      {failed && <div data-surface="default" className="absolute inset-x-[var(--space-3)] top-[var(--space-3)]"><Notice tone="caution" role="alert" className="bg-card">This version can't play in this browser.</Notice></div>}
    </div>

    {/* The scrubber. Note markers (5b) are drawn over this track; the slider owns its step (one frame) and its keys. */}
    <div data-testid="video-scrubber" className="relative">
      <Slider
        value={[Math.min(shownFrame, Math.max(1, lastFrame))]}
        min={0}
        max={Math.max(1, lastFrame)}
        step={1}
        largeStep={Math.max(1, Math.round(rationalToNumber(version.fps)))}
        onValueChange={(value) => { clock.seekToFrame(Array.isArray(value) ? (value[0] ?? 0) : value); }}
        thumbProps={{ getAriaLabel: () => "Timeline", getAriaValueText: (_formatted, value) => timecode(value) }}
      />
    </div>

    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <IconTip label="Previous frame" keys="←">
        <Button type="button" variant="outline" size="icon" aria-label="Previous frame" className={COARSE} onClick={() => { clock.step(-1); }}><StepBack aria-hidden="true" /></Button>
      </IconTip>
      <IconTip label={playLabel} keys="Space">
        <Button type="button" variant="default" size="icon" aria-label={playLabel} className={cn("w-[var(--space-7)]", COARSE)} onClick={() => { if (clock.playing) clock.pause(); else clock.play(); }}>{clock.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
      </IconTip>
      <IconTip label="Next frame" keys="→">
        <Button type="button" variant="outline" size="icon" aria-label="Next frame" className={COARSE} onClick={() => { clock.step(1); }}><StepForward aria-hidden="true" /></Button>
      </IconTip>
      <output data-testid="video-readout" aria-live={clock.playing || !clock.confirmed ? "off" : "polite"} className={cn("px-[var(--space-2)] max-[721px]:px-0", MONO)}>
        <span>{timecode(clock.frame)}</span><span className="text-foreground-secondary">{` / ${timecode(version.frameCount)}`}</span>
      </output>
      <div data-testid="video-key-legend" className={LEGEND}>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>J</Kbd><Kbd className={LEGEND_KBD}>K</Kbd><Kbd className={LEGEND_KBD}>L</Kbd></KbdGroup>shuttle</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>←</Kbd><Kbd className={LEGEND_KBD}>→</Kbd></KbdGroup>frame</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><Kbd className={LEGEND_KBD}>Space</Kbd>play</span>
      </div>
      <div className="ml-auto flex items-center gap-[var(--space-1)]">
        <IconTip label={muted ? "Unmute" : "Mute"}>
          <Toggle variant="default" size="default" pressed={muted} onPressedChange={toggleMuted} aria-label="Mute" className={cn("size-8", COARSE)}>{muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</Toggle>
        </IconTip>
        {fullscreenAvailable && <IconTip label="Full screen">
          <Button type="button" variant="ghost" size="icon" aria-label="Full screen" className={cn("size-8", COARSE)} onClick={() => { void playerRef.current?.requestFullscreen?.(); }}><Maximize aria-hidden="true" /></Button>
        </IconTip>}
      </div>
    </div>
  </section>;
}
