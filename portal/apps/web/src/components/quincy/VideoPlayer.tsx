import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowRightFromLine, ArrowRightToLine, Maximize, Pause, Play, StepBack, StepForward, Volume2, VolumeX, X } from "lucide-react";
import { rationalToNumber, type Box, type VideoVersionDto } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { useVideoFrameClock, type VideoFrameClock } from "../../lib/video-frame-clock";
import { usePlayerKeys } from "../../lib/use-player-keys";
import { useFrameLabel, useTimeFormat } from "../../lib/time-format-prefs";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Button } from "../reui/button";
import { Kbd, KbdGroup } from "../reui/kbd";
import { Slider } from "../reui/slider";
import { Toggle } from "../reui/toggle";
import { IconTip } from "./IconTip";
import { TimeFormatMenu } from "./TimeFormatMenu";
import { VideoStage } from "./VideoStage";
import { SocialPreviewControls, useOverlayImage, type SocialPreviewMode } from "./SocialPreviewControls";
import { useMediaQuery } from "../../lib/use-media-query";
import { PHONE_QUERY } from "../../lib/review-pane-geometry";
import { rangeStep, type NoteMarks } from "../../lib/video-note-marks";
import { VideoPendingRangeBand, VideoRangeHandles, VideoTimelineMarkers, type TimelineMarker } from "./VideoTimelineMarkers";

/** What the player reads of a Version: where it streams, how it is timed, and how its timecode is labelled. */
export type VideoPlayerVersion = Pick<VideoVersionDto, "streamUrl" | "fps" | "frameCount" | "width" | "height" | "tcNominalFps" | "tcDropFrame" | "startTimecodeFrames" | "hasAudio">;

/**
 * The composer's in / out range as the player draws and edits it (#861): the marks to show, whether the host takes changes right now, and how to
 * clear them. Marking itself goes through `onMark`, the path I and O use, so a host's wrappers run for the button and the handles too.
 * Absent, the player has no range button and no handles.
 */
export type VideoRangeControl = {
  marks: NoteMarks;
  /** The host takes no change to the marks right now (archived Project, a reply open, a request out, no open composer). The controls stay, disabled. */
  locked: boolean;
  /** Why it is locked, for the disabled button's tooltip. */
  hint?: string;
  clear(): void;
};

/** For a host that owns the keyboard scope (the review dialog): hands it the player's shortcut handler. True when the key was the player's. */
export type VideoPlayerControl = {
  handleKeyDown(event: KeyboardEvent | ReactKeyboardEvent): boolean;
  /** The frame on screen: while playing the one last presented; paused, the one a seek in flight is bringing (what an I / O mark takes). */
  currentFrame(): number;
};

export const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";
/** An icon control inside the phone note pill (#879 fix, kit.jsx `ibtn sm`): drawn at 32px so the text keeps the room, with a 44px hit area from a transparent pseudo-element. */
export const PILL_ICON = "relative size-8 after:absolute after:-inset-1.5 after:content-['']";
/** The phone Play's row slot (P1's ControlBar: a 44px `ibtn`, then a 4px gap to the time): drawn as a 32px PILL_ICON with half a --space-3 either side, so its
 *  44px hit area is its own slot in the row, the way Mute's sits in --space-3 gaps, and the readout starts at 12 + 44 + 4 = 60pt. */
