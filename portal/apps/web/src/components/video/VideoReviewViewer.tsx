import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Columns2 } from "lucide-react";
import { framesToTimecode, type Role, type VideoDto, type VideoVersionDto } from "@quincy/shared";
import { hasOpenAlertDialog } from "../../lib/alert-dialog-press";
import { useMediaQuery } from "../../lib/use-media-query";
import type { CompareSideId, CompareStore } from "../../lib/video-compare-store";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Button } from "../reui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../reui/dialog";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";
import { hasOpenFloatingPopup, hasOpenModalAbove } from "../quincy/project-sheet-layers";
import { VideoPlayer, type VideoPlayerControl } from "../quincy/VideoPlayer";
import { formatBytes, formatDuration, formatFps, formatVideoDate } from "./video-format";
import type { NoteFormStore } from "../../lib/video-note-form-store";
import type { VideoNotesSession } from "./use-video-notes";

/** The notes UI is its own chunk: a Project whose notes part is off never loads it. */
const LazyNotesHost = lazy(() => import("./VideoNotesHost"));
/** Compare (#741 7c) is its own chunk too, and the viewer never imports the transport: only a Project whose `compare` part is on, and only when a reviewer opens it. */
const loadCompare = () => import("./CompareView");
const LazyCompareView = lazy(loadCompare);
const preloadCompare = (withNotes: boolean) => { void loadCompare(); if (withNotes) void import("./CompareNotesHost"); };
/** Compare needs room for two pictures: below this the viewer is the single player, and the Compare button is not offered. */
const PHONE_QUERY = "(max-width: 721px)";

const VERSION_SELECT_ID = "video-review-version";

/**
 * The staff review viewer (#741 4d-ii): a collection-local, full-viewport dialog on the inverse surface that plays one Video, one
 * Version at a time. It changes no URL. The dialog popup owns the keyboard scope, so the shortcuts never reach the Project sheet
 * underneath and stop when it closes; the player's own handler does the work. Switching Version remounts the player (keyed by
 * Asset id): paused, at frame 0, with that Version's own clock, timecode and streaming URL. A superseded Version still plays.
 * With `notes` (the Project's `notes` part is on, #741 5b) the Version details column becomes the notes panel, and the Version details
 * move behind a button in its header; without it the viewer is exactly the 4d-ii viewer.
 */
