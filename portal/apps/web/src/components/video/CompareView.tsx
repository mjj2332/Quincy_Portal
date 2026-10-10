import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { Pause, Play, RotateCcw, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { aOf, bOf, framesToTimecode, rationalToNumber, type Role, type VideoDto, type VideoVersionDto } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { usePictureBox } from "../../lib/use-picture-box";
import { useCompareTransport, type CompareSideHandle } from "../../lib/use-compare-transport";
import { usePlayerKeys } from "../../lib/use-player-keys";
import { useFrameClockSelector, useVideoFrameClock, type VideoFrameClock } from "../../lib/video-frame-clock";
import type { CompareSideId, CompareStore } from "../../lib/video-compare-store";
import type { NoteFormStore } from "../../lib/video-note-form-store";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { VideoStage } from "../quincy/VideoStage";
import { COARSE, IconTip, type VideoPlayerControl } from "../quincy/VideoPlayer";
import { VideoPendingRangeBand, VideoTimelineMarkers, type TimelineMarker } from "../quincy/VideoTimelineMarkers";
import { Badge } from "../reui/badge";
import { Button as UiButton } from "../reui/button";
import { Label } from "../reui/label";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "../reui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";
import { Slider } from "../reui/slider";
import { Spinner } from "../reui/spinner";
import { Toggle } from "../reui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { formatFps, formatVideoDate } from "./video-format";
import type { VideoNotesSession } from "./use-video-notes";

/** The notes sessions (one per side) and the single notes column are their own chunk, loaded only when the Project's notes part is on. */
const LazyNotesHost = lazy(() => import("./CompareNotesHost"));

export type CompareNotesProps = { projectId: string; role: Role; userId: string | null; archived: boolean; forms: NoteFormStore };
export type CompareNotesSlots = { a: VideoNotesSession; b: VideoNotesSession; panel: ReactNode };

const TOOL = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
// Every toolbar control is one height (the select trigger's 32px) so the row reads as one band; coarse pointers get the 44px floor via TOOL.
const BAR = cn(TOOL, "h-8");
const other = (id: CompareSideId): CompareSideId => (id === "a" ? "b" : "a");
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const sameRate = (a: VideoVersionDto, b: VideoVersionDto) => a.fps.num * b.fps.den === b.fps.num * a.fps.den;
const aspect = (v: VideoVersionDto) => v.width / v.height;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const versionLabel = (v: VideoVersionDto, newest: number) => `v${v.version}${v.version === newest ? " · latest" : ""} · ${v.uploadedBy.name} · ${formatVideoDate(v.createdAt)}`;

/**
 * The Version compare view (#741 7c): two stages, one transport (`CompareTransport` drives both `<video>`s; this view only calls it),
 * the shared scrubber, the offset, the sound side and, with notes on, one notes column with a tab per side. Side-by-side and wipe are
 * the same React tree: only CSS differs, so a mode switch never remounts a `<video>`. Not offered below 721px. Loaded lazily by the
 * review viewer, which never imports the transport.
 */
export default function CompareView({ video, store, startFrame, onChangeSide, controlRef, notes, detailsFor }: {
  video: VideoDto;
  store: CompareStore;
  /** A's frame on entry (the frame the single player showed). */
  startFrame: number;
  /** A side picked another Version. The viewer owns the pair; this view only asks. */
  onChangeSide: (side: CompareSideId, assetId: string) => void;
  controlRef: Ref<VideoPlayerControl>;
  notes?: CompareNotesProps;
  detailsFor: (version: VideoVersionDto) => ReactNode;
}) {
  const compare = useSyncExternalStore(store.subscribe, store.getState);
  const pair = compare.pair;
  const versionA = pair ? video.versions.find((candidate) => candidate.assetId === pair.a) : undefined;
  const versionB = pair ? video.versions.find((candidate) => candidate.assetId === pair.b) : undefined;
  // The notes sessions sit above the stages and reach the transport only through this bridge, filled in by the body.
  const seekBridge = useRef<(side: CompareSideId, frame: number) => void>(() => {});
  if (!versionA || !versionB) return null;
  const body = (slots: CompareNotesSlots | null) => <CompareBody video={video} store={store} startFrame={startFrame} versionA={versionA} versionB={versionB} onChangeSide={onChangeSide} controlRef={controlRef} slots={slots} seekBridge={seekBridge} />;
  return notes
    ? <Suspense fallback={null}><LazyNotesHost notes={notes} video={video} versionA={versionA} versionB={versionB} store={store} seekBridge={seekBridge} detailsFor={detailsFor}>{body}</LazyNotesHost></Suspense>
    : body(null);
}

function CompareBody({ video, store, startFrame, versionA, versionB, onChangeSide, controlRef, slots, seekBridge }: {
  video: VideoDto;
  store: CompareStore;
  startFrame: number;
  versionA: VideoVersionDto;
  versionB: VideoVersionDto;
  onChangeSide: (side: CompareSideId, assetId: string) => void;
  controlRef: Ref<VideoPlayerControl>;
  slots: CompareNotesSlots | null;
  seekBridge: { current: (side: CompareSideId, frame: number) => void };
}) {
  const compare = useSyncExternalStore(store.subscribe, store.getState);
  const position = useRef(startFrame);
  const [handles, setHandles] = useState<{ a: CompareSideHandle | null; b: CompareSideHandle | null }>({ a: null, b: null });
  const onHandleA = useCallback((handle: CompareSideHandle | null) => { setHandles((held) => (held.a === handle ? held : { ...held, a: handle })); }, []);
  const onHandleB = useCallback((handle: CompareSideHandle | null) => { setHandles((held) => (held.b === handle ? held : { ...held, b: handle })); }, []);
  const { transport, state } = useCompareTransport({ a: handles.a, b: handles.b, store, position, fpsA: versionA.fps, fpsB: versionB.fps, countA: versionA.frameCount, countB: versionB.frameCount });

  const newest = Math.max(...video.versions.map((candidate) => candidate.version));
  const versions: Record<CompareSideId, VideoVersionDto> = { a: versionA, b: versionB };
  const offset = state.offset;
  // Each side's own clock decides what its frame and last frame are: the mapping and the DTO's length are for the other side's position, not for what this one shows.
  const lastA = handles.a?.clock.lastFrame() ?? Math.max(0, versionA.frameCount - 1);
  const lastB = handles.b?.clock.lastFrame() ?? Math.max(0, versionB.frameCount - 1);
  const mappedB = clamp(bOf(state.frame, offset, versionA.fps, versionB.fps), 0, lastB);
  const shownA = useFrameClockSelector(handles.a?.clock ?? null, (c) => c.targetFrame ?? c.frame, clamp(state.frame, 0, lastA));
  const shownB = useFrameClockSelector(handles.b?.clock ?? null, (c) => c.targetFrame ?? c.frame, mappedB);
  const frameA = clamp(shownA, 0, lastA);
  const frameB = clamp(shownB, 0, lastB);
  const domainLength = state.domain.end - state.domain.start + 1;
  const timecodeOf = useCallback((version: VideoVersionDto, frame: number) => framesToTimecode(frame, { nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }, version.startTimecodeFrames ?? 0), []);

  // --- placing a stage that is mounting: where the shared position maps for it now ---
  const initialA = clamp(position.current, 0, lastA);
  const initialB = clamp(bOf(position.current, offset, versionA.fps, versionB.fps), 0, lastB);

  // --- the keyboard: the same keys as the single player, bound to the transport ---
  const stateRef = useRef(state);
  stateRef.current = state;
  const handlesRef = useRef(handles);
  handlesRef.current = handles;
  const active = compare.activeTab;
  const activeRef = useRef(active);
  activeRef.current = active;
  const markFrame = () => {
    const clock = handlesRef.current[activeRef.current]?.clock.getState();
    return clock ? (clock.playing ? clock.frame : (clock.targetFrame ?? clock.frame)) : 0;
  };
  const session = slots ? slots[active] : null;
  const markable = state.phases[active] === "live" || state.phases[active] === "last";
  const onMark = session && markable ? session.playerProps.onMark : undefined;
  const handleKeyDown = usePlayerKeys({
    rate: state.rate,
    play: () => { transport?.play(); },
    pause: () => { transport?.pause(); },
    setRate: (rate) => { transport?.play(rate); },
    reverse: (speed) => { transport?.reverse(speed); },
    step: (delta) => { transport?.step(delta); },
    home: () => { transport?.home(); },
    end: () => { transport?.end(); },
    markFrame,
  }, onMark);
  const currentFrame = useCallback(() => clamp(stateRef.current.frame, 0, lastA), [lastA]);
  useImperativeHandle(controlRef, () => ({ handleKeyDown, currentFrame }), [handleKeyDown, currentFrame]);

  // A note or marker click lands that side exactly, the other by mapping, and shows that side's notes.
  useEffect(() => {
    seekBridge.current = (target, frame) => { transport?.seekSide(target, frame); store.setActiveTab(target); };
    return () => { seekBridge.current = () => {}; };
  }, [seekBridge, transport, store]);

  // --- the offset ---
  const [offsetProblem, setOffsetProblem] = useState<string | null>(null);
  useEffect(() => { setOffsetProblem(null); }, [versionA.assetId, versionB.assetId]);
  // Committed on blur, Enter (Base UI commits on blur and the steppers only, so Enter re-enters through blur) or a stepper, never per keystroke. An empty field is a retype in progress, not an error: nothing applies and
  // the field falls back to the applied value on blur (the controlled `value` is unchanged, so Base UI restores it).
  const commitOffset = (next: number | null) => {
    if (!transport || next === null) return;
    if (next === offset) { setOffsetProblem(null); return; }
    const target = next;
    if (transport.setOffset(target)) { setOffsetProblem(null); return; }
    const bounds = transport.offsetBounds();
    setOffsetProblem(`Offset must be a whole number of frames between ${bounds.min} and ${bounds.max}.`);
  };

  // --- wipe geometry: over the union of both pictures, not the letterbox ---
  const boxA = usePictureBox(handles.a?.video ?? null, { width: versionA.width, height: versionA.height });
  const boxB = usePictureBox(handles.b?.video ?? null, { width: versionB.width, height: versionB.height });
  const union = boxA && boxB
    ? (() => {
        const left = Math.min(boxA.left, boxB.left);
        const top = Math.min(boxA.top, boxB.top);
        const right = Math.max(boxA.left + boxA.width, boxB.left + boxB.width);
        const bottom = Math.max(boxA.top + boxA.height, boxB.top + boxB.height);
        return { left, top, width: right - left, height: bottom - top };
      })()
    : null;
  const wipe = compare.wipe;
  const wipePercent = Math.round(wipe * 100);
  const clipLeft = union ? `${union.left + wipe * union.width}px` : `${Number((wipe * 100).toFixed(2))}%`;
  const wiping = compare.mode === "wipe";

  const jumpWipe = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    store.setWipe((event.clientX - rect.left) / rect.width);
  };
  const dragging = useRef(false);

  // --- scrubber and markers, all in the shared (A-frame) domain ---
  const sharedOf = (target: CompareSideId, frame: number) => (target === "a" ? frame : aOf(frame, offset, versionA.fps, versionB.fps));
  const mapMarkers = (target: CompareSideId, markers: readonly TimelineMarker[]): TimelineMarker[] => markers.map((marker) => ({
    ...marker,
    startFrame: sharedOf(target, marker.startFrame) - state.domain.start,
    endFrame: marker.endFrame === null ? null : sharedOf(target, marker.endFrame) - state.domain.start,
  }));
  const pending = session?.pendingRange ?? null;
  const mappedPending = pending ? { startFrame: sharedOf(active, pending.startFrame) - state.domain.start, endFrame: pending.endFrame === null ? null : sharedOf(active, pending.endFrame) - state.domain.start } : null;
  const scrubberValue = clamp(state.frame - state.domain.start, 0, Math.max(1, domainLength - 1));
  const labels = { a: `v${versionA.version}`, b: `v${versionB.version}` };

  const rateDiffers = !sameRate(versionA, versionB);
  const aspectDiffers = Math.abs(aspect(versionA) / aspect(versionB) - 1) > 0.01;

  const startsIn = (target: CompareSideId) => Math.max(0, (target === "a" ? 0 : aOf(0, offset, versionA.fps, versionB.fps)) - state.frame);
  const playLabel = state.playing ? "Pause" : "Play";
  const ready = transport !== null;
  const heard = state.phases; // (kept for the stage badges below)

  const sideSelect = (target: CompareSideId) => {
    const mine = versions[target];
    const theirs = versions[other(target)];
    const id = `video-compare-select-${target}`;
    return <div className="flex min-w-36 max-w-[22rem] flex-[1_1_0] items-center gap-[var(--space-2)]">
      <Label htmlFor={id} className="shrink-0 text-foreground-secondary">{labels[target]}</Label>
      <Select value={mine.assetId} onValueChange={(next) => { if (typeof next === "string" && next !== mine.assetId) onChangeSide(target, next); }}>
        <SelectTrigger id={id} data-testid={id} className={cn(BAR, "min-w-0 max-w-full")}>
          <SelectValue>{() => <span className="block truncate">{versionLabel(mine, newest)}</span>}</SelectValue>
        </SelectTrigger>
        <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
          {video.versions.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} disabled={candidate.assetId === theirs.assetId} className={TOOL}>{versionLabel(candidate, newest)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>;
  };

  const stage = (target: CompareSideId) => <SideStage
    key={`${target}:${versions[target].assetId}`}
    side={target}
    version={versions[target]}
    title={`${video.title}, version ${versions[target].version}`}
    label={labels[target]}
    initialFrame={target === "a" ? initialA : initialB}
    phase={heard[target]}
    startsIn={startsIn(target)}
    buffering={state.stalled === target}
    timecode={(frame) => timecodeOf(versions[target], frame)}
    onHandle={target === "a" ? onHandleA : onHandleB}
    onClockChange={slots ? slots[target].playerProps.onClockChange : undefined}
    labelCorner={wiping && target === "b" ? "top-right" : "top-left"}
    cellClassName={wiping ? "[grid-area:stack]" : undefined}
    cellStyle={wiping && target === "b" ? { clipPath: `inset(0 0 0 ${clipLeft})` } : undefined}
  />;

  // The stages take the height their pictures need (the taller of the two shapes, side by side counting two of them), so the scrubber
  // sits just under the pictures like the single player's, and the room left over falls below it. They still shrink to fit a short window.
  const narrowest = Math.min(aspect(versionA), aspect(versionB));
  const stagesRatio = wiping ? narrowest : narrowest * 2;
  const wipeSliderLabel = `Wipe between ${labels.a} and ${labels.b}`;
  return <div data-testid="video-compare" data-mode={compare.mode} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)] p-[var(--space-5)]">
      <div data-testid="video-compare-toolbar" className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
        {sideSelect("a")}
        {sideSelect("b")}
        <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="Layout" value={[compare.mode]} onValueChange={(next) => { const picked = next[0]; if (picked === "side-by-side" || picked === "wipe") store.setMode(picked); }}>
          <ToggleGroupItem value="side-by-side" data-testid="video-compare-mode-side-by-side" className={BAR}>Side by side</ToggleGroupItem>
          <ToggleGroupItem value="wipe" data-testid="video-compare-mode-wipe" className={BAR}>Wipe</ToggleGroupItem>
        </ToggleGroup>
        <span className="flex items-center gap-[var(--space-2)]">
        <span id="video-compare-sound-label" data-testid="video-compare-sound-label" className="shrink-0 text-foreground-secondary [font:var(--type-label)]">Sound</span>
        <ToggleGroup variant="outline" size="sm" spacing={0} aria-labelledby="video-compare-sound-label" value={[compare.audible]} onValueChange={(next) => { const picked = next[0]; if (picked === "a" || picked === "b") transport?.setAudible(picked); }}>
          {(["a", "b"] as const).map((target) => <ToggleGroupItem key={target} value={target} disabled={!versions[target].hasAudio} data-testid={`video-compare-sound-${target}`} className={BAR}>{labels[target]}{!versions[target].hasAudio && <span className="ms-[var(--space-1)] text-foreground-secondary">No audio</span>}</ToggleGroupItem>)}
        </ToggleGroup>
        </span>
        <IconTip label={compare.muted ? "Unmute" : "Mute"}>
          <Toggle variant="default" size="default" pressed={compare.muted} onPressedChange={(next) => { transport?.setMuted(next); }} aria-label="Mute" className={cn("size-8", COARSE)}>{compare.muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</Toggle>
        </IconTip>
        {slots && <Toggle variant="outline" size="sm" pressed={compare.notesOpen} onPressedChange={(next) => { store.setNotesOpen(next); }} aria-label="Notes" data-testid="video-compare-notes-toggle" className={cn(BAR, "shrink-0")}>Notes</Toggle>}
      </div>

      <div className="flex flex-wrap items-end gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
        <NumberField value={offset} onValueCommitted={commitOffset} step={1} smallStep={1} largeStep={10} disabled={!ready} className="max-w-40">
          <Label htmlFor="video-compare-offset" className="text-foreground-secondary">Offset (frames)</Label>
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label="One frame earlier" />
            <NumberFieldInput id="video-compare-offset" data-testid="video-compare-offset" onKeyDown={(event) => {
              // Enter takes the field's own blur path (its parser, formatting and commit), then gives focus back.
              if (event.key !== "Enter") return;
              const input = event.currentTarget;
              input.blur();
              input.focus();
            }} />
            <NumberFieldIncrement aria-label="One frame later" />
          </NumberFieldGroup>
        </NumberField>
        <IconTip label="Reset offset">
          <UiButton type="button" variant="ghost" size="icon" aria-label="Reset offset" data-testid="video-compare-offset-reset" className={COARSE} disabled={!ready || offset === 0} onClick={() => { commitOffset(0); }}><RotateCcw aria-hidden="true" /></UiButton>
        </IconTip>
        <span data-testid="video-compare-offset-help" className="text-foreground-secondary [font:var(--type-label)]">{`e.g. +12: ${labels.b} starts 12 frames after ${labels.a}`}</span>
      </div>

      {offsetProblem && <div data-surface="default"><Notice tone="caution" className="bg-card" role="status" data-testid="video-compare-offset-notice">{offsetProblem}</Notice></div>}
      {rateDiffers && <div data-surface="default"><Notice tone="caution" className="bg-card" role="status" data-testid="video-compare-rate-notice">{`${labels.a} and ${labels.b} have different frame rates (${formatFps(versionA.fps)} and ${formatFps(versionB.fps)} fps). The sides are matched by time, so frames will not line up one for one.`}</Notice></div>}
      {aspectDiffers && <div data-surface="default"><Notice tone="caution" className="bg-card" role="status" data-testid="video-compare-aspect-notice">{`${labels.a} and ${labels.b} have different aspect ratios. Each is shown whole, never stretched or cropped.`}</Notice></div>}
      {state.blocked === "gesture" && <div data-surface="default"><Notice tone="caution" className="bg-card" role="status" data-testid="video-compare-blocked">Press Play to continue.</Notice></div>}
      {state.blocked === "recovery" && <div data-surface="default"><Notice tone="caution" role="status" data-testid="video-compare-blocked" className="flex flex-wrap items-center justify-between gap-[var(--space-2)] bg-card"><span>Playback stopped because a video kept buffering.</span><Button type="button" variant="text" className={TOOL} onClick={() => { transport?.play(); }}>Resume</Button></Notice></div>}

      <div data-testid="video-compare-stages" style={{ aspectRatio: stagesRatio }} className={cn("relative grid min-h-0 flex-[0_1_auto] grid-rows-[minmax(0,1fr)] gap-[var(--space-3)]", wiping ? "[grid-template-areas:'stack'] grid-cols-[minmax(0,1fr)] gap-0" : "grid-cols-2")}>
        {stage("a")}
        {stage("b")}
        {wiping && <div
          data-testid="video-compare-wipe-surface"
          className="absolute z-10 touch-none"
          style={union ? { left: union.left, top: union.top, width: union.width, height: union.height } : { inset: 0 }}
          onPointerDown={(event) => {
            if (event.target instanceof Element && event.target.closest('[data-slot="slider"]')) return;
            dragging.current = true;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer has nothing to capture */ }
            jumpWipe(event);
          }}
          onPointerMove={(event) => { if (dragging.current) jumpWipe(event); }}
          onPointerUp={(event) => { dragging.current = false; try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* as above */ } }}
          onPointerCancel={() => { dragging.current = false; }}
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-invert-foreground shadow-[0_0_0_1px_var(--background)]" style={{ left: `${Number((wipe * 100).toFixed(2))}%` }} />
          <Slider
            className="absolute top-1/2 left-[calc(-1*var(--thumb-half))] right-[calc(-1*var(--thumb-half))] data-[orientation=horizontal]:w-auto -translate-y-1/2 [--thumb-half:6px] pointer-coarse:[--thumb-half:8px] [&_[data-slot=slider-track]]:opacity-0 [&_[data-slot=slider-thumb]]:shadow-[0_0_0_2px_var(--background)] pointer-coarse:[&_[data-slot=slider-thumb]]:after:-inset-3.5"
            value={[wipePercent]}
            min={0}
            max={100}
            step={1}
            largeStep={10}
            onValueChange={(value) => { store.setWipe((Array.isArray(value) ? (value[0] ?? 0) : value) / 100); }}
            thumbProps={{ getAriaLabel: () => wipeSliderLabel, getAriaValueText: (_formatted, value) => `${labels.a} ${value}% · ${labels.b} ${100 - value}%` }}
          />
        </div>}
      </div>

      <div className="flex flex-col gap-[var(--space-3)]">
        <div data-testid="video-compare-scrubber">
          <div className="relative">
            {mappedPending && <VideoPendingRangeBand range={mappedPending} frameCount={domainLength} />}
            <Slider
              value={[scrubberValue]}
              min={0}
              max={Math.max(1, domainLength - 1)}
              step={1}
              largeStep={Math.max(1, Math.round(rationalToNumber(versionA.fps)))}
              disabled={!ready}
              onValueChange={(value) => { transport?.seekTo(state.domain.start + (Array.isArray(value) ? (value[0] ?? 0) : value)); }}
              thumbProps={{ getAriaLabel: () => "Timeline", getAriaValueText: (_formatted, value) => `${labels.a} ${timecodeOf(versionA, clamp(state.domain.start + value, 0, lastA))}` }}
            />
          </div>
          {slots && <>
            <VideoTimelineMarkers markers={mapMarkers("a", slots.a.markers)} frameCount={domainLength} onSelect={slots.a.playerProps.onMarkerSelect} />
            <VideoTimelineMarkers markers={mapMarkers("b", slots.b.markers)} frameCount={domainLength} onSelect={slots.b.playerProps.onMarkerSelect} />
          </>}
        </div>
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <IconTip label="Previous frame" keys="←">
            <UiButton type="button" variant="outline" size="icon" aria-label="Previous frame" className={COARSE} disabled={!ready} onClick={() => { transport?.step(-1); }}><StepBack aria-hidden="true" /></UiButton>
          </IconTip>
          <IconTip label={playLabel} keys="Space">
            <UiButton type="button" variant="default" size="icon" aria-label={playLabel} className={cn("w-[var(--space-7)]", COARSE)} disabled={!ready} onClick={() => { if (state.playing) transport?.pause(); else transport?.play(); }}>{state.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</UiButton>
          </IconTip>
          <IconTip label="Next frame" keys="→">
            <UiButton type="button" variant="outline" size="icon" aria-label="Next frame" className={COARSE} disabled={!ready} onClick={() => { transport?.step(1); }}><StepForward aria-hidden="true" /></UiButton>
          </IconTip>
          <output data-testid="video-compare-readout" aria-live={state.playing ? "off" : "polite"} className="flex flex-wrap gap-x-[var(--space-3)] px-[var(--space-2)] [font:var(--type-mono)] tabular-nums">
            <span>{`${labels.a} ${timecodeOf(versionA, frameA)}`}</span>
            <span className="text-foreground-secondary">{`${labels.b} ${timecodeOf(versionB, frameB)}`}</span>
          </output>
        </div>
      </div>
    </div>

    {slots && compare.notesOpen && slots.panel}
  </div>;
}

