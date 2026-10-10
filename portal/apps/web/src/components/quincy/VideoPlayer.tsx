import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { Maximize, Pause, Play, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { framesToTimecode, rationalToNumber, type Box, type VideoVersionDto } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { useVideoFrameClock, type VideoFrameClock } from "../../lib/video-frame-clock";
import { usePlayerKeys } from "../../lib/use-player-keys";
import { Button } from "../reui/button";
import { Kbd, KbdGroup } from "../reui/kbd";
import { Slider } from "../reui/slider";
import { Toggle } from "../reui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";
import { VideoStage } from "./VideoStage";
import { VideoPendingRangeBand, VideoTimelineMarkers, type TimelineMarker } from "./VideoTimelineMarkers";

/** What the player reads of a Version: where it streams, how it is timed, and how its timecode is labelled. */
export type VideoPlayerVersion = Pick<VideoVersionDto, "streamUrl" | "fps" | "frameCount" | "width" | "height" | "tcNominalFps" | "tcDropFrame" | "startTimecodeFrames" | "hasAudio">;

/** For a host that owns the keyboard scope (the review dialog): hands it the player's shortcut handler. True when the key was the player's. */
export type VideoPlayerControl = {
  handleKeyDown(event: KeyboardEvent | ReactKeyboardEvent): boolean;
  /** The frame on screen: while playing the one last presented; paused, the one a seek in flight is bringing (what an I / O mark takes). */
  currentFrame(): number;
};

export const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";
const MONO = "[font:var(--type-mono)] tabular-nums";
// These chips keep the Lightbox's SHORTCUT_KBD skin (bordered, bg-secondary) rather than the Kbd primitive, to match the Lightbox legend.
export const LEGEND_KBD = "rounded-[var(--radius-xs)] border border-solid border-[length:var(--border-width-hair)] border-border bg-secondary px-[var(--space-1)] text-foreground [font:var(--weight-regular)_var(--text-2xs)/1.4_var(--font-mono)]";
const LEGEND = "flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-foreground-secondary [font:var(--type-label)] pointer-coarse:hidden max-[721px]:hidden";

export function IconTip({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
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
export function VideoPlayer({ version, title, controlRef, keyboard = "self", className, initialFrame, initialMuted = false, onMutedChange, markers, pendingRange, onMarkerSelect, onMark, onClockChange, overlay, transportLocked = false, transportActions, transportReplacement }: {
  version: VideoPlayerVersion;
  title: string;
  controlRef?: Ref<VideoPlayerControl>;
  keyboard?: "self" | "host";
  className?: string;
  /** The frame the player opens on (Compare hands A's frame back on exit). Read once, when the clock is built. */
  initialFrame?: number;
  /** The mute choice the player opens with (one choice across the single player and Compare), and where a change is reported. */
  initialMuted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  /** Notes (or anything frame-anchored) to draw under the track. Data, not note DTOs: the guest page and Compare pass their own. */
  markers?: readonly TimelineMarker[];
  /** The in / out marks being composed, drawn as a band over the track. */
  pendingRange?: { startFrame: number; endFrame: number | null } | null;
  /** A fine-pointer click on a marker (the lane is inert on touch). */
  onMarkerSelect?: (id: string) => void;
  /** Takes I and O: called with the frame on screen (the one on its way while a seek is in flight). Without it I and O are not bound. */
  onMark?: (kind: "in" | "out", frame: number) => void;
  /** The frame clock, once the element is ready, and null when it goes away; siblings (the notes composer) subscribe to it on their own. */
  onClockChange?: (clock: VideoFrameClock | null) => void;
  /** Drawn over the stage (#741 6b-ui); a function is handed the picture box. Built by the host, so this module never imports it. */
  overlay?: ReactNode | ((box: Box | null) => ReactNode);
  /** Drawing: the transport, the scrubber and the player's keys are inert, so nothing moves the frame under the pen. */
  transportLocked?: boolean;
  /** Extra transport buttons, in the right-hand group before volume and full screen (the notes host puts "Draw" here). Built by the host, so this module never imports markup code. */
  transportActions?: ReactNode;
  /** Replaces the whole transport block (scrubber, controls, key legend) in place, under the picture, while the host needs the room (drawing). Never overlaid on the picture. */
  transportReplacement?: ReactNode;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [muted, setMutedState] = useState(initialMuted);
  const playerRef = useRef<HTMLElement | null>(null);
  // The transport block's height, kept while it shows so its replacement (drawing) takes at least the same room: the picture above never moves when Draw is pressed.
  const transportRef = useRef<HTMLDivElement | null>(null);
  const transportHeight = useRef<number | null>(null);
  useLayoutEffect(() => { if (transportReplacement == null && transportRef.current) transportHeight.current = transportRef.current.offsetHeight; });
  const clock = useVideoFrameClock(video, version, initialFrame === undefined ? {} : { initialFrame });

  const base = useMemo(() => ({ nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }), [version.tcNominalFps, version.tcDropFrame]);
  const start = version.startTimecodeFrames ?? 0;
  const timecode = useCallback((frame: number) => framesToTimecode(frame, base, start), [base, start]);
  const lastFrame = Math.max(0, version.frameCount - 1);
  const shownFrame = clock.targetFrame ?? clock.frame;
  const fullscreenAvailable = typeof document !== "undefined" && document.fullscreenEnabled === true;

  const onClockChangeRef = useRef(onClockChange);
  onClockChangeRef.current = onClockChange;
  const instance = clock.instance;
  useEffect(() => { if (instance && initialMuted) instance.setMuted(true); }, [instance]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onClockChangeRef.current?.(instance);
    return () => { onClockChangeRef.current?.(null); };
  }, [instance]);

  const markFrame = () => (clock.playing ? clock.frame : (clock.targetFrame ?? clock.frame));
  const currentFrameRef = useRef(markFrame);
  currentFrameRef.current = markFrame;
  const handleKeyDown = usePlayerKeys({
    rate: clock.rate,
    play: clock.play,
    pause: clock.pause,
    setRate: clock.setRate,
    reverse: clock.reverse,
    step: clock.step,
    home: () => { clock.seekToFrame(0); },
    end: () => { clock.seekToFrame(lastFrame); },
    markFrame,
  }, onMark, transportLocked);
  const currentFrame = useCallback(() => currentFrameRef.current(), []);
  useImperativeHandle(controlRef, () => ({ handleKeyDown, currentFrame }), [handleKeyDown, currentFrame]);

  const toggleMuted = (next: boolean) => { setMutedState(next); clock.setMuted(next); onMutedChange?.(next); };
  const playLabel = clock.playing ? "Pause" : "Play";

  return <section
    ref={playerRef}
    aria-label="Player"
    data-testid="video-player"
    tabIndex={-1}
    onKeyDown={keyboard === "self" ? (event) => { handleKeyDown(event); } : undefined}
    className={cn("flex min-h-0 min-w-0 flex-col gap-[var(--space-3)] focus-visible:!outline-none [&:fullscreen]:bg-background [&:fullscreen]:p-[var(--space-4)]", className)}
  >
    <VideoStage streamUrl={version.streamUrl} title={title} width={version.width} height={version.height} timecode={timecode(clock.frame)} frame={clock.frame} onVideo={setVideo} overlay={overlay} />

    {transportReplacement != null ? <div className="flex flex-col justify-center" style={transportHeight.current !== null ? { minHeight: transportHeight.current } : undefined}>{transportReplacement}</div> : <div ref={transportRef} className="flex flex-col gap-[var(--space-3)]">
    {/* The scrubber: the slider owns its step (one frame) and its keys. The pending band sits BEFORE it (the slider's Control paints over it, so the thumb stays on top); the marker lane sits under the track. */}
    <div data-testid="video-scrubber">
      {/* The band is placed against the slider alone: inside the same box as the marker lane it would sit centred on the whole scrubber, 6px below the track. */}
      <div className="relative">
        {pendingRange !== undefined && <VideoPendingRangeBand range={pendingRange} frameCount={version.frameCount} />}
        <Slider
          value={[Math.min(shownFrame, Math.max(1, lastFrame))]}
          min={0}
          max={Math.max(1, lastFrame)}
          step={1}
          disabled={transportLocked}
          largeStep={Math.max(1, Math.round(rationalToNumber(version.fps)))}
          onValueChange={(value) => { clock.seekToFrame(Array.isArray(value) ? (value[0] ?? 0) : value); }}
          thumbProps={{ getAriaLabel: () => "Timeline", getAriaValueText: (_formatted, value) => timecode(value) }}
        />
      </div>
      {markers !== undefined && <VideoTimelineMarkers markers={markers} frameCount={version.frameCount} {...(onMarkerSelect ? { onSelect: onMarkerSelect } : {})} />}
    </div>

    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <IconTip label="Previous frame" keys="←">
        <Button type="button" variant="outline" size="icon" aria-label="Previous frame" className={COARSE} disabled={transportLocked} onClick={() => { clock.step(-1); }}><StepBack aria-hidden="true" /></Button>
      </IconTip>
      <IconTip label={playLabel} keys="Space">
        <Button type="button" variant="default" size="icon" aria-label={playLabel} className={cn("w-[var(--space-7)]", COARSE)} disabled={transportLocked} onClick={() => { if (clock.playing) clock.pause(); else clock.play(); }}>{clock.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
      </IconTip>
      <IconTip label="Next frame" keys="→">
        <Button type="button" variant="outline" size="icon" aria-label="Next frame" className={COARSE} disabled={transportLocked} onClick={() => { clock.step(1); }}><StepForward aria-hidden="true" /></Button>
      </IconTip>
      <output data-testid="video-readout" aria-live={clock.playing || !clock.confirmed ? "off" : "polite"} className={cn("px-[var(--space-2)] max-[721px]:px-0", MONO)}>
        <span>{timecode(clock.frame)}</span><span className="text-foreground-secondary">{` / ${timecode(version.frameCount)}`}</span>
      </output>
      <div data-testid="video-key-legend" className={LEGEND}>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>J</Kbd><Kbd className={LEGEND_KBD}>K</Kbd><Kbd className={LEGEND_KBD}>L</Kbd></KbdGroup>shuttle</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>←</Kbd><Kbd className={LEGEND_KBD}>→</Kbd></KbdGroup>frame</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><Kbd className={LEGEND_KBD}>Space</Kbd>play</span>
        {onMark && <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>I</Kbd><Kbd className={LEGEND_KBD}>O</Kbd></KbdGroup>in/out</span>}
      </div>
      <div className="ml-auto flex items-center gap-[var(--space-1)]">
        {transportActions}
        <IconTip label={muted ? "Unmute" : "Mute"}>
          <Toggle variant="default" size="default" pressed={muted} onPressedChange={toggleMuted} aria-label="Mute" className={cn("size-8", COARSE)}>{muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</Toggle>
        </IconTip>
        {fullscreenAvailable && <IconTip label="Full screen">
          <Button type="button" variant="ghost" size="icon" aria-label="Full screen" className={cn("size-8", COARSE)} onClick={() => { void playerRef.current?.requestFullscreen?.(); }}><Maximize aria-hidden="true" /></Button>
        </IconTip>}
      </div>
    </div>
    </div>}
  </section>;
}
