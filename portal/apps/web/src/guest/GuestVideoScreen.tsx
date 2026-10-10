import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight, MessageSquare } from "lucide-react";
import { framesToTimecode, type Box, type GuestNoteThreadDto, type GuestVideoDto } from "@quincy/shared";
import { useMediaQuery } from "../lib/use-media-query";
import type { VideoFrameClock } from "../lib/video-frame-clock";
import { Button } from "../components/reui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/reui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/reui/sheet";
import { VideoPlayer, type VideoPlayerControl } from "../components/quincy/VideoPlayer";
import type { TimelineMarker } from "../components/quincy/VideoTimelineMarkers";
import type { GuestApi } from "./guest-api";
import { GuestNotesPanel } from "./GuestNotesPanel";
import { useGuestMarkup } from "./GuestMarkup";
import { PremiumWatermark } from "./PremiumWatermark";

const VERSION_SELECT_ID = "guest-version";
const FIELD = "input, textarea, select, [contenteditable], [role=listbox], [role=combobox]";
const NOTES_HEADING = "m-0 text-foreground [font:var(--type-h3)]";
const POPUP = "[role=dialog], [role=menu], [role=listbox], [role=combobox]";
const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/** `[` and `]` step through the videos unless a field, list or modifier owns the key. */
function useVideoStepKeys(onStep: (delta: -1 | 1) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key !== "[" && event.key !== "]") return;
      if (event.target instanceof Element && event.target.closest(FIELD)) return;
      onStep(event.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [onStep]);
}

/** The player's keys (J / K / L, Space, arrows, Home / End) from anywhere on the screen, so they keep working once focus has moved to a note's anchor. Fields and popups keep their own keys. */
function usePlayerKeysFromScreen(player: RefObject<VideoPlayerControl | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest(`${FIELD}, ${POPUP}`)) return;
      player.current?.handleKeyDown(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [player]);
}

/**
 * One Video on the guest page (#741 12b), read-only: the reused review player on the inverse surface, the granted-Versions select, previous / next Video, and the public notes (a
 * column beside the player, a bottom drawer below 721px). Moving between Videos never returns to the list. State is in memory; the URL does not change.
 */
