import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowRightFromLine, ArrowRightToLine, Maximize, Minimize, Pause, Play, SquarePen, StepBack, StepForward, Volume2, VolumeX, X } from "lucide-react";
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
import { CHROME_HIDE_MS, chromeHeld, readPhoneDevice } from "../../lib/immersive";
import { liftRemotePlayback, nativePlayerSupported, openNativePlayer } from "../../lib/video-native-player";
import { Notice } from "./Notice";
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
  /** Single player only (Compare's two players have no such menu row). Hands the film to the device's own player (#880, D15): `webkitEnterFullscreen()` on iOS, else the video's `requestFullscreen()`. Call it inside the press; a refusal shows a notice in the player. */
  openSystemPlayer?(): void;
  /** Whether the device has a native player to hand the film to; the menu row is disabled with a reason where it has none. */
  nativePlayerSupported?(): boolean;
};

/**
 * Quincy's own Full screen (#880, "immersive" in code only; D12). The screen owns the mode and passes it here: the player applies it IN PLACE, so the `<video>`, the overlays and the
 * composer keep their nodes (a new parent would remount the clock and the editor). Absent (Compare, any other host) the player keeps today's element full screen, and only where the
 * browser has one. Present, the button always renders: iPhone Safari has no `fullscreenEnabled`, and that is what made the old button missing there.
 */
export type VideoImmersiveHost = {
  on: boolean;
  /** Full screen, Exit full screen and the F key. */
  onToggle(): void;
  /** The top bar's title: "Film name · v2". */
  heading: string;
  /** Add note (aria-pressed while the composer is open over the film). Absent where the screen offers none. */
  addNote?: { pressed: boolean; onToggle(): void };
  /** The note card a marker press opened; it sits top-centre and goes with the controls. */
  card?: ReactNode;
  /** A press on a marker while in full screen: the host pauses and shows that note as a card. Without it the ordinary `onMarkerSelect` runs. */
  onMarkerTap?(id: string): void;
};

export const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";
/** An icon control inside the phone note pill (#879 fix, kit.jsx `ibtn sm`): drawn at 32px so the text keeps the room, with a 44px hit area from a transparent pseudo-element. */
export const PILL_ICON = "relative size-8 after:absolute after:-inset-1.5 after:content-['']";
/** The phone Play's row slot (P1's ControlBar: a 44px `ibtn`, then a 4px gap to the time): drawn as a 32px PILL_ICON with half a --space-3 either side, so its
 *  44px hit area is its own slot in the row, the way Mute's sits in --space-3 gaps, and the readout starts at 12 + 44 + 4 = 60pt. */
const PHONE_PLAY_SLOT = "mx-[calc(var(--space-3)/2)]";
const MONO = "[font:var(--type-mono)] tabular-nums";
/** P1's PlayBadge: a 60px round, translucent ink disc on the film (`--space-8` less `--space-1`), the inverse surface's paper icon. */
/**
 * Whether the focus is in a menu, list or dialog of the player's own (#880 fix round 2): one inside the player, or portalled out of it (React still bubbles its focus here).
 * Never one the player sits in: the staff viewer is a modal dialog, and counting it held the controls on every focus in the player, the Exit focus at entry included.
 */