export function VideoReviewViewer({ video, onClose, returnFocusTo, notes, compare }: {
  video: VideoDto;
  onClose: () => void;
  /** The control that opened the viewer; focus goes back to it on close. */
  returnFocusTo?: () => HTMLElement | null;
  /** Present only when the notes part is on. */
  notes?: { projectId: string; role: Role; userId: string | null; archived: boolean; forms: NoteFormStore; /** The Project's `markup` part is on (#741 6b-ui). */ markup?: boolean };
  /** Present only when the Project's `compare` part is on (#741 7c). */
  compare?: { store: CompareStore };
}) {
  const [assetId, setAssetId] = useState(video.currentAssetId);
  const playerRef = useRef<VideoPlayerControl>(null);
  const compareRef = useRef<VideoPlayerControl>(null);
  const compareButtonRef = useRef<HTMLButtonElement | null>(null);
  const compareStore = compare?.store;
  const [mode, setMode] = useState<"single" | "compare">("single");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Where the compare view opens A (the single player's frame), and where the single player reopens after it (A's frame).
  const [startFrame, setStartFrame] = useState(0);
  const [resume, setResume] = useState<{ assetId: string; frame: number } | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const canCompare = compareStore !== undefined && video.versions.length >= 2 && !phone;
  // Focus opens on the dialog itself, not its first button: Space on the Video button would close it (and the player leaves Space to a focused button).
  const popupRef = useRef<HTMLDivElement | null>(null);
  // Base UI moves focus a frame after mount; a key typed in that gap (Enter, then Space) would still hit the opener. Take focus in the commit itself.
  const takePopup = useCallback((element: HTMLDivElement | null) => { popupRef.current = element; element?.focus({ preventScroll: true }); }, []);
  // The Project sheet's overlay slot sits under this dialog: popups opened in here (Version, tooltips) portal into a slot of the dialog's own.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const notesOn = notes !== undefined;
  // Escape order with the notes panel (#741 5b), decided from a snapshot taken at keydown, before any handler has run: Base UI reports one
  // Escape to `onOpenChange` more than once, so the answer cannot come from state the first call changed (the ProjectSheet note).
  // 1. an open menu, popover, list, confirm or modal dialog owns it; 2. the form store decides for the Version's form (draw mode first: a confirmation is cancelled, or
  // drawing ends and the strokes stay; then a frame confirmation is cancelled, a clean edit or reply closes, a dirty form or the composer keeps its text on the first Escape);
  // 3. only then does it close the viewer.
  const forms = notes?.forms;
  const escapeSnapshot = useRef({ layer: false, form: false, compare: false });
  const exitCompare = useCallback((focus: "button" | "dialog") => {
    if (modeRef.current !== "compare") return;
    const frame = compareRef.current?.currentFrame();
    const pairA = compareStore?.getState().pair?.a;
    if (frame !== undefined && pairA !== undefined) setResume({ assetId: pairA, frame });
    modeRef.current = "single";
    setMode("single");
    if (focus === "button" && compareButtonRef.current?.isConnected) compareButtonRef.current.focus({ preventScroll: true });
    else popupRef.current?.focus({ preventScroll: true });
  }, [compareStore]);
  const compareEnabled = compareStore !== undefined;
  useEffect(() => {
    if (!(notesOn && forms) && !compareEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const popup = popupRef.current;
      // A modal dialog opened from the panel (the notes paste dialog) is not a floating popup but owns Escape just the same.
      const layer = hasOpenAlertDialog() || hasOpenFloatingPopup(popup, slot) || hasOpenModalAbove(popup, document);
      if (layer || popup === null) { escapeSnapshot.current = { layer, form: false, compare: false }; return; }
      const active = document.activeElement;
      let consumed = false;
      if (notesOn && forms) {
        // In compare the form belongs to the side whose panel holds focus (else the side whose tab is showing).
        const pair = compareStore?.getState().pair;
        const sideOf = active instanceof Element ? active.closest("[data-compare-side]")?.getAttribute("data-compare-side") : null;
        const formSide: CompareSideId = sideOf === "a" || sideOf === "b" ? sideOf : (compareStore?.getState().activeTab ?? "a");
        const formAsset = modeRef.current === "compare" && pair ? pair[formSide] : assetId;
        const result = forms.escape(formAsset, { focusInForm: active instanceof Element && popup.contains(active) && active.closest("[data-notes-form]") !== null });
        consumed = result.consumed;
        if (result.focus === "dialog") popup.focus({ preventScroll: true });
        // focus === "draw": the pill is still expanded here, so the overlay returns focus to its Draw button itself once drawing has ended.
        else if (result.focus === "textarea") (popup.querySelector<HTMLElement>('[data-notes-form="edit"] textarea, [data-notes-form="reply"] textarea') ?? popup.querySelector<HTMLElement>("#video-note-body"))?.focus({ preventScroll: true });
      }
      escapeSnapshot.current = { layer, form: consumed, compare: !consumed && modeRef.current === "compare" };
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); escapeSnapshot.current = { layer: false, form: false, compare: false }; };
  }, [notesOn, forms, assetId, slot, compareEnabled, compareStore]);
  const handleOpenChange = (open: boolean, details: { reason: string; cancel: () => void; allowPropagation: () => void }) => {
    if (open) return;
    if (details.reason === "escape-key") {
      const snapshot = escapeSnapshot.current;
      if (snapshot.layer) { details.cancel(); details.allowPropagation(); return; }
      if (snapshot.form) { details.cancel(); return; }
      if (snapshot.compare) { details.cancel(); exitCompare("button"); return; }
    }
    onClose();
  };

  // Compare is not offered below 721px: crossing it leaves for the single view on A, with focus on the dialog (the button is gone).
  useEffect(() => { if (phone && mode === "compare") exitCompare("dialog"); }, [phone, mode, exitCompare]);

  const enterCompare = () => {
    if (!compareStore || mode === "compare") return;
    const frame = playerRef.current?.currentFrame() ?? 0;
    const stored = compareStore.getState().pair;
    const sameFilm = stored !== null && stored.a === assetId && video.versions.some((candidate) => candidate.assetId === stored.b) && stored.b !== assetId;
    const ordered = [...video.versions].sort((x, y) => y.version - x.version);
    const here = video.versions.find((candidate) => candidate.assetId === assetId) ?? ordered[0]!;
    const below = ordered.find((candidate) => candidate.version < here.version) ?? ordered.find((candidate) => candidate.assetId !== here.assetId)!;
    const partner = sameFilm ? video.versions.find((candidate) => candidate.assetId === stored.b)! : below;
    const heard: CompareSideId = compareStore.getState().pair && sameFilm ? compareStore.getState().audible : here.hasAudio ? "a" : "b";
    compareStore.setPair(here.assetId, partner.assetId, heard);
    setStartFrame(frame);
    setResume(null);
    setMode("compare");
  };

  const changeSide = (target: CompareSideId, nextAssetId: string) => {
    if (!compareStore) return;
    const state = compareStore.getState();
    if (!state.pair) return;
    const a = target === "a" ? nextAssetId : state.pair.a;
    const b = target === "b" ? nextAssetId : state.pair.b;
    if (a === b) return;
    const has = (id: string) => video.versions.find((candidate) => candidate.assetId === id)?.hasAudio ?? false;
    const audible: CompareSideId = has(state.audible === "a" ? a : b) ? state.audible : has(a) ? "a" : has(b) ? "b" : state.audible;
    const tab = state.activeTab;
    compareStore.setPair(a, b, audible);
    compareStore.setActiveTab(tab);
    if (target === "a") setAssetId(nextAssetId);
  };

  const version = video.versions.find((candidate) => candidate.assetId === assetId) ?? video.versions[0]!;
  const base = { nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame };
  const startLabel = framesToTimecode(0, base, version.startTimecodeFrames ?? 0);
  const newest = Math.max(...video.versions.map((candidate) => candidate.version));
  const optionLabel = (candidate: VideoDto["versions"][number]) => `v${candidate.version}${candidate.version === newest ? " · latest" : ""} · ${candidate.uploadedBy.name} · ${formatVideoDate(candidate.createdAt)}`;
  const detailsFor = (target: VideoVersionDto): ReactNode => {
    const targetStart = framesToTimecode(0, { nominalFps: target.tcNominalFps, dropFrame: target.tcDropFrame }, target.startTimecodeFrames ?? 0);
    const details: Array<[string, string]> = [
      ["Uploaded by", target.uploadedBy.name],
      ["Uploaded", formatVideoDate(target.createdAt)],
      ["File", target.originalFilename],
      ["Size", formatBytes(target.bytes)],
      ["Frame rate", `${formatFps(target.fps)} fps`],
      ["Resolution", `${target.width}×${target.height}`],
      ["Duration", formatDuration(target.durationMs)],
      ["Codec", target.codec],
      ["Start timecode", targetStart],
      ["Audio", target.hasAudio ? "Yes" : "None"],
    ];
    return <ItemGroup>
      {details.map(([label, value]) => <Item key={label} size="xs">
        <ItemContent>
          <ItemTitle data-testid="video-detail-label" className="text-foreground-secondary font-normal group-data-[size=xs]/item:text-xs">{label}</ItemTitle>
          <ItemDescription data-testid="video-detail-value" className="text-foreground group-data-[size=xs]/item:text-sm">{value}</ItemDescription>
        </ItemContent>
      </Item>)}
    </ItemGroup>;
  };
  const detailsRows = detailsFor(version);

  const comparing = mode === "compare" && compareStore !== undefined;
  const header = <header className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)] border-b border-border bg-card px-[var(--space-5)] py-[var(--space-3)] text-card-foreground">
      <DialogClose render={<Button type="button" variant="ghost" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" />}><ChevronLeft aria-hidden="true" />Video</DialogClose>
      <div className="flex min-w-[220px] flex-1 flex-col gap-[var(--space-1)]">
        <DialogTitle className="text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{video.title}</DialogTitle>
        <DialogDescription className="text-foreground-secondary [font:var(--type-label)]">{`${version.width}×${version.height} · ${formatFps(version.fps)} fps · `}<span data-testid="video-start-tc" className="whitespace-nowrap">{`start TC ${startLabel}`}</span></DialogDescription>
      </div>
      {!comparing && <div data-testid="video-version-group" className="flex min-w-0 max-w-full items-center gap-[var(--space-2)]">
        <label htmlFor={VERSION_SELECT_ID} className="shrink-0 text-foreground-secondary [font:var(--type-label)]">Version</label>
        <Select value={version.assetId} onValueChange={(next) => { if (typeof next === "string") { setResume(null); setAssetId(next); } }}>
          <SelectTrigger id={VERSION_SELECT_ID} data-testid="video-version-trigger" className="pointer-coarse:min-h-11 max-[721px]:min-h-11 min-w-0 max-w-full">
            <SelectValue>{() => <span data-testid="video-version-label" className="block truncate">{optionLabel(version)}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {video.versions.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} className="pointer-coarse:min-h-11 max-[721px]:min-h-11">{optionLabel(candidate)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>}
      {(canCompare || comparing) && <Button
        ref={compareButtonRef}
        type="button"
        variant="outline"
        data-testid="video-compare-toggle"
        aria-pressed={comparing}
        className="pointer-coarse:min-h-11 max-[721px]:hidden"
        onPointerEnter={() => { preloadCompare(notesOn); }}
        onFocus={() => { preloadCompare(notesOn); }}
        onClick={() => { if (comparing) exitCompare("button"); else enterCompare(); }}
      ><Columns2 aria-hidden="true" />{comparing ? "Single view" : "Compare"}</Button>}
    </header>;
  const layout = (slots: { playerProps: VideoNotesSession["playerProps"]; panel: ReactNode } | null): ReactNode => <>
    {header}
    <div className="flex min-h-0 flex-1 flex-wrap overflow-y-auto min-[721px]:flex-nowrap min-[721px]:overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-[999_1_640px] flex-col min-[721px]:flex-1 p-[var(--space-5)]">
        <VideoPlayer key={version.assetId} version={version} title={`${video.title}, version ${version.version}`} controlRef={playerRef} keyboard="host" className="flex-1" {...(resume && resume.assetId === version.assetId ? { initialFrame: resume.frame } : {})} {...slots?.playerProps} />
      </div>
      {slots
        ? slots.panel
        : <aside aria-label="Version details" className="flex-[1_1_360px] min-[721px]:min-h-0 min-[721px]:flex-[0_0_clamp(240px,28vw,360px)] min-[721px]:overflow-y-auto border-l border-border bg-card p-[var(--space-5)] text-card-foreground max-[721px]:border-t max-[721px]:border-l-0">
          <h3 className="mb-[var(--space-3)] px-2.5 text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{`Version ${version.version}`}</h3>
          {detailsRows}
        </aside>}
    </div>
  </>;

  return <Dialog open onOpenChange={handleOpenChange}>
    <DialogContent
      data-surface="inverse"
      data-testid="video-review-viewer"
      ref={takePopup}
      initialFocus={popupRef}
      showCloseButton={false}
      finalFocus={() => { const opener = returnFocusTo?.(); return opener && opener.isConnected ? opener : true; }}
      onKeyDown={(event) => { (modeRef.current === "compare" ? compareRef.current : playerRef.current)?.handleKeyDown(event); }}
      className="top-0 left-0 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 text-foreground ring-0 focus-visible:!outline-none sm:max-w-none"
    >
      <OverlayContainerContext.Provider value={slot}>
      {comparing
        ? <>
          {header}
          <Suspense fallback={null}>
            <LazyCompareView video={video} store={compareStore} startFrame={startFrame} onChangeSide={changeSide} controlRef={compareRef} detailsFor={detailsFor} {...(notes ? { notes: { projectId: notes.projectId, role: notes.role, userId: notes.userId, archived: notes.archived, forms: notes.forms } } : {})} />
          </Suspense>
        </>
        : notes ? <Suspense fallback={null}><LazyNotesHost notes={notes} video={video} version={version} detailsRows={detailsRows}>{layout}</LazyNotesHost></Suspense> : layout(null)}
      </OverlayContainerContext.Provider>
      <div ref={setSlot} />
    </DialogContent>
  </Dialog>;
}
