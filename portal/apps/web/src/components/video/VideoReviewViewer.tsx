import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Columns2, DownloadIcon, Link2, Smartphone, Trash2 } from "lucide-react";
import { framesToTimecode, videoVersionDownloadUrl, type Role, type VideoDto, type VideoVersionDto } from "@quincy/shared";
import { registerToastHost } from "../../lib/toast-host";
import { hasOpenAlertDialog } from "../../lib/alert-dialog-press";
import { useMediaQuery } from "../../lib/use-media-query";
import { useProjectSocialOverlaysQuery } from "../../lib/project-data";
import { currentOverlay, useSocialPreview } from "../../lib/use-social-preview";
import type { CompareSideId, CompareStore } from "../../lib/video-compare-store";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Button } from "../reui/button";
import { IconButton } from "../quincy/icon-button";
import type { VersionRemovalHandle } from "./VideoVersionMenu";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../reui/dialog";
import { IconTip } from "../quincy/IconTip";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { CopyTextButton } from "./CopyTextButton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";
import { hasOpenFloatingPopup, hasOpenModalAbove } from "../quincy/project-sheet-layers";
import { ReviewPaneHideContext, ReviewSplit, useReviewPane, useReviewPaneControls } from "../quincy/ReviewPane";
import type { SocialPreviewMode } from "../quincy/SocialPreviewControls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../reui/tabs";
import { VideoPlayer, type VideoPlayerControl } from "../quincy/VideoPlayer";
import { formatBytes, formatDuration, formatFps, formatVideoDate } from "./video-format";
import type { NoteFormStore } from "../../lib/video-note-form-store";
import { versionSlot, videoSlot, type VideoApprovalStore } from "../../lib/video-approval-store";
import type { VideoNotesSession } from "./use-video-notes";
import { VideoReviewStatusPill } from "./VideoReviewStatusPill";
import { VideoReviewHeaderMenu } from "./VideoReviewHeaderMenu";

/** The notes UI is its own chunk: a Project whose notes part is off never loads it. */
const LazyNotesHost = lazy(() => import("./VideoNotesHost"));
/** Decisions, Release and premium (#741 14-ui-staff) are their own chunk: a Project whose `delivery` part is off never loads it. */
const LazyDeliveryPanel = lazy(() => import("./VideoDeliveryPanel").then((module) => ({ default: module.VideoDeliveryPanel })));
/** The Version menu (Remove, #776 E) is its own chunk: a Project whose `trash` part is off never loads it. */
const LazyVersionMenu = lazy(() => import("./VideoVersionMenu").then((module) => ({ default: module.VideoVersionMenu })));
/** Compare (#741 7c) is its own chunk too, and the viewer never imports the transport: only a Project whose `compare` part is on, and only when a reviewer opens it. */
const loadCompare = () => import("./CompareView");
const LazyCompareView = lazy(loadCompare);
const preloadCompare = (withNotes: boolean) => { void loadCompare(); if (withNotes) void import("./CompareNotesHost"); };
/** Compare needs room for two pictures: below this the viewer is the single player, and the Compare button is not offered. */
const PHONE_QUERY = "(width < 721px)";

const VERSION_SELECT_ID = "video-review-version";

/** Below this bar width (a container query on the header) an action's label is spoken, not drawn, and a tooltip names it, so 721-1080px still fits on one line. */
const BAR_LABEL = "@max-[1080px]:sr-only";

/**
 * The staff review viewer (#741 4d-ii): a collection-local, full-viewport dialog on the inverse surface that plays one Video, one
 * Version at a time. It changes no URL of its own: with `deepLink` (#819) it reports the Version on show and offers Copy link. The dialog popup owns the keyboard scope, so the shortcuts never reach the Project sheet
 * underneath and stop when it closes; the player's own handler does the work. Switching Version remounts the player (keyed by
 * Asset id): paused, at frame 0, with that Version's own clock, timecode and streaming URL. A superseded Version still plays.
 * With `notes` (the Project's `notes` part is on, #741 5b) the Version details column becomes the notes panel, and the Version details
 * move behind a button in its header; without it the viewer is exactly the 4d-ii viewer.
 */
