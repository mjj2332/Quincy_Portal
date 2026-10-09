import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { framesToTimecode, type Role, type VideoDto } from "@quincy/shared";
import { hasOpenAlertDialog } from "../../lib/alert-dialog-press";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Button } from "../reui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../reui/dialog";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";
import { hasOpenFloatingPopup } from "../quincy/project-sheet-layers";
import { VideoPlayer, type VideoPlayerControl } from "../quincy/VideoPlayer";
import { formatBytes, formatDuration, formatFps, formatVideoDate } from "./video-format";
import type { DraftStore, VideoNotesSession } from "./use-video-notes";

/** The notes UI is its own chunk: a Project whose notes part is off never loads it. */
const LazyNotesHost = lazy(() => import("./VideoNotesHost"));

const VERSION_SELECT_ID = "video-review-version";

/**
 * The staff review viewer (#741 4d-ii): a collection-local, full-viewport dialog on the inverse surface that plays one Video, one
 * Version at a time. It changes no URL. The dialog popup owns the keyboard scope, so the shortcuts never reach the Project sheet
 * underneath and stop when it closes; the player's own handler does the work. Switching Version remounts the player (keyed by
 * Asset id): paused, at frame 0, with that Version's own clock, timecode and streaming URL. A superseded Version still plays.
 * With `notes` (the Project's `notes` part is on, #741 5b) the Version details column becomes the notes panel, and the Version details
 * move behind a button in its header; without it the viewer is exactly the 4d-ii viewer.
 */