export function GuestVideoScreen({ api, videos, index, onIndex, onBack, onUnavailable }: {
  api: GuestApi;
  videos: readonly GuestVideoDto[];
  index: number;
  onIndex: (next: number) => void;
  /** Present only when there is a list to go back to (a single-Video link has none). */
  onBack: (() => void) | null;
  onUnavailable: () => void;
}) {
  const video = videos[index]!;
  const [assetId, setAssetId] = useState(video.versions[0]!.assetId);
  // A different Video starts on its latest granted Version.
  useEffect(() => { setAssetId(video.versions[0]!.assetId); }, [video]);
  const version = video.versions.find((candidate) => candidate.assetId === assetId) ?? video.versions[0]!;

  const [threads, setThreads] = useState<GuestNoteThreadDto[] | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);
  const [selectionCount, setSelectionCount] = useState(0);
  const [notesAttempt, setNotesAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState<VideoFrameClock | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const phone = useMediaQuery("(max-width: 720px)");

  useEffect(() => {
    let live = true;
    setThreads(null); setSelectedId(null); setNotesFailed(false);
    void api.notes(version.assetId).then((result) => {
      if (!live) return;
      if (result.kind === "gone") onUnavailable();
      else if (result.kind === "transient") setNotesFailed(true);
      else setThreads(result.value);
    });
    return () => { live = false; };
  }, [api, version.assetId, notesAttempt, onUnavailable]);

  // A stream that fails mid-play (a seek needing another range request) may mean staff revoked the link. The player has already shown its own notice; recheck access, and leave only if it is gone.
  const onMediaError = useCallback(() => { void api.session().then((result) => { if (result.kind === "gone") onUnavailable(); }); }, [api, onUnavailable]);

  const step = useCallback((delta: -1 | 1) => { const next = index + delta; if (next >= 0 && next < videos.length) onIndex(next); }, [index, videos.length, onIndex]);
  useVideoStepKeys(step);
  const playerRef = useRef<VideoPlayerControl>(null);
  usePlayerKeysFromScreen(playerRef);

  const base = useMemo(() => ({ nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }), [version.tcNominalFps, version.tcDropFrame]);
  const timecode = useCallback((frame: number) => framesToTimecode(frame, base, version.startTimecodeFrames ?? 0), [base, version.startTimecodeFrames]);
  const markers = useMemo<TimelineMarker[]>(() => (threads ?? []).filter((thread) => thread.startFrame !== null && !thread.deleted)
    .map((thread) => ({ id: thread.id, startFrame: thread.startFrame!, endFrame: thread.endFrame, tone: "public" as const, selected: thread.id === selectedId, createdAt: thread.createdAt })), [threads, selectedId]);
  const selected = threads?.find((thread) => thread.id === selectedId) ?? null;
  const select = useCallback((thread: GuestNoteThreadDto) => {
    setSelectedId(thread.id);
    setSelectionCount((n) => n + 1);
    // A drawing shows only on the exact frame it was drawn on, which can sit anywhere inside the note's range: seek there, else to the anchor.
    const frame = thread.hasMarkup && thread.drawingFrame !== null ? thread.drawingFrame : thread.startFrame;
    if (frame !== null) clock?.seekToFrame(frame);
    setDrawerOpen(false);
  }, [clock]);
  const markupOverlay = useGuestMarkup(api, clock, selected, onUnavailable, selectionCount);
  const watermark = video.premium && !video.unlocked;
  const overlay = useCallback((box: Box | null) => <>{watermark && box && <PremiumWatermark box={box} />}{markupOverlay(box)}</>, [watermark, markupOverlay]);

  const newest = video.versions[0]!.version;
  const optionLabel = (candidate: GuestVideoDto["versions"][number]) => `v${candidate.version}${candidate.version === newest ? " · latest" : ""}`;
  const headingContent = <>Notes{threads !== null && <><span className="sr-only"> </span><span data-testid="guest-notes-count" className="ms-[var(--space-1)] text-foreground-secondary [font:var(--type-label)]">{threads.length}</span></>}</>;
  const heading = <h2 data-testid="guest-notes-heading" className={NOTES_HEADING}>{headingContent}</h2>;
  const panel = <GuestNotesPanel threads={threads} failed={notesFailed} onRetry={() => { setNotesAttempt((n) => n + 1); }} selectedId={selectedId} onSelect={select} timecode={timecode} header={phone ? undefined : heading} />;

  return <div data-testid="guest-video-screen" data-surface="inverse" className="flex min-h-dvh flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)] border-b border-border bg-card px-[var(--space-5)] py-[var(--space-3)] text-card-foreground">
      {onBack && <Button type="button" variant="ghost" className={TOUCH} onClick={onBack}><ChevronLeft aria-hidden="true" />All videos</Button>}
      <h1 data-testid="guest-video-title" className="m-0 min-w-[160px] flex-1 truncate text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{video.title}</h1>
      <div className="flex min-w-0 items-center gap-[var(--space-4)] max-[721px]:basis-full max-[721px]:gap-[var(--space-2)] min-[721px]:contents">
      {videos.length > 1 && <div className="flex items-center gap-[var(--space-2)]">
        <Button type="button" variant="outline" size="icon" aria-label="Previous video" className={TOUCH} disabled={index === 0} onClick={() => { step(-1); }}><ChevronLeft aria-hidden="true" /></Button>
        <span data-testid="guest-video-position" className="text-foreground-secondary tabular-nums [font:var(--type-label)]">{`${index + 1} of ${videos.length}`}</span>
        <Button type="button" variant="outline" size="icon" aria-label="Next video" className={TOUCH} disabled={index === videos.length - 1} onClick={() => { step(1); }}><ChevronRight aria-hidden="true" /></Button>
      </div>}
      <div className="flex min-w-0 max-w-full items-center gap-[var(--space-2)] max-[721px]:flex-1">
        <label htmlFor={VERSION_SELECT_ID} className="shrink-0 text-foreground-secondary [font:var(--type-label)] max-[721px]:sr-only">Version</label>
        <Select value={version.assetId} onValueChange={(next) => { if (typeof next === "string") setAssetId(next); }}>
          <SelectTrigger id={VERSION_SELECT_ID} data-testid="guest-version-trigger" className={`${TOUCH} min-w-0 max-w-full`}>
            <SelectValue>{() => <span className="block truncate">{optionLabel(version)}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {video.versions.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} className={TOUCH}>{optionLabel(candidate)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {phone && <Button type="button" variant="outline" aria-label={threads === null ? "Notes" : `Notes, ${threads.length}`} className={`${TOUCH} shrink-0`} onClick={() => { setDrawerOpen(true); }}><MessageSquare aria-hidden="true" />{threads !== null && <span className="[font:var(--type-label)]">{threads.length}</span>}</Button>}
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-wrap min-[721px]:flex-nowrap">
      <div className="flex min-h-0 min-w-0 flex-[999_1_640px] flex-col p-[var(--space-5)] min-[721px]:flex-1">
        <VideoPlayer key={version.assetId} controlRef={playerRef} keyboard="host" version={version} title={`${video.title}, version ${version.version}`} className="flex-1" markers={markers} onMarkerSelect={(id) => { const thread = threads?.find((candidate) => candidate.id === id); if (thread) select(thread); }} onClockChange={setClock} overlay={overlay} onMediaError={onMediaError} />
      </div>
      {!phone && <aside data-surface="default" className="flex flex-[1_1_360px] flex-col border-l border-border bg-card p-[var(--space-5)] text-card-foreground min-[721px]:max-h-dvh min-[721px]:flex-[0_0_clamp(240px,28vw,360px)]">{panel}</aside>}
    </div>
    {phone && <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <SheetContent side="bottom" data-testid="guest-notes-drawer" className="max-h-[80dvh] p-[var(--space-4)]">
        <SheetHeader className="p-0"><SheetTitle data-testid="guest-notes-heading" className={NOTES_HEADING}>{headingContent}</SheetTitle></SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{panel}</div>
      </SheetContent>
    </Sheet>}
  </div>;
}