function ownPopup(target: Element, player: Element): boolean {
  const popup = target.closest('[role="menu"], [role="listbox"], [role="dialog"]');
  return popup !== null && !popup.contains(player);
}
/** Full screen's dock while Add note is open (#880 fix round 1, F1): the scrim's top padding plus the composer's published height and the space under it, so the scrim runs behind the composer. */
const COMPOSING_SCRIM = "pt-[calc(var(--space-6)+var(--immersive-composer-h,0px)+var(--space-2))]";
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
export function VideoPlayer({ version, title, controlRef, keyboard = "self", className, initialFrame, initialMuted = false, onMutedChange, markers, pendingRange, onMarkerSelect, onMark, range, onClockChange, overlay, watermark, onMediaError, transportLocked = false, transportActions, transportReplacement, social, phoneFrameStep = false, transportHidden = false, immersive }: {
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
  /** The phone compose mode (#879 fix, P6): the transport block is hidden (still mounted), so the film takes the room above the compose strip. Ignored in Full screen, where F1 keeps the controls under the composer. */
  transportHidden?: boolean;
  /** Quincy's Full screen (#880). */
  immersive?: VideoImmersiveHost;
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
  }, onMark, transportLocked, immersive ? () => { immersive.onToggle(); } : undefined);
  const currentFrame = useCallback(() => currentFrameRef.current(), []);

  // Full screen (#880). The mode is the host's; this is what the player does with it.
  const imm = immersive?.on === true;
  // A phone is a device, not a width: a landscape iPhone is 844px wide and still gets the handheld controls.
  const [phoneDevice] = useState(readPhoneDevice);
  const phone = useMediaQuery(PHONE_QUERY);
  const compact = imm && (phone || phoneDevice);
  // The phone's styling (P1's single row, the band scrubber, the play badge): a phone width, or a phone device in Full screen.
  const handheld = phone || compact;
  // F1 keeps the controls under the composer: a host's compose-mode hide does not apply in Full screen.
  const hidesTransport = transportHidden && !imm;
  const [chromeShown, setChromeShown] = useState(true);
  const [activity, setActivity] = useState(0);
  const [focusHeld, setFocusHeld] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const composing = immersive?.addNote?.pressed === true;
  const cardOpen = immersive?.card != null;
  const drawing = transportReplacement != null || transportLocked;
  const paused = !clock.playing;
  const held = chromeHeld({ playing: clock.playing, composing, drawing, card: cardOpen, focusWithin: focusHeld, popupOpen, scrubbing });
  const lastWake = useRef(0);
  const wake = useCallback(() => { setChromeShown(true); setActivity((count) => count + 1); }, []);
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  // Hide 3s after playback starts, unless something holds the controls (D13). Any activity starts the count again.
  useEffect(() => {
    if (!imm || !chromeShown || held) return undefined;
    const timer = setTimeout(() => { setChromeShown(false); }, CHROME_HIDE_MS);
    return () => { clearTimeout(timer); };
  }, [imm, chromeShown, held, activity]);
  // Whatever needs the controls brings them back: pausing, a card, the composer, the pen.
  useEffect(() => { if (imm && (paused || cardOpen || composing || drawing)) setChromeShown(true); }, [imm, paused, cardOpen, composing, drawing]);
  // Focus holds the controls only when a key moved it (#880 fix round 1). `:focus-visible` cannot say so on iOS: WebKit marks a scripted focus() visible unless the last focus
  // came from a click, and a tap never focuses a button there, so the Exit focus placed at entry and the thumb focus Base UI places on a scrubber press both matched it and
  // held the controls for good. The last input decides instead: a key makes the next focus a keyboard focus, a pointer press makes it a pointer one (and drops the hold).
  const keyboardInput = useRef(false);
  useEffect(() => {
    const onKey = () => { keyboardInput.current = true; };
    const onPointer = () => { keyboardInput.current = false; setFocusHeld(false); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); };
  }, []);
  // The scrub hold ends on the pointer's release, listened for from inside the press itself: a quick tap's pointerup can land before any effect that would attach it.
  const scrubRelease = useRef<(() => void) | null>(null);
  const stopListeningForScrubEnd = useCallback(() => {
    const done = scrubRelease.current;
    if (!done) return;
    scrubRelease.current = null;
    window.removeEventListener("pointerup", done, true); window.removeEventListener("pointercancel", done, true);
  }, []);
  const startScrub = useCallback(() => {
    setScrubbing(true);
    if (scrubRelease.current) return;
    const done = () => { stopListeningForScrubEnd(); setScrubbing(false); };
    scrubRelease.current = done;
    window.addEventListener("pointerup", done, true); window.addEventListener("pointercancel", done, true);
  }, [stopListeningForScrubEnd]);
  useEffect(() => stopListeningForScrubEnd, [stopListeningForScrubEnd]);
  useEffect(() => { if (!imm) { setChromeShown(true); setFocusHeld(false); setPopupOpen(false); setScrubbing(false); stopListeningForScrubEnd(); } }, [imm, stopListeningForScrubEnd]);
  const keyDown = useCallback((event: KeyboardEvent | ReactKeyboardEvent): boolean => { wakeRef.current(); return handleKeyDown(event); }, [handleKeyDown]);
  const [nativeFailed, setNativeFailed] = useState(false);
  // AirPlay during the hand-off (owner decision 3, #880 S7): the restriction is lifted inside the press, before the native player is entered, and restored when that player
  // closes (webkitendfullscreen, or the element full screen ending), when the device refuses, and when the film goes (a Version change re-keys the player, or it unmounts).
  const restoreRemote = useRef<(() => void) | null>(null);
  const restoreRemotePlayback = useCallback(() => { restoreRemote.current?.(); restoreRemote.current = null; }, []);
  const openSystemPlayer = useCallback(() => {
    if (video) { restoreRemotePlayback(); restoreRemote.current = liftRemotePlayback(video); }
    void openNativePlayer(video).then((started) => { setNativeFailed(!started); if (!started) restoreRemotePlayback(); });
  }, [video, restoreRemotePlayback]);
  useEffect(() => {
    if (!video) return undefined;
    const onFullscreenChange = () => { if (document.fullscreenElement !== video) restoreRemotePlayback(); };
    video.addEventListener("webkitendfullscreen", restoreRemotePlayback);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => { video.removeEventListener("webkitendfullscreen", restoreRemotePlayback); document.removeEventListener("fullscreenchange", onFullscreenChange); restoreRemotePlayback(); };
  }, [video, restoreRemotePlayback]);
  const nativeSupported = useCallback(() => nativePlayerSupported(video), [video]);
  useImperativeHandle(controlRef, () => ({ handleKeyDown: keyDown, currentFrame, openSystemPlayer, nativePlayerSupported: nativeSupported }), [keyDown, currentFrame, openSystemPlayer, nativeSupported]);
  const chromeVisible = !imm || chromeShown;

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
  // #879 PR 3a: the bar is P1's 78pt band: the scrubber band, a 44px row of plain (ghost) 32px icons with 44px hit areas (`PILL_ICON`), the current time only. `handheld` (#880) is the
  // phone width or a phone device in Full screen, so a landscape iPhone (844pt) in Full screen gets the same bar.
  const toggleMuted = (next: boolean) => { setMutedState(next); clock.setMuted(next); onMutedChange?.(next); };
  const playLabel = clock.playing ? "Pause" : "Play";
  // P1's PlayBadge (#879 PR 3a, owner decision): the paused phone film carries a centred play button, gone while playing, drawing or composing. It is a pointer shortcut for the
  // transport's Play, which keeps the name and the keyboard: so it is out of the tab order and the accessibility tree.
  const fade = chromeVisible ? "opacity-100" : "pointer-events-none opacity-0";
  const FADE = "motion-safe:transition-opacity motion-safe:duration-[var(--dur-base)] motion-safe:ease-[var(--ease-entrance)]";
  // In Full screen (#880) the badge is F1's centre Play, on every width, and it fades with the rest of the controls.
  const badge = (handheld || imm) && !clock.playing && !hidesTransport && !transportLocked && transportReplacement == null
    ? <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-hidden="true" data-testid="video-play-badge" inert={!chromeVisible} className={cn(PLAY_BADGE, imm && FADE, imm && fade)} onClick={() => { clock.play(); }}><Play aria-hidden="true" className="size-6" /></Button>
    : null;
  // The press target for Full screen: the host's mode, else the browser's element full screen where it has one (Compare and every other host).
  const fullscreenButton = immersive && !imm
    ? <IconTip label="Full screen">
      <Button type="button" variant="ghost" size="icon" aria-label="Full screen" data-testid="video-fullscreen" className={handheld ? PILL_ICON : cn("size-8", COARSE)} onClick={immersive.onToggle}><Maximize aria-hidden="true" /></Button>
    </IconTip>
    : !immersive && fullscreenAvailable
      ? <IconTip label="Full screen">
        <Button type="button" variant="ghost" size="icon" aria-label="Full screen" className={handheld ? PILL_ICON : cn("size-8", COARSE)} onClick={() => { void playerRef.current?.requestFullscreen?.(); }}><Maximize aria-hidden="true" /></Button>
      </IconTip>
      : null;
  // The dock (#880 S2): one wrapper, always rendered, around the replacement and the transport, so entering Full screen or putting the pen down never swaps the node the controls
  // live in (nor remounts the slider). Outside Full screen it lays out as nothing (`contents`); in Full screen it is the bottom overlay on a scrim, in the player's own tree
  // (safe-area insets keep it off the notch and the home bar).
  const dockClass = imm
    ? cn("absolute inset-x-0 bottom-0 z-10 flex flex-col gap-[var(--space-2)] bg-[image:var(--scrim-chrome)] pr-[max(var(--space-3),env(safe-area-inset-right))] pb-[max(var(--space-2),env(safe-area-inset-bottom))] pl-[max(var(--space-3),env(safe-area-inset-left))]", composing ? COMPOSING_SCRIM : "pt-[var(--space-6)]", FADE, fade)
    : "contents";
  const transportClass = imm ? "flex flex-col gap-[var(--space-2)]" : "flex flex-col gap-[var(--space-3)] max-[721px]:gap-0 max-[721px]:px-[var(--space-3)] max-[721px]:pb-[var(--space-1)]";
  const dockProps = imm ? { "data-testid": "video-immersive-dock", inert: !chromeVisible } : { "data-testid": "video-transport-dock" };
  const dockRef = useRef<HTMLDivElement | null>(null);
  // The composer floats a space above the scrubber, inside the scrim (F1): publish the controls' height without the scrim's top padding on the split row (the pane is the
  // player's sibling, not its child). The scrim's padding grows by the composer's height while it shows, so this stays the controls' own.
  useLayoutEffect(() => {
    if (!imm || !section) return undefined;
    const target = section.closest<HTMLElement>('[data-testid="video-review-split"]') ?? section.parentElement;
    if (!target) return undefined;
    const write = () => {
      const dock = dockRef.current;
      if (!dock) return;
      const scrimTop = Number.parseFloat(getComputedStyle(dock).paddingTop) || 0;
      target.style.setProperty("--immersive-controls-h", `${Math.max(0, dock.offsetHeight - scrimTop)}px`);
    };
    write();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
    if (observer && dockRef.current) observer.observe(dockRef.current);
    return () => { observer?.disconnect(); target.style.removeProperty("--immersive-controls-h"); };
  }, [imm, section, transportReplacement != null, composing]); // eslint-disable-line react-hooks/exhaustive-deps -- the dock is one node; the replacement changes its height, the composer its top padding
  const markerSelect = imm && immersive?.onMarkerTap ? immersive.onMarkerTap : onMarkerSelect;
  const noticeClass = imm ? "absolute inset-x-[var(--space-3)] top-[var(--space-7)] z-20" : "";

  return <section
    ref={(element) => { playerRef.current = element; setSection(element); }}
    aria-label="Player"
    data-testid="video-player"
    {...(imm ? { "data-immersive": "", "data-chrome": chromeVisible ? "shown" : "hidden" } : {})}
    tabIndex={-1}
    onKeyDown={keyboard === "self" ? (event) => { keyDown(event); } : undefined}
    onFocus={imm ? (event) => {
      setFocusHeld(keyboardInput.current);
      setPopupOpen(ownPopup(event.target as Element, event.currentTarget));
    } : undefined}
    onBlur={imm ? () => { setFocusHeld(false); setPopupOpen(false); } : undefined}
    onPointerMove={imm ? (event) => {
      if (event.pointerType === "touch") return;
      const now = Date.now();
      if (now - lastWake.current > 250) { lastWake.current = now; wake(); }
    } : undefined}
    onClick={imm ? (event) => {
      // A tap on the film shows or hides the controls and never plays or pauses (D13). Taps on the controls (the play badge among them) are theirs, and the pen and the composer keep the controls up.
      const target = event.target as Element;
      if (!target.closest('[data-testid="video-stage"]') || target.closest('[data-testid="video-play-badge"]') || composing || drawing) return;
      setChromeShown((shown) => !shown);
      setActivity((count) => count + 1);
    } : undefined}
    className={cn("group/player @container flex min-h-0 min-w-0 flex-col gap-[var(--space-3)] max-[721px]:gap-0 focus-visible:!outline-none [&:fullscreen]:bg-background [&:fullscreen]:p-[var(--space-4)]", imm && "relative flex-1 gap-0 bg-invert", className)}
  >
    <VideoStage streamUrl={version.streamUrl} title={title} width={version.width} height={version.height} timecode={timecode(clock.frame)} frame={clock.frame} frameSuffix={timeFormat !== "frames"} onVideo={setVideo} overlay={overlay} watermark={watermark} onMediaError={onMediaError} badge={badge} chip={!(imm && composing)} {...(social ? { social: { imageUrl: socialImage.imageUrl, onImageError: socialImage.onImageError, onImageLoad: socialImage.onImageLoad } } : {})} />

    {imm && immersive && <div data-testid="video-immersive-bar" inert={!chromeVisible} className={cn("absolute inset-x-0 top-0 z-10 flex items-center gap-[var(--space-2)] bg-[image:var(--scrim-chrome-top)] pt-[max(var(--space-2),env(safe-area-inset-top))] pr-[max(var(--space-3),env(safe-area-inset-right))] pb-[var(--space-5)] pl-[max(var(--space-3),env(safe-area-inset-left))] text-invert-foreground", FADE, fade)}>
      <IconTip label="Exit full screen">
        <Button type="button" variant="ghost" size="icon" aria-label="Exit full screen" data-testid="video-exit-fullscreen" className={cn("size-8 shrink-0", COARSE)} onClick={immersive.onToggle}><Minimize aria-hidden="true" /></Button>
      </IconTip>
      <span data-testid="video-immersive-title" title={immersive.heading} className="min-w-0 flex-1 truncate [font:var(--type-body)]">{immersive.heading}</span>
    </div>}
    {imm && immersive?.card != null && <div data-testid="video-immersive-card" inert={!chromeVisible} className={cn("pointer-events-none absolute inset-x-[var(--space-3)] top-[var(--space-7)] z-10 flex justify-center", FADE, fade)}><div className="pointer-events-auto w-full max-w-[var(--note-card-width)]">{immersive.card}</div></div>}
    {nativeFailed && <Notice tone="caution" role="alert" data-testid="video-native-failed" className={cn("bg-card", noticeClass)}>The system player couldn't open this film on this device.</Notice>}

    {/* The replacement sits ABOVE the transport, which stays mounted and hidden under it (#879 PR 2): unmounted, the slider came back as a new node, measured its thumb inside whatever
        box hid it next (a phone's Done lands in compose mode, where the transport is hidden) and drew no thumb until the frame moved. */}
    <div ref={dockRef} {...dockProps} className={dockClass}>
    {transportReplacement != null && <div className="flex flex-col justify-center" style={transportHeight.current !== null ? { minHeight: transportHeight.current } : undefined}>{transportReplacement}</div>}
    <div ref={transportRef} hidden={hidesTransport || transportReplacement != null} className={cn(transportClass, "[&[hidden]]:hidden")}>
    {/* The scrubber: the slider owns its step (one frame) and its keys. The pending band sits BEFORE it (the slider's Control paints over it, so the thumb stays on top); the marker lane sits under the track.
        A phone draws it as P1's `.scrub` band (#879 PR 3a): `--space-6` tall, the marker lane laid inside it along the top, the track through its middle, a 44px touch band from the slider's `band` size. */}
    <div data-testid="video-scrubber" className={handheld ? "relative h-[var(--space-6)]" : undefined} onPointerDownCapture={imm ? startScrub : undefined}>
      {/* The band is placed against the slider alone: inside the same box as the marker lane it would sit centred on the whole scrubber, 6px below the track. */}
      <div className={handheld ? "relative h-full" : "relative"}>
        {pendingRange !== undefined && <VideoPendingRangeBand range={pendingRange} frameCount={version.frameCount} />}
        <Slider
          value={[Math.min(shownFrame, Math.max(1, lastFrame))]}
          min={0}
          max={Math.max(1, lastFrame)}
          size={handheld ? "band" : "default"}
          step={1}
          disabled={transportLocked}
          largeStep={Math.max(1, Math.round(rationalToNumber(version.fps)))}
          onValueChange={(value) => { clock.seekToFrame(Array.isArray(value) ? (value[0] ?? 0) : value); }}
          thumbProps={{ getAriaLabel: () => "Timeline", getAriaValueText: (_formatted, value) => timecode(value) }}
        />
        {range !== undefined && !compact && <VideoRangeHandles marks={range.marks} frameCount={version.frameCount} label={timecode} largeStep={Math.max(1, Math.round(rationalToNumber(version.fps)))} interactive={marksTaken} onMove={moveHandle} onGrab={clock.pause} />}
      </div>
      {markers !== undefined && (!handheld || markers.length > 0) && <VideoTimelineMarkers markers={markers} frameCount={version.frameCount} touch={imm && handheld} {...(markerSelect ? { onSelect: markerSelect } : {})} {...(handheld ? { className: "absolute inset-x-0 top-0" } : {})} />}
    </div>

    <div data-testid="video-controls-row" className={cn("flex flex-wrap items-center gap-[var(--space-2)] max-[721px]:h-11 max-[721px]:flex-nowrap max-[721px]:gap-[var(--space-1)]", handheld && "h-11 flex-nowrap gap-[var(--space-1)]")}>
      {!compact && (!handheld || phoneFrameStep) && <IconTip label="Previous frame" keys="←">
        <Button type="button" variant={handheld ? "ghost" : "outline"} size="icon" aria-label="Previous frame" className={handheld ? PILL_ICON : COARSE} disabled={transportLocked} onClick={() => { clock.step(-1); }}><StepBack aria-hidden="true" /></Button>
      </IconTip>}
      <IconTip label={playLabel} keys="Space">
        <Button type="button" variant={handheld ? "ghost" : "default"} size="icon" aria-label={playLabel} className={handheld ? cn(PILL_ICON, PHONE_PLAY_SLOT) : cn("w-[var(--space-7)]", COARSE)} disabled={transportLocked} onClick={() => { if (clock.playing) clock.pause(); else clock.play(); }}>{clock.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
      </IconTip>
      {!compact && (!handheld || phoneFrameStep) && <IconTip label="Next frame" keys="→">
        <Button type="button" variant={handheld ? "ghost" : "outline"} size="icon" aria-label="Next frame" className={handheld ? PILL_ICON : COARSE} disabled={transportLocked} onClick={() => { clock.step(1); }}><StepForward aria-hidden="true" /></Button>
      </IconTip>}
      <output data-testid="video-readout" aria-live={clock.playing || !clock.confirmed ? "off" : "polite"} className={cn("px-[var(--space-2)] max-[721px]:min-w-0 max-[721px]:px-0 max-[721px]:text-xs max-[721px]:whitespace-nowrap", handheld && "min-w-0 px-0 text-xs whitespace-nowrap", MONO)}>
        <span>{timecode(clock.frame)}</span>{!handheld && <span data-testid="video-readout-total" className="text-foreground-secondary">{` / ${timecode(version.frameCount)}`}</span>}
      </output>
      {!phone && !compact && <OverlayContainerContext.Provider value={isFullscreen ? section : inheritedOverlay}><TimeFormatMenu /></OverlayContainerContext.Provider>}
      {social && !handheld && <OverlayContainerContext.Provider value={isFullscreen ? section : inheritedOverlay}><SocialPreviewControls social={social} imageFailed={socialImage.failed} /></OverlayContainerContext.Provider>}
      {!phone && !compact && range !== undefined && (() => {
        const rangeButton = <Button type="button" variant="outline" size="icon" aria-label={stepLabel} data-testid="video-range-button" data-step={step} className={COARSE} disabled={rangeLocked} onClick={pressRange}>
          {step === "in" ? <ArrowRightFromLine aria-hidden="true" /> : step === "out" ? <ArrowRightToLine aria-hidden="true" /> : <X aria-hidden="true" />}
        </Button>;
        // A disabled button gets no hover or focus, so its reason hangs on an enabled wrapper the tooltip can open from.
        if (rangeLocked && range.hint) return <IconTip label={range.hint}><span tabIndex={0} data-testid="video-range-tip" className="inline-flex rounded-[var(--radius-md)] focus-visible:ring-2 focus-visible:ring-ring">{rangeButton}</span></IconTip>;
        return <IconTip label={stepLabel} {...(rangeLocked ? {} : { keys: step === "clear" ? "I / O" : step === "in" ? "I" : "O" })}>{rangeButton}</IconTip>;
      })()}
      {!phone && !compact && <div data-testid="video-key-legend" className={LEGEND}>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>J</Kbd><Kbd className={LEGEND_KBD}>K</Kbd><Kbd className={LEGEND_KBD}>L</Kbd></KbdGroup>shuttle</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>←</Kbd><Kbd className={LEGEND_KBD}>→</Kbd></KbdGroup>frame</span>
        <span className="inline-flex items-center gap-[var(--space-1)]"><Kbd className={LEGEND_KBD}>Space</Kbd>play</span>
        {onMark && <span className="inline-flex items-center gap-[var(--space-1)]"><KbdGroup><Kbd className={LEGEND_KBD}>I</Kbd><Kbd className={LEGEND_KBD}>O</Kbd></KbdGroup>in/out</span>}
        {immersive && <span className="inline-flex items-center gap-[var(--space-1)]"><Kbd className={LEGEND_KBD}>F</Kbd>full screen</span>}
      </div>}
      {/* On a phone the 32px icons sit --space-3 apart, so their 44px hit areas meet without overlapping. */}
      <div className={cn("ml-auto flex items-center gap-[var(--space-1)] max-[721px]:gap-[var(--space-3)]", handheld && "gap-[var(--space-3)]")}>
        {transportActions}
        <IconTip label={muted ? "Unmute" : "Mute"}>
          <Toggle variant="default" size="default" pressed={muted} onPressedChange={toggleMuted} aria-label="Mute" className={handheld ? PILL_ICON : cn("size-8", COARSE)}>{muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</Toggle>
        </IconTip>
        {fullscreenButton}
        {/* F1's row ends Mute, Add note: the label shows on a phone too. */}
        {imm && immersive?.addNote && <IconTip label="Add note">
          <Button type="button" variant="outline" aria-label="Add note" aria-pressed={immersive.addNote.pressed} data-testid="video-immersive-add-note" className={cn(COARSE, "aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:!text-foreground")} onClick={immersive.addNote.onToggle}><SquarePen aria-hidden="true" /><span>Add note</span></Button>
        </IconTip>}
      </div>
    </div>
    {/* On a phone the overlay selector gets its own row, so it never sits on the timecode. */}
    {social && handheld && <div data-testid="video-social-row" className="flex flex-wrap items-center gap-[var(--space-2)]"><OverlayContainerContext.Provider value={isFullscreen ? section : inheritedOverlay}><SocialPreviewControls social={social} imageFailed={socialImage.failed} /></OverlayContainerContext.Provider></div>}
    </div>
    </div>
  </section>;
}