export function VideoReviewViewer({ video, onClose, returnFocusTo, notes, compare, delivery, trash, download, reviewLinks, deepLink, reviewStatus, social }: {
  video: VideoDto;
  onClose: () => void;
  /** The control that opened the viewer; focus goes back to it on close. */
  returnFocusTo?: () => HTMLElement | null;
  /** Present only when the notes part is on. */
  notes?: { projectId: string; role: Role; userId: string | null; archived: boolean; forms: NoteFormStore; /** The Project's `markup` part is on (#741 6b-ui). */ markup?: boolean; /** The Project's `export` part is on (#741 9). */ exportEnabled?: boolean; /** #835: the note the link names (`&note=`): its thread is selected and the film sought to its frame. */ openNoteId?: string };
  /** Present only when the Project's `compare` part is on (#741 7c). */
  compare?: { store: CompareStore };
  /** Present only when the Project's `delivery` part is on (#741 14-ui-staff): decisions, Release and premium under the player. */
  delivery?: { projectId: string; role: Role; archived: boolean; store: VideoApprovalStore };
  /** Present only when the Project's `trash` part is on and the role may manage the Trash (#776 E): the Version menu with Remove. */
  trash?: { projectId: string; archived: boolean };
  /** Present only when the Project's `download` part is on and the role holds `downloadVideo` (#818): the Download link in the header (single view only). */
  download?: { projectId: string };
  /** Present only when new Review links may be made (#834): the header's Create Review link, which hands over the Version to grant (the one on screen; side A in Compare). */
  reviewLinks?: { onCreate: (assetId: string) => void };
  /** Present when Review status is offered (#863): the header pill reports the Video's status and, per role, sets it. */
  reviewStatus?: { projectId: string; role: Role; archived: boolean };
  /** Present when Social preview is offered (#871, behind the Video review gate only): where to read the Project's resolved overlays, and whether the viewer opens with it on (the card menu's Social preview). */
  social?: { projectId: string; role: Role; initialOn?: boolean };
  /** Present when the URL names this film (#819, staff Project route): `version` is the Version number it names (absent = the current one), `href` the absolute link to a Version, `onVersionShown` how the viewer reports the Version on show. */
  deepLink?: { version?: number; /** The list this Video came from is a settled, successful read: only then is an unknown Version normalised in the URL. */ settled: boolean; href: (version: number) => string; onVersionShown: (version: number) => void };
}) {
  // With a `deepLink` the URL is the only source of the Version on show (no local copy): `deepLink.version` if the list has it, else the current Version. Every choice writes the URL and the display follows it.
  const [localAssetId, setLocalAssetId] = useState(video.currentAssetId);
  const urlAsset = deepLink ? (deepLink.version === undefined ? undefined : video.versions.find((candidate) => candidate.version === deepLink.version)) ?? video.versions.find((candidate) => candidate.assetId === video.currentAssetId) ?? video.versions[0]! : undefined;
  const assetId = urlAsset?.assetId ?? localAssetId;
  const deepLinkRef = useRef(deepLink);
  deepLinkRef.current = deepLink;
  const versionsRef = useRef(video.versions);
  versionsRef.current = video.versions;
  // A callback this viewer handed out (a pending Version removal) can outlive it: once unmounted, choosing a Version writes nothing.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setAssetId = useCallback((next: string) => {
    if (!mounted.current) return;
    const link = deepLinkRef.current;
    const target = versionsRef.current.find((candidate) => candidate.assetId === next);
    if (link && target) link.onVersionShown(target.version); else setLocalAssetId(next);
  }, []);
  const playerRef = useRef<VideoPlayerControl>(null);
  const compareRef = useRef<VideoPlayerControl>(null);
  const compareButtonRef = useRef<HTMLButtonElement | null>(null);
  const liveStore = compare?.store;
  const [mode, setMode] = useState<"single" | "compare">("single");
  // The capability can go away while comparing (the flag turns off and the gate refreshes). The store is kept for that one render so the
  // mounted compare view can hand A's frame and the mute choice over (the normal exit) before it unmounts.
  const lastStore = useRef(liveStore);
  if (liveStore) lastStore.current = liveStore;
  const compareStore = liveStore ?? (mode === "compare" ? lastStore.current : undefined);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Where the compare view opens A (the single player's frame), and where the single player reopens after it (A's frame).
  const [startFrame, setStartFrame] = useState(0);
  const startFrameRef = useRef(0);
  const [resume, setResume] = useState<{ assetId: string; frame: number } | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  // The side pane (#859): open / width are a per-browser preference shared with the guest page. `sideTab` picks Notes (or Details) or Delivery inside it.
  const pane = useReviewPane(phone);
  const paneId = useId();
  const [sideTab, setSideTab] = useState<"main" | "delivery">("main");
  /** An I/O mark, a marker or a note link needs the notes where the person can see them: open the pane on its first tab. */
  const setPaneOpen = pane.setOpen;
  const revealNotes = useCallback(() => { setPaneOpen(true); setSideTab("main"); }, [setPaneOpen]);
  const deepNoteId = notes?.openNoteId;
  useEffect(() => { if (deepNoteId !== undefined) revealNotes(); }, [deepNoteId, revealNotes]);
  // One mute choice for both views: the single player and compare each start from it, and report back on exit.
  // The compare store owns the preference (it outlives the viewer): the viewer reads it on open and writes every single-player change back.
  const [muted, setMutedState] = useState(() => compareStore?.getState().muted ?? false);
  const setMuted = useCallback((next: boolean) => { setMutedState(next); compareStore?.setMuted(next); }, [compareStore]);
  const canCompare = liveStore !== undefined && video.versions.length >= 2 && !phone;
  // Focus opens on the dialog itself, not its first button: Space on the Video button would close it (and the player leaves Space to a focused button).
  const popupRef = useRef<HTMLDivElement | null>(null);
  // Base UI moves focus a frame after mount; a key typed in that gap (Enter, then Space) would still hit the opener. Take focus in the commit itself.
  const takePopup = useCallback((element: HTMLDivElement | null) => { popupRef.current = element; element?.focus({ preventScroll: true }); }, []);
  // The Project sheet's overlay slot sits under this dialog: popups opened in here (Version, tooltips) portal into a slot of the dialog's own.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The toast viewport renders in here while the viewer is open, so an Undo toast sits inside the focus trap.
  const [toastSlot, setToastSlot] = useState<HTMLElement | null>(null);
  useEffect(() => (toastSlot ? registerToastHost(toastSlot) : undefined), [toastSlot]);
  const notesOn = notes !== undefined;
  // The pane's collapse control (#877): hide (⇥) lives in the pane, show (⇤) in a slim strip once it is collapsed. The top bar holds neither.
  const paneControls = useReviewPaneControls({ open: pane.open, onOpenChange: setPaneOpen, paneId, noun: notesOn ? "notes" : "details" });
  // Escape order with the notes panel (#741 5b), decided from a snapshot taken at keydown, before any handler has run: Base UI reports one
  // Escape to `onOpenChange` more than once, so the answer cannot come from state the first call changed (the ProjectSheet note).
  // 1. an open menu, popover, list, confirm or modal dialog owns it; 2. the form store decides for the Version's form (draw mode first: a confirmation is cancelled, or
  // drawing ends and the strokes stay; then a frame confirmation is cancelled, a clean edit or reply closes, a dirty form or the composer keeps its text on the first Escape);
  // 3. only then does it close the viewer.
  const forms = notes?.forms;
  // Social preview (#871): the Project's resolved overlays are read only while it is on (so a viewer that never uses it makes no request), and the choice lives in this opening alone.
  const preview = useSocialPreview(social?.initialOn ?? false);
  const socialOn = social !== undefined && preview.on;
  const socialOnRef = useRef(socialOn);
  socialOnRef.current = socialOn;
  const socialToggleRef = useRef<HTMLButtonElement | null>(null);
  const overlaysQuery = useProjectSocialOverlaysQuery(social?.projectId ?? "", socialOn, social?.role);
  const frames = useMemo(() => overlaysQuery.data?.resolved.map(({ id, name, imageUrl }) => ({ id, name, imageUrl })), [overlaysQuery.data]);
  const refetchOverlays = overlaysQuery.refetch;
  const socialMode: SocialPreviewMode | undefined = socialOn ? {
    overlays: frames ?? [], currentId: currentOverlay(frames, preview.overlayId)?.id ?? null, onOverlay: preview.setOverlayId,
    status: overlaysQuery.isError ? "error" : frames ? "ready" : "loading", onRetry: () => { void refetchOverlays(); },
  } : undefined;
  // Social preview pauses nothing (#877): notes, marks and drawing work in it, so turning it on or off touches no form, draft or drawing.
  const setSocialOn = (next: boolean) => { preview.setOn(next); };
  const escapeSnapshot = useRef({ layer: false, form: false, compare: false, social: false });
  const exitCompare = useCallback((focus: "button" | "dialog") => {
    if (modeRef.current !== "compare") return;
    // The view may not have loaded yet (leaving at once): then the frame it was entered at is still the position.
    const frame = compareRef.current?.currentFrame() ?? startFrameRef.current;
    const pairA = compareStore?.getState().pair?.a;
    if (frame !== undefined && pairA !== undefined) setResume({ assetId: pairA, frame });
    if (compareStore) setMutedState(compareStore.getState().muted);
    modeRef.current = "single";
    setMode("single");
    if (focus === "button" && compareButtonRef.current?.isConnected) compareButtonRef.current.focus({ preventScroll: true });
    else popupRef.current?.focus({ preventScroll: true });
  }, [compareStore]);
  useEffect(() => {
    // Always on: the time-format menu (#860) is a floating popup of the player itself, so Escape closes it first even with notes and Compare off.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const popup = popupRef.current;
      // A modal dialog opened from the panel (the notes paste dialog) is not a floating popup but owns Escape just the same.
      const layer = hasOpenAlertDialog() || hasOpenFloatingPopup(popup, slot) || hasOpenModalAbove(popup, document);
      if (layer || popup === null) { escapeSnapshot.current = { layer, form: false, compare: false, social: false }; return; }
      const active = document.activeElement;
      let consumed = false;
      const inForm = active instanceof Element && popup.contains(active) && active.closest("[data-notes-form]") !== null;
      // In compare a form is only the Escape's when focus is inside that side's note form: a hidden or unfocused draft never swallows it.
      // The order is the form or the drawing first, then Social, then Compare, then the viewer (#877): Social leaves the forms visible, so a form that is open owns the key.
      if (notesOn && forms && (modeRef.current !== "compare" || inForm)) {
        // In compare the form belongs to the side whose panel holds focus (else the side whose tab is showing).
        const pair = compareStore?.getState().pair;
        const sideOf = active instanceof Element ? active.closest("[data-compare-side]")?.getAttribute("data-compare-side") : null;
        const formSide: CompareSideId = sideOf === "a" || sideOf === "b" ? sideOf : (compareStore?.getState().activeTab ?? "a");
        const formAsset = modeRef.current === "compare" && pair ? pair[formSide] : assetId;
        const result = forms.escape(formAsset, { focusInForm: inForm });
        consumed = result.consumed;
        if (result.focus === "dialog") popup.focus({ preventScroll: true });
        // focus === "draw": the pill is still expanded here, so the overlay returns focus to its Draw button itself once drawing has ended.
        else if (result.focus === "textarea") (popup.querySelector<HTMLElement>('[data-notes-form="edit"] :is(textarea, [contenteditable="true"]), [data-notes-form="reply"] :is(textarea, [contenteditable="true"])') ?? popup.querySelector<HTMLElement>("#video-note-body"))?.focus({ preventScroll: true });
      }
      escapeSnapshot.current = { layer, form: consumed, compare: !consumed && modeRef.current === "compare", social: !consumed && socialOnRef.current };
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); escapeSnapshot.current = { layer: false, form: false, compare: false, social: false }; };
  }, [notesOn, forms, assetId, slot, compareStore]);
  const handleOpenChange = (open: boolean, details: { reason: string; cancel: () => void; allowPropagation: () => void }) => {
    if (open) return;
    if (details.reason === "escape-key") {
      const snapshot = escapeSnapshot.current;
      if (snapshot.layer) { details.cancel(); details.allowPropagation(); return; }
      if (snapshot.form) { details.cancel(); return; }
      if (snapshot.social) { details.cancel(); preview.setOn(false); socialToggleRef.current?.focus({ preventScroll: true }); return; }
      if (snapshot.compare) { details.cancel(); exitCompare("button"); return; }
    }
    onClose();
  };

  useEffect(() => { if (mode === "compare" && liveStore === undefined) exitCompare("dialog"); }, [mode, liveStore, exitCompare]);
  // Compare is not offered below 721px: crossing it leaves for the single view on A, with focus on the dialog (the button is gone).
  useEffect(() => { if (phone && mode === "compare") exitCompare("dialog"); }, [phone, mode, exitCompare]);
  // A Version left the list (removed here, or in another tab: #776 E). The one on show goes to the current Version; a Compare that had it as a side forgets it and leaves for the single view.
  const versionIds = video.versions.map((candidate) => candidate.assetId).join(",");
  // Only a Version that was in THIS film's list and is now missing is retired here; one that is not this film's (a pair kept from another film) is not gone, and the collection panel retires what left the whole list.
  const previousVersions = useRef<{ videoId: string; ids: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    const present = new Set(versionIds.split(","));
    const previous = previousVersions.current;
    previousVersions.current = { videoId: video.id, ids: present };
    if (!present.has(assetId)) { setResume(null); setLocalAssetId(video.currentAssetId); }
    if (previous === null || previous.videoId !== video.id) return;
    const gone = new Set([...previous.ids].filter((id) => !present.has(id)));
    const pair = compareStore?.getState().pair;
    if (compareStore && pair && (gone.has(pair.a) || gone.has(pair.b))) {
      for (const side of [pair.a, pair.b]) if (gone.has(side)) compareStore.dropVersion(side);
      if (modeRef.current === "compare") exitCompare("dialog");
    }
  }, [versionIds, video.id, assetId, video.currentAssetId, compareStore, exitCompare]);
  /** The Version was removed (#776 E): state that holds nothing typed lets go, and the viewer moves to the Video's current Version. Typed state goes through `captureDrafts`. */
  const assetIdRef = useRef(assetId);
  assetIdRef.current = assetId;
  const onVersionRemoved = useCallback((removed: { assetId: string; videoId: string; video: VideoDto | null }) => {
    compareStore?.dropVersion(removed.assetId);
    // Move only when the Version on show is the one that went (#862: a row can remove another Version); the film's other Versions leave the person where they are.
    if (removed.video !== null && removed.assetId === assetIdRef.current) { setResume(null); setAssetId(removed.video.currentAssetId); }
  }, [compareStore]);
  // The Version list's own rows (#862): the list closes without handing focus back to its trigger, because the confirmation takes it and returns it to the Version select.
  const removeRef = useRef<VersionRemovalHandle | null>(null);
  // The menu is a lazy chunk: its rows' icons wait for the handle to mount, so a press is never lost.
  const [removeReady, setRemoveReady] = useState(false);
  const bindRemove = useCallback((handle: VersionRemovalHandle | null) => { removeRef.current = handle; setRemoveReady(handle !== null); }, []);
  const [versionListOpen, setVersionListOpen] = useState(false);
  const handOff = useRef(false);
  const rowsDisabled = trash?.archived === true;
  const removeFromRow = (candidate: VideoDto["versions"][number]) => {
    const handle = removeRef.current;
    if (!handle) return;
    handOff.current = true;
    setVersionListOpen(false);
    handle.open(candidate.assetId, () => document.getElementById(VERSION_SELECT_ID));
  };
  /**
   * At the moment the person confirms Remove: notes the edit revision of each slot the removal retires. The returned function, run when the answer is applied, retires a slot only if it has not
   * been edited since, so anything typed after the confirmation (the answer was slow, the film came back and was drafted on) survives. `whole`: the Video went, so its payment reference too.
   */
  const captureDrafts = useCallback((assetId: string, videoId: string): ((whole: boolean) => void) => {
    const noteRev = forms?.draftRevision(assetId); const decisionRev = delivery?.store.draftRevision(versionSlot(assetId)); const videoRev = delivery?.store.draftRevision(videoSlot(videoId));
    return (whole) => {
      if (forms && forms.draftRevision(assetId) === noteRev) forms.forgetSlot(assetId);
      if (delivery) {
        if (delivery.store.draftRevision(versionSlot(assetId)) === decisionRev) delivery.store.forget(versionSlot(assetId));
        if (whole && delivery.store.draftRevision(videoSlot(videoId)) === videoRev) delivery.store.forget(videoSlot(videoId));
      }
    };
  }, [forms, delivery?.store]);
  /** Whether removing the Version (and, with `whole`, the Video) would discard something typed and not yet sent: a note, a decision note, a payment reference. */
  const hasDraft = useCallback((target: string, videoId: string, whole: boolean) => (forms?.hasUnsent(target) ?? false)
    || (delivery !== undefined && (delivery.store.getSlot(versionSlot(target)).note !== "" || (whole && delivery.store.getSlot(videoSlot(videoId)).paymentRef !== ""))), [forms, delivery]);

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
    // The store may be stale (the capability can turn on while the viewer is open and the single player was muted meanwhile): the viewer's choice wins on entry.
    compareStore.setMuted(muted);
    setStartFrame(frame);
    startFrameRef.current = frame;
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
  // #819: the one normalisation rule. A settled, successful list read that lacks the URL's Version (omitted, unknown, or one a refresh removed) gets the fresh current Version written; never while unsettled.
  const urlVersion = deepLink?.version;
  const settled = deepLink?.settled ?? false;
  const currentVersion = video.versions.find((candidate) => candidate.assetId === video.currentAssetId)?.version;
  useEffect(() => {
    if (!settled || currentVersion === undefined) return;
    if (urlVersion === undefined || !versionsRef.current.some((candidate) => candidate.version === urlVersion)) deepLinkRef.current?.onVersionShown(currentVersion);
  }, [settled, urlVersion, currentVersion, video.versions]);
  // Back/Forward (or any write that did not come from this viewer) to a different Version while comparing leaves Compare; a side A change made here already moved the pair.
  useEffect(() => {
    if (!deepLinkRef.current || modeRef.current !== "compare") return;
    if (compareStore?.getState().pair?.a !== assetId) exitCompare("dialog");
  }, [assetId, compareStore, exitCompare]);
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
  /** Create Review link grants side A in Compare (read at click time; a side A no longer in this film falls back to the Version on screen), else the Version on screen. */
  const createReviewLink = reviewLinks ? () => {
    const sideA = comparing ? compareStore?.getState().pair?.a : undefined;
    reviewLinks.onCreate(sideA && video.versions.some((candidate) => candidate.assetId === sideA) ? sideA : version.assetId);
  } : undefined;
  /** A phone folds the Version ⋯ menu's Remove into the viewer's one ⋯ menu; the confirmation is the same one (`VersionRemovalHandle`), and focus returns to that menu's trigger. */
  const removeVersionFromMenu = trash ? () => { removeRef.current?.open(version.assetId, () => document.querySelector<HTMLElement>('[data-testid="video-header-menu"]')); } : undefined;
  const copyHref = deepLink && !comparing ? deepLink.href(version.version) : undefined;
  const downloadHref = download && !comparing ? videoVersionDownloadUrl(download.projectId, version.assetId) : undefined;
  const header = <header className="@container flex min-h-12 flex-nowrap items-center gap-x-[var(--space-3)] border-b border-border bg-card px-[var(--space-4)] py-[var(--space-1)] text-card-foreground max-[721px]:gap-x-[var(--space-2)] max-[721px]:px-[var(--space-3)]">
      <DialogClose render={<Button type="button" variant="ghost" className="shrink-0 pointer-coarse:min-h-11 max-[721px]:min-h-11 max-[721px]:min-w-11" />}><ChevronLeft aria-hidden="true" /><span className={phone ? "sr-only" : undefined}>Video</span></DialogClose>
      <DialogTitle title={video.title} className="m-0 min-w-0 flex-1 truncate [font:var(--type-body)]">{video.title}</DialogTitle>
      {/* The pill may not grow the bar: its older-publication hint stays on the line and its error copy floats under the bar instead of wrapping it. */}
      {reviewStatus && <div data-testid="video-review-status-slot" className="relative min-w-0 shrink-0 [&>div]:flex-nowrap [&_[role=alert]]:absolute [&_[role=alert]]:top-full [&_[role=alert]]:left-0 [&_[role=alert]]:z-10 [&_[role=alert]]:mt-[var(--space-1)] [&_[role=alert]]:w-max [&_[role=alert]]:max-w-[min(24rem,90vw)] [&_[role=alert]]:border [&_[role=alert]]:border-border [&_[role=alert]]:bg-card [&_[role=alert]]:p-[var(--space-2)]">
        <VideoReviewStatusPill video={video} version={version} comparing={comparing} compact={phone} {...reviewStatus} />
      </div>}
      {!comparing && <div data-testid="video-version-group" className="flex min-w-0 max-w-full shrink items-center gap-[var(--space-2)]">
        <label htmlFor={VERSION_SELECT_ID} className={`shrink-0 text-foreground-secondary [font:var(--type-label)]${phone ? " sr-only" : ""}`}>Version</label>
        <Select open={versionListOpen} onOpenChange={(next) => { if (next) handOff.current = false; setVersionListOpen(next); }} value={version.assetId} onValueChange={(next) => { if (typeof next === "string") { setResume(null); setAssetId(next); } }}>
          <SelectTrigger id={VERSION_SELECT_ID} data-testid="video-version-trigger" className="pointer-coarse:min-h-11 max-[721px]:min-h-11 min-w-0 max-w-full">
            <SelectValue>{() => <span data-testid="video-version-label" className="block truncate">{phone ? `v${version.version}` : optionLabel(version)}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent finalFocus={() => !handOff.current} className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {video.versions.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} className="pointer-coarse:min-h-11 max-[721px]:min-h-11">{optionLabel(candidate)}{trash && <IconButton
              tabIndex={-1} aria-hidden="true" data-testid="video-version-row-remove" data-asset-id={candidate.assetId} title={`Remove version ${candidate.version}`}
              disabled={!removeReady || rowsDisabled || (video.uploading != null && video.versions.length === 1)}
              className="ml-auto text-foreground"
              // The option commits on pointerdown/mouseup/click: none of them may reach it from the icon.
              onPointerDown={(event) => { event.stopPropagation(); }} onMouseUp={(event) => { event.stopPropagation(); }}
              onClick={(event) => { event.stopPropagation(); event.preventDefault(); removeFromRow(candidate); }}
            ><Trash2 aria-hidden="true" /></IconButton>}</SelectItem>)}
          </SelectContent>
        </Select>
        {trash && <Suspense fallback={null}><LazyVersionMenu projectId={trash.projectId} archived={trash.archived} video={video} version={version} hasDraft={hasDraft} captureDrafts={captureDrafts} onRemoved={onVersionRemoved} removeRef={bindRemove} hideTrigger={phone} /></Suspense>}
      </div>}
      <div data-testid="video-header-actions" className="ml-auto flex flex-none flex-nowrap items-center gap-[var(--space-2)]">
      {phone
        ? <VideoReviewHeaderMenu copyHref={copyHref} downloadHref={downloadHref} downloadLabel={`Download version ${version.version}`} onCreateReviewLink={createReviewLink} {...(removeVersionFromMenu ? { onRemoveVersion: removeVersionFromMenu, removeDisabled: !removeReady || trash?.archived === true || (video.uploading != null && video.versions.length === 1) } : {})} />
        : <>
          {copyHref && <CopyTextButton text={copyHref} label="Copy link" labelClassName={BAR_LABEL} tooltip className="pointer-coarse:min-h-11" />}
          {downloadHref && <IconTip label="Download"><Button variant="outline" nativeButton={false} data-testid="video-download" aria-label={`Download version ${version.version}`} className="pointer-coarse:min-h-11" render={<a href={downloadHref} download />}><DownloadIcon aria-hidden="true" /><span className={BAR_LABEL}>Download</span></Button></IconTip>}
          {createReviewLink && <IconTip label="Create Review link"><Button type="button" variant="outline" data-testid="video-create-review-link" className="pointer-coarse:min-h-11" onClick={createReviewLink}><Link2 aria-hidden="true" /><span className={BAR_LABEL}>Create Review link</span></Button></IconTip>}
        </>}
      {social && <IconTip label="Social preview"><Button
        ref={socialToggleRef}
        type="button"
        variant="outline"
        onClick={() => { setSocialOn(!socialOn); }}
        data-testid="video-social-toggle"
        aria-pressed={socialOn}
        className={"pointer-coarse:min-h-11 max-[721px]:min-h-11 max-[721px]:min-w-11 aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:!text-foreground"}
      ><Smartphone aria-hidden="true" /><span className={phone ? "sr-only" : BAR_LABEL}>Social preview</span></Button></IconTip>}
      {(canCompare || comparing) && <IconTip label={comparing ? "Single view" : "Compare"}><Button
        ref={compareButtonRef}
        type="button"
        variant="outline"
        data-testid="video-compare-toggle"
        aria-pressed={comparing}
        className="pointer-coarse:min-h-11 max-[721px]:hidden"
        onPointerEnter={() => { preloadCompare(notesOn); }}
        onFocus={() => { preloadCompare(notesOn); }}
        onClick={() => { if (comparing) exitCompare("button"); else enterCompare(); }}
      ><Columns2 aria-hidden="true" /><span className={BAR_LABEL}>{comparing ? "Single view" : "Compare"}</span></Button></IconTip>}
      </div>
    </header>;
  const layout = (slots: { playerProps: VideoNotesSession["playerProps"]; panel: ReactNode } | null): ReactNode => {
    const deliveryPanel = delivery ? <Suspense fallback={null}><LazyDeliveryPanel projectId={delivery.projectId} role={delivery.role} archived={delivery.archived} video={video} version={version} store={delivery.store} /></Suspense> : null;
    const main = slots
      ? slots.panel
      : <aside aria-label="Version details" className="min-[721px]:min-h-0 flex-1 min-[721px]:overflow-y-auto border-l border-border bg-card p-[var(--space-5)] text-card-foreground max-[721px]:border-t max-[721px]:border-l-0">
        <div className="mb-[var(--space-3)] flex items-center justify-between gap-[var(--space-2)]">
          <h3 className="m-0 px-2.5 text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{`Version ${version.version}`}</h3>
          {!phone && delivery === undefined && paneControls.hideButton}
        </div>
        {detailsRows}
      </aside>;
    // Delivery is a tab of the pane on desktop, so the player takes the full column; both panels stay mounted (a draft or a pending write survives switching). A phone keeps today's stack: delivery under the player.
    const tabbed = delivery !== undefined && !phone;
    const sidePane = tabbed
      ? <Tabs value={sideTab} onValueChange={(next) => { setSideTab(next === "delivery" ? "delivery" : "main"); }} className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 items-center border-l border-b border-border bg-card pe-[var(--space-2)]">
          <TabsList variant="line" className="min-w-0 flex-1 rounded-none bg-card px-[var(--space-3)]">
            <TabsTrigger value="main">{slots ? "Notes" : "Details"}</TabsTrigger>
            <TabsTrigger value="delivery">Delivery</TabsTrigger>
          </TabsList>
          {paneControls.hideButton}
        </div>
        <TabsContent value="main" keepMounted className="flex min-h-0 flex-col [&[hidden]]:hidden"><ReviewPaneHideContext.Provider value={null}>{main}</ReviewPaneHideContext.Provider></TabsContent>
        <TabsContent value="delivery" keepMounted className="min-h-0 overflow-y-auto border-l border-border bg-card p-[var(--space-4)] [&[hidden]]:hidden">{deliveryPanel}</TabsContent>
      </Tabs>
      : <ReviewPaneHideContext.Provider value={phone ? null : paneControls.hideButton}>{main}</ReviewPaneHideContext.Provider>;
    const playerProps = slots ? {
      ...slots.playerProps,
      onMarkerSelect: (id: string) => { revealNotes(); slots.playerProps.onMarkerSelect(id); },
      ...(slots.playerProps.onMark ? { onMark: (kind: "in" | "out", frame: number) => { revealNotes(); slots.playerProps.onMark!(kind, frame); } } : {}),
    } : undefined;
    return <ReviewSplit
      open={pane.open}
      width={pane.width}
      onWidth={pane.setWidth}
      onNarrow={pane.onNarrow}
      paneId={paneId}
      handleLabel="Resize notes"
      stacked={phone}
      rowClassName="overflow-y-auto"
      playerClassName="overflow-y-auto"
      player={<>
        <VideoPlayer key={version.assetId} version={version} title={`${video.title}, version ${version.version}`} controlRef={playerRef} keyboard="host" initialMuted={muted} onMutedChange={setMuted} className="min-h-[20rem] flex-1" {...(resume && resume.assetId === version.assetId ? { initialFrame: resume.frame } : {})} {...playerProps} {...(socialMode ? { social: socialMode } : {})} />
        {delivery && phone && <div className="mt-[var(--space-4)] shrink-0">{deliveryPanel}</div>}
      </>}
      pane={sidePane}
      strip={paneControls.strip}
    />;
  };

  return <Dialog open onOpenChange={handleOpenChange}>
    <DialogContent
      data-surface="inverse"
      data-testid="video-review-viewer"
      ref={takePopup}
      initialFocus={popupRef}
      showCloseButton={false}
      finalFocus={() => { const opener = returnFocusTo?.(); return opener && opener.isConnected ? opener : true; }}
      onKeyDown={(event) => {
        // A dialog portalled out of the viewer (a confirm, a note-delete) still bubbles its keys here through React: leave them to that dialog.
        const host = (event.target as Element).closest?.('[role=dialog],[role=alertdialog]');
        if (host && host !== event.currentTarget) return;
        (modeRef.current === "compare" ? compareRef.current : playerRef.current)?.handleKeyDown(event);
      }}
      className="top-0 left-0 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 text-foreground ring-0 focus-visible:!outline-none sm:max-w-none"
    >
      <OverlayContainerContext.Provider value={slot}>
      {/* The header sits outside the mode switch so the Compare button is the same node in both modes (focus survives the switch). */}
      {header}
      {comparing
        ? <>
          <Suspense fallback={null}>
            <LazyCompareView video={video} store={compareStore} social={socialMode} startFrame={startFrame} onChangeSide={changeSide} controlRef={compareRef} detailsFor={detailsFor} {...(notes ? { notes: { projectId: notes.projectId, role: notes.role, userId: notes.userId, archived: notes.archived, forms: notes.forms } } : {})} />
          </Suspense>
        </>
        : notes ? <Suspense fallback={null}><LazyNotesHost notes={notes} video={video} version={version} detailsRows={detailsRows}>{layout}</LazyNotesHost></Suspense> : layout(null)}
      </OverlayContainerContext.Provider>
      <div ref={setSlot} />
      <div ref={setToastSlot} />
    </DialogContent>
  </Dialog>;
}