const PHONE_PLAY_SLOT = "mx-[calc(var(--space-3)/2)]";
const MONO = "[font:var(--type-mono)] tabular-nums";
/** P1's PlayBadge: a 60px round, translucent ink disc on the film (`--space-8` less `--space-1`), the inverse surface's paper icon. */
const PLAY_BADGE = "pointer-events-auto size-[calc(var(--space-8)-var(--space-1))] rounded-[var(--radius-pill)] bg-[color-mix(in_srgb,var(--ink-900)_55%,transparent)] !text-foreground hover:bg-[color-mix(in_srgb,var(--ink-900)_70%,transparent)]";
// These chips keep the Lightbox's SHORTCUT_KBD skin (bordered, bg-secondary) rather than the Kbd primitive, to match the Lightbox legend.
export const LEGEND_KBD = "rounded-[var(--radius-xs)] border border-solid border-[length:var(--border-width-hair)] border-border bg-secondary px-[var(--space-1)] text-foreground [font:var(--weight-regular)_var(--text-2xs)/1.4_var(--font-mono)]";
const LEGEND = "flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-foreground-secondary [font:var(--type-label)] pointer-coarse:hidden max-[721px]:hidden @max-[64rem]:hidden";

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
export function VideoPlayer({ version, title, controlRef, keyboard = "self", className, initialFrame, initialMuted = false, onMutedChange, markers, pendingRange, onMarkerSelect, onMark, range, onClockChange, overlay, watermark, onMediaError, transportLocked = false, transportActions, transportReplacement, social, phoneFrameStep = false, transportHidden = false }: {
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
  /** The in / out range, drawn as handles on the scrubber and driven by one cycling button next to the time format (#861). Without it neither exists. */
  range?: VideoRangeControl;
  /** The frame clock, once the element is ready, and null when it goes away; siblings (the notes composer) subscribe to it on their own. */
  onClockChange?: (clock: VideoFrameClock | null) => void;
  /** Drawn over the stage (#741 6b-ui); a function is handed the picture box. Built by the host, so this module never imports it. */
  overlay?: ReactNode | ((box: Box | null) => ReactNode);
  /** Drawn over the picture box and never dropped by Social (#872): the premium watermark. Built by the host. */
  watermark?: (box: Box) => ReactNode;
  /** The `<video>` reported an error; the stage still shows its own "can't play" notice. */
  onMediaError?: () => void;
  /** Drawing: the transport, the scrubber and the player's keys are inert, so nothing moves the frame under the pen. */
  transportLocked?: boolean;
  /** Extra transport buttons, in the right-hand group before volume and full screen (the notes host puts "Draw" here). Built by the host, so this module never imports markup code. */
  transportActions?: ReactNode;
  /** Replaces the whole transport block (scrubber, controls, key legend) in place, under the picture, while the host needs the room (drawing). Never overlaid on the picture. */
  transportReplacement?: ReactNode;
  /**
   * Social preview (#871): the film framed 9:16 under an overlay. Nothing else changes (#877): markers, the range, I and O, Draw and the markup overlay all work, the overlay slot drawn inside the frame
   * on the letterboxed picture, so a stroke is the same fraction of the film with Social on or off. Playback, the scrubber, the keys, mute, the time format and full screen work as ever.
   */
  social?: SocialPreviewMode;
  /** The phone control bar drops frame step because the notes composer carries it (#879). A host with no such composer (the guest screen, a staff edit in progress) turns it back on. */
  phoneFrameStep?: boolean;
  /** The phone compose mode (#879 fix, P6): the transport block is hidden (still mounted), so the film takes the room above the compose strip. */
  transportHidden?: boolean;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [muted, setMutedState] = useState(initialMuted);
  const playerRef = useRef<HTMLElement | null>(null);
  // The transport block's height, kept while it shows so its replacement (drawing) takes at least the same room: the picture above never moves when Draw is pressed.
  const transportRef = useRef<HTMLDivElement | null>(null);
  const transportHeight = useRef<number | null>(null);
  useLayoutEffect(() => { if (transportReplacement == null && !transportHidden && transportRef.current) transportHeight.current = transportRef.current.offsetHeight; });
  const clock = useVideoFrameClock(video, version, initialFrame === undefined ? {} : { initialFrame });

  const timecode = useFrameLabel(version);
  const [timeFormat] = useTimeFormat();
  // Full screen shows only the player's own subtree, so the time-format menu portals into it while it is up (else it opens behind, unseen).
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const inheritedOverlay = useContext(OverlayContainerContext);
  useEffect(() => {
    const onChange = () => { setIsFullscreen(section !== null && document.fullscreenElement === section); };
    document.addEventListener("fullscreenchange", onChange);
    return () => { document.removeEventListener("fullscreenchange", onChange); };
  }, [section]);
  const socialImage = useOverlayImage(social);
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

  const step = range ? rangeStep(range.marks) : "in";
  const rangeLocked = transportLocked || (range?.locked ?? true);
  const marksTaken = !rangeLocked && onMark !== undefined;
  const pressRange = () => {
    if (!range || rangeLocked) return;
    if (step === "clear") range.clear();
    else onMark?.(step, markFrame());
  };
  // A handle moved: it marks its own end, and the paused playhead follows so the frame under the handle is the one on screen.
  const moveHandle = (kind: "in" | "out", frame: number) => { onMark?.(kind, frame); clock.seekToFrame(frame); };
  const stepLabel = step === "in" ? "Set in point" : step === "out" ? "Set out point" : "Clear in and out";

  // A phone gets the single-row control bar (#879, the prototype's ControlBar): scrubber, play, timecode, mute, full screen. Frame step and in / out live in the composer there.
  // #879 PR 3a: the bar is P1's 78pt band: the scrubber band, a 44px row of plain (ghost) 32px icons with 44px hit areas (`PILL_ICON`), the current time only.
  const phone = useMediaQuery(PHONE_QUERY);
  const toggleMuted = (next: boolean) => { setMutedState(next); clock.setMuted(next); onMutedChange?.(next); };
  const playLabel = clock.playing ? "Pause" : "Play";
  // P1's PlayBadge (#879 PR 3a, owner decision): the paused phone film carries a centred play button, gone while playing, drawing or composing. It is a pointer shortcut for the
  // transport's Play, which keeps the name and the keyboard: so it is out of the tab order and the accessibility tree.
  const badge = phone && !clock.playing && !transportHidden && !transportLocked && transportReplacement == null
    ? <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-hidden="true" data-testid="video-play-badge" className={PLAY_BADGE} onClick={() => { clock.play(); }}><Play aria-hidden="true" className="size-6" /></Button>
    : null;

  return <section
    ref={(element) => { playerRef.current = element; setSection(element); }}
    aria-label="Player"
    data-testid="video-player"
    tabIndex={-1}
    onKeyDown={keyboard === "self" ? (event) => { handleKeyDown(event); } : undefined}
    className={cn("@container flex min-h-0 min-w-0 flex-col gap-[var(--space-3)] max-[721px]:gap-0 focus-visible:!outline-none [&:fullscreen]:bg-background [&:fullscreen]:p-[var(--space-4)]", className)}
  >
    <VideoStage streamUrl={version.streamUrl} title={title} width={version.width} height={version.height} timecode={timecode(clock.frame)} frame={clock.frame} frameSuffix={timeFormat !== "frames"} onVideo={setVideo} overlay={overlay} watermark={watermark} onMediaError={onMediaError} badge={badge} {...(social ? { social: { imageUrl: socialImage.imageUrl, onImageError: socialImage.onImageError, onImageLoad: socialImage.onImageLoad } } : {})} />

    {/* The replacement sits ABOVE the transport, which stays mounted and hidden under it (#879 PR 2): unmounted, the slider came back as a new node, measured its thumb inside whatever
        box hid it next (a phone's Done lands in compose mode, where the transport is hidden) and drew no thumb until the frame moved. */}
    {transportReplacement != null && <div className="flex flex-col justify-center" style={transportHeight.current !== null ? { minHeight: transportHeight.current } : undefined}>{transportReplacement}</div>}
    <div ref={transportRef} hidden={transportHidden || transportReplacement != null} className="flex flex-col gap-[var(--space-3)] max-[721px]:gap-0 max-[721px]:px-[var(--space-3)] max-[721px]:pb-[var(--space-1)] [&[hidden]]:hidden">
    {/* The scrubber: the slider owns its step (one frame) and its keys. The pending band sits BEFORE it (the slider's Control paints over it, so the thumb stays on top); the marker lane sits under the track.
        A phone draws it as P1's `.scrub` band (#879 PR 3a): `--space-6` tall, the marker lane laid inside it along the top, the track through its middle, a 44px touch band from the slider's `band` size. */}
    <div data-testid="video-scrubber" className={phone ? "relative h-[var(--space-6)]" : undefined}>
      {/* The band is placed against the slider alone: inside the same box as the marker lane it would sit centred on the whole scrubber, 6px below the track. */}
      <div className={phone ? "relative h-full" : "relative"}>
        {pendingRange !== undefined && <VideoPendingRangeBand range={pendingRange} frameCount={version.frameCount} />}
        <Slider
          value={[Math.min(shownFrame, Math.max(1, lastFrame))]}
          min={0}
          max={Math.max(1, lastFrame)}
          size={phone ? "band" : "default"}
          step={1}
          disabled={transportLocked}
          largeStep={Math.max(1, Math.round(rationalToNumber(version.fps)))}
          onValueChange={(value) => { clock.seekToFrame(Array.isArray(value) ? (value[0] ?? 0) : value); }}
          thumbProps={{ getAriaLabel: () => "Timeline", getAriaValueText: (_formatted, value) => timecode(value) }}
        />
        {range !== undefined && <VideoRangeHandles marks={range.marks} frameCount={version.frameCount} label={timecode} largeStep={Math.max(1, Math.round(rationalToNumber(version.fps)))} interactive={marksTaken} onMove={moveHandle} onGrab={clock.pause} />}
      </div>
      {markers !== undefined && (!phone || markers.length > 0) && <VideoTimelineMarkers markers={markers} frameCount={version.frameCount} {...(onMarkerSelect ? { onSelect: onMarkerSelect } : {})} {...(phone ? { className: "absolute inset-x-0 top-0" } : {})} />}
    </div>

    <div data-testid="video-controls-row" className="flex flex-wrap items-center gap-[var(--space-2)] max-[721px]:h-11 max-[721px]:flex-nowrap max-[721px]:gap-[var(--space-1)]">
      {(!phone || phoneFrameStep) && <IconTip label="Previous frame" keys="←">
        <Button type="button" variant={phone ? "ghost" : "outline"} size="icon" aria-label="Previous frame" className={phone ? PILL_ICON : COARSE} disabled={transportLocked} onClick={() => { clock.step(-1); }}><StepBack aria-hidden="true" /></Button>
      </IconTip>}
      <IconTip label={playLabel} keys="Space">
        <Button type="button" variant={phone ? "ghost" : "default"} size="icon" aria-label={playLabel} className={phone ? cn(PILL_ICON, PHONE_PLAY_SLOT) : cn("w-[var(--space-7)]", COARSE)} disabled={transportLocked} onClick={() => { if (clock.playing) clock.pause(); else clock.play(); }}>{clock.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
      </IconTip>
      {(!phone || phoneFrameStep) && <IconTip label="Next frame" keys="→">
        <Button type="button" variant={phone ? "ghost" : "outline"} size="icon" aria-label="Next frame" className={phone ? PILL_ICON : COARSE} disabled={transportLocked} onClick={() => { clock.step(1); }}><StepForward aria-hidden="true" /></Button>
      </IconTip>}
      <output data-testid="video-readout" aria-live={clock.playing || !clock.confirmed ? "off" : "polite"} className={cn("px-[var(--space-2)] max-[721px]:min-w-0 max-[721px]:px-0 max-[721px]:text-xs max-[721px]:whitespace-nowrap", MONO)}>
        <span>{timecode(clock.frame)}</span>{!phone && <span data-testid="video-readout-total" className="text-foreground-secondary">{` / ${timecode(version.frameCount)}`}</span>}
      </output>
      {!phone && <OverlayContainerContext.Provider value={isFullscreen ? section : inheritedOverlay}><TimeFormatMenu /></OverlayContainerContext.Provider>}
      {social && !phone && <OverlayContainerContext.Provider value={isFullscreen ? section : inheritedOverlay}><SocialPreviewControls social={social} imageFailed={socialImage.failed} /></OverlayContainerContext.Provider>}
      {!phone && range !== undefined && (() => {
        const rangeButton = <Button type="button" variant="outline" size="icon" aria-label={stepLabel} data-testid="video-range-button" data-step={step} className={COARSE} disabled={rangeLocked} onClick={pressRange}>
          {step === "in" ? <ArrowRightFromLine aria-hidden="true" /> : step === "out" ? <ArrowRightToLine aria-hidden="true" /> : <X aria-hidden="true" />}
        </Button>;
        // A disabled button gets no hover or focus, so its reason hangs on an enabled wrapper the tooltip can open from.
        if (rangeLocked && range.hint) return <IconTip label={range.hint}><span tabIndex={0} data-testid="video-range-tip" className="inline-flex rounded-[var(--radius-md)] focus-visible:ring-2 focus-visible:ring-ring">{rangeButton}</span></IconTip>;
        return <IconTip label={stepLabel} {...(rangeLocked ? {} : { keys: step === "clear" ? "I / O" : step === "in" ? "I" : "O" })}>{rangeButton}</IconTip>;
      })()}
      {!phone && <div data-testid="video-key-legend" className={LEGEND}>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>J</Kbd><Kbd className={LEGEND_KBD}>K</Kbd><Kbd className={LEGEND_KBD}>L</Kbd></KbdGroup>shuttle</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>←</Kbd><Kbd className={LEGEND_KBD}>→</Kbd></KbdGroup>frame</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><Kbd className={LEGEND_KBD}>Space</Kbd>play</span>
        {onMark && <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>I</Kbd><Kbd className={LEGEND_KBD}>O</Kbd></KbdGroup>in/out</span>}
      </div>}
      {/* On a phone the 32px icons sit --space-3 apart, so their 44px hit areas meet without overlapping. */}
      <div className="ml-auto flex items-center gap-[var(--space-1)] max-[721px]:gap-[var(--space-3)]">
        {transportActions}
        <IconTip label={muted ? "Unmute" : "Mute"}>
          <Toggle variant="default" size="default" pressed={muted} onPressedChange={toggleMuted} aria-label="Mute" className={phone ? PILL_ICON : cn("size-8", COARSE)}>{muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</Toggle>
        </IconTip>
        {fullscreenAvailable && <IconTip label="Full screen">
          <Button type="button" variant="ghost" size="icon" aria-label="Full screen" className={phone ? PILL_ICON : cn("size-8", COARSE)} onClick={() => { void playerRef.current?.requestFullscreen?.(); }}><Maximize aria-hidden="true" /></Button>
        </IconTip>}
      </div>
    </div>
    {/* On a phone the overlay selector gets its own row, so it never sits on the timecode. */}
    {social && phone && <div data-testid="video-social-row" className="flex flex-wrap items-center gap-[var(--space-2)]"><OverlayContainerContext.Provider value={isFullscreen ? section : inheritedOverlay}><SocialPreviewControls social={social} imageFailed={socialImage.failed} /></OverlayContainerContext.Provider></div>}
    </div>
  </section>;
}