export function VideoReviewViewer({ video, onClose, returnFocusTo, notes }: {
  video: VideoDto;
  onClose: () => void;
  /** The control that opened the viewer; focus goes back to it on close. */
  returnFocusTo?: () => HTMLElement | null;
  /** Present only when the notes part is on. */
  notes?: { projectId: string; role: Role; userId: string | null; archived: boolean; drafts: DraftStore };
}) {
  const [assetId, setAssetId] = useState(video.currentAssetId);
  const playerRef = useRef<VideoPlayerControl>(null);
  // Focus opens on the dialog itself, not its first button: Space on the Video button would close it (and the player leaves Space to a focused button).
  const popupRef = useRef<HTMLDivElement | null>(null);
  // Base UI moves focus a frame after mount; a key typed in that gap (Enter, then Space) would still hit the opener. Take focus in the commit itself.
  const takePopup = useCallback((element: HTMLDivElement | null) => { popupRef.current = element; element?.focus({ preventScroll: true }); }, []);
  // The Project sheet's overlay slot sits under this dialog: popups opened in here (Version, tooltips) portal into a slot of the dialog's own.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const notesOn = notes !== undefined;
  // Escape order with the notes panel (#741 5b), decided from a snapshot taken at keydown, before any handler has run: Base UI reports one
  // Escape to `onOpenChange` more than once, so the answer cannot come from state the first call changed (the ProjectSheet note).
  // 1. an open menu, popover, list or confirm owns it; 2. an active composer, reply or edit form is spent (a clean reply or edit closes,
  // anything else keeps its text and focus moves to the dialog); 3. only then does it close the viewer.
  const escapeSnapshot = useRef({ layer: false, form: false });
  useEffect(() => {
    if (!notesOn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const popup = popupRef.current;
      const layer = hasOpenAlertDialog() || hasOpenFloatingPopup(popup, slot);
      const active = document.activeElement;
      // A composer waiting for its frame is spent first, wherever focus is: the Post button that was pressed is disabled by then and focus has left it.
      const confirming = !layer && popup !== null ? popup.querySelector<HTMLElement>('[data-notes-form="composer"][data-phase="confirming"]') : null;
      const focused = !layer && popup !== null && active instanceof Element && popup.contains(active) ? active.closest<HTMLElement>("[data-notes-form]") : null;
      // An open edit or reply is the active form whatever has focus (the person may have clicked the player to adjust frames).
      const open = !layer && popup !== null ? popup.querySelector<HTMLElement>('[data-notes-form="edit"], [data-notes-form="reply"]') : null;
      const form = confirming ?? focused ?? open;
      const kind = form?.dataset.notesForm;
      const dirty = form?.dataset.dirty === "true";
      const spent = form?.dataset.escapeSpent === "true";
      // A dirty edit or reply whose first Escape is already spent no longer holds the viewer: this Escape closes it.
      const consumed = form !== null && popup !== null && (kind === "composer" || !dirty || !spent);
      escapeSnapshot.current = { layer, form: consumed };
      if (!consumed || !form || !popup) return;
      // Rule B: Escape cancels a frame confirmation (the draft is kept); a request already sent is never cancelled.
      if (confirming) form.dispatchEvent(new Event("quincy-notes-escape"));
      if (kind !== "composer" && !dirty) form.querySelector<HTMLElement>("[data-notes-cancel]")?.click();
      else if (kind !== "composer") {
        // The first Escape of a dirty edit or reply keeps its text; the next one closes the viewer.
        form.dispatchEvent(new Event("quincy-notes-escape", { bubbles: true }));
        if (focused) popup.focus({ preventScroll: true }); else form.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: true });
      } else popup.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); escapeSnapshot.current = { layer: false, form: false }; };
  }, [notesOn, slot]);
  const handleOpenChange = (open: boolean, details: { reason: string; cancel: () => void; allowPropagation: () => void }) => {
    if (open) return;
    if (notesOn && details.reason === "escape-key") {
      const snapshot = escapeSnapshot.current;
      if (snapshot.layer) { details.cancel(); details.allowPropagation(); return; }
      if (snapshot.form) { details.cancel(); return; }
    }
    onClose();
  };

  const version = video.versions.find((candidate) => candidate.assetId === assetId) ?? video.versions[0]!;
  const base = { nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame };
  const startLabel = framesToTimecode(0, base, version.startTimecodeFrames ?? 0);
  const newest = Math.max(...video.versions.map((candidate) => candidate.version));
  const optionLabel = (candidate: VideoDto["versions"][number]) => `v${candidate.version}${candidate.version === newest ? " · latest" : ""} · ${candidate.uploadedBy.name} · ${formatVideoDate(candidate.createdAt)}`;
  const details: Array<[string, string]> = [
    ["Uploaded by", version.uploadedBy.name],
    ["Uploaded", formatVideoDate(version.createdAt)],
    ["File", version.originalFilename],
    ["Size", formatBytes(version.bytes)],
    ["Frame rate", `${formatFps(version.fps)} fps`],
    ["Resolution", `${version.width}×${version.height}`],
    ["Duration", formatDuration(version.durationMs)],
    ["Codec", version.codec],
    ["Start timecode", startLabel],
    ["Audio", version.hasAudio ? "Yes" : "None"],
  ];

  const detailsRows = <ItemGroup>
    {details.map(([label, value]) => <Item key={label} size="xs">
      <ItemContent>
        <ItemTitle data-testid="video-detail-label" className="text-foreground-secondary font-normal group-data-[size=xs]/item:text-xs">{label}</ItemTitle>
        <ItemDescription data-testid="video-detail-value" className="text-foreground group-data-[size=xs]/item:text-sm">{value}</ItemDescription>
      </ItemContent>
    </Item>)}
  </ItemGroup>;

  const layout = (slots: { playerProps: VideoNotesSession["playerProps"]; panel: ReactNode } | null): ReactNode => <>
    <header className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)] border-b border-border bg-card px-[var(--space-5)] py-[var(--space-3)] text-card-foreground">
      <DialogClose render={<Button type="button" variant="ghost" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" />}><ChevronLeft aria-hidden="true" />Video</DialogClose>
      <div className="flex min-w-[220px] flex-1 flex-col gap-[var(--space-1)]">
        <DialogTitle className="text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{video.title}</DialogTitle>
        <DialogDescription className="text-foreground-secondary [font:var(--type-label)]">{`${version.width}×${version.height} · ${formatFps(version.fps)} fps · `}<span data-testid="video-start-tc" className="whitespace-nowrap">{`start TC ${startLabel}`}</span></DialogDescription>
      </div>
      <div data-testid="video-version-group" className="flex min-w-0 max-w-full items-center gap-[var(--space-2)]">
        <label htmlFor={VERSION_SELECT_ID} className="shrink-0 text-foreground-secondary [font:var(--type-label)]">Version</label>
        <Select value={version.assetId} onValueChange={(next) => { if (typeof next === "string") setAssetId(next); }}>
          <SelectTrigger id={VERSION_SELECT_ID} data-testid="video-version-trigger" className="pointer-coarse:min-h-11 max-[721px]:min-h-11 min-w-0 max-w-full">
            <SelectValue>{() => <span data-testid="video-version-label" className="block truncate">{optionLabel(version)}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {video.versions.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} className="pointer-coarse:min-h-11 max-[721px]:min-h-11">{optionLabel(candidate)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-wrap overflow-y-auto min-[721px]:flex-nowrap min-[721px]:overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-[999_1_640px] flex-col min-[721px]:flex-1 p-[var(--space-5)]">
        <VideoPlayer key={version.assetId} version={version} title={`${video.title}, version ${version.version}`} controlRef={playerRef} keyboard="host" className="flex-1" {...slots?.playerProps} />
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
      onKeyDown={(event) => { playerRef.current?.handleKeyDown(event); }}
      className="top-0 left-0 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 text-foreground ring-0 focus-visible:!outline-none sm:max-w-none"
    >
      <OverlayContainerContext.Provider value={slot}>
      {notes ? <Suspense fallback={null}><LazyNotesHost notes={notes} version={version} detailsRows={detailsRows}>{layout}</LazyNotesHost></Suspense> : layout(null)}
      </OverlayContainerContext.Provider>
      <div ref={setSlot} />
    </DialogContent>
  </Dialog>;
}