/** One side: its stage (own `<video>`, own clock), the version and phase badges, and the buffering line. Keyed by side and Version by the body. */
function SideStage({ side: id, version, title, label, initialFrame, phase, startsIn, buffering, timecode, onHandle, onClockChange, labelCorner, cellClassName, cellStyle }: {
  side: CompareSideId;
  version: VideoVersionDto;
  title: string;
  label: string;
  initialFrame: number;
  phase: "before" | "live" | "last" | "after";
  startsIn: number;
  buffering: boolean;
  timecode: (frame: number) => string;
  onHandle: (handle: CompareSideHandle | null) => void;
  onClockChange?: ((clock: VideoFrameClock | null) => void) | undefined;
  labelCorner: "top-left" | "top-right";
  cellClassName?: string | undefined;
  cellStyle?: React.CSSProperties | undefined;
}) {
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const clock = useVideoFrameClock(element, version, { initialFrame });
  const instance = clock.instance;
  const { fps, frameCount, hasAudio } = version;
  useEffect(() => {
    if (!element || !instance) return;
    onHandle({ video: element, clock: instance, fps, frameCount, hasAudio });
    return () => { onHandle(null); };
  }, [element, instance, fps, frameCount, hasAudio, onHandle]);
  const onClockChangeRef = useRef(onClockChange);
  onClockChangeRef.current = onClockChange;
  useEffect(() => {
    onClockChangeRef.current?.(instance);
    return () => { onClockChangeRef.current?.(null); };
  }, [instance]);

  return <div data-compare-cell={id} data-phase={phase} style={cellStyle} className={cn("relative flex h-full min-h-0 min-w-0 flex-col", cellClassName)}>
    <VideoStage streamUrl={version.streamUrl} title={title} width={version.width} height={version.height} timecode={timecode(clock.frame)} frame={clock.frame} onVideo={setElement} overlay={(box) => <>
      <div data-testid="video-compare-side-labels" data-corner={labelCorner} className="pointer-events-none absolute" style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { inset: 0 }}>
        <div className={cn("absolute top-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-1)]", labelCorner === "top-right" ? "right-[var(--space-2)] justify-end" : "left-[var(--space-2)]")}>
          <Badge variant="invert">{label}</Badge>
          {phase === "before" && <Badge variant="secondary">{`Starts in ${plural(startsIn, "frame")}`}</Badge>}
          {phase === "after" && <Badge variant="secondary">Ended</Badge>}
        </div>
      </div>
    </>} />
    <div aria-live="polite" className="pointer-events-none absolute right-[var(--space-2)] bottom-[var(--space-2)]">
      {buffering && <span className="inline-flex items-center gap-[var(--space-1)] border border-invert-foreground/20 bg-invert px-[var(--space-2)] py-[var(--space-1)] text-invert-foreground [font:var(--type-label)]"><Spinner className="size-3" />{`Buffering ${label}…`}</span>}
    </div>
  </div>;
}

