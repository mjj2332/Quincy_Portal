import { flushSync } from "react-dom";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, DownloadIcon, FolderDown, Maximize, MessageSquareWarning, Smartphone } from "lucide-react";
import { type Box, type GuestDecision, type GuestNoteThreadDto, type GuestSessionResponse, type GuestSocialOverlay, type GuestVideoDto } from "@quincy/shared";
import { mustTurnUpright, nextPrompt, rotate, readPhoneDevice, UPRIGHT_PROMPT, type ImmersivePrompt, type ImmersiveState } from "../lib/immersive";
import { readLandscape, useDeviceOrientation, useLandscape } from "../lib/use-device-orientation";
import { nativePlayerLabel } from "../lib/video-native-player";
import { hasOpenAlertDialog } from "../lib/alert-dialog-press";
import { hasOpenFloatingPopup, hasOpenModalAbove } from "../components/quincy/project-sheet-layers";
import { useImmersive } from "../components/quincy/use-immersive";
import { useCloseOnPlay } from "../components/quincy/use-close-on-play";
import { GuestImmersiveNoteCard } from "./GuestImmersiveNoteCard";
import { OverlayContainerContext } from "../components/OverlayContainerContext";
import { useFrameLabel } from "../lib/time-format-prefs";
import { useMediaQuery } from "../lib/use-media-query";
import type { VideoFrameClock } from "../lib/video-frame-clock";
import { Button } from "../components/reui/button";
import { Badge } from "../components/reui/badge";
import { STRIP_TEXT_BUTTON } from "../components/quincy/compose-strip";
import { Toggle } from "../components/reui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/reui/select";
import { Tabs, TabsList, TabsTrigger } from "../components/reui/tabs";
import { ReviewPhoneBar, VersionChip } from "../components/quincy/ReviewPhoneBar";
import { ActionRow, ActionSeparator, ReviewActionSheet } from "../components/quincy/ReviewActionSheet";
import { blurComposerField, isComposerField, useReviewSheet } from "../components/quincy/ReviewSheet";
import { PHONE_QUERY } from "../lib/review-pane-geometry";
import { useVisualViewport } from "../lib/use-visual-viewport";
import { useInkCanvas } from "../lib/use-ink-canvas";
import { VideoVersionsSheet, withSummaries, type VersionSheetRow } from "../components/video/VideoVersionsSheet";
import { ReviewSplit, useReviewPane, useReviewPaneControls } from "../components/quincy/ReviewPane";
import { VideoPlayer, type VideoPlayerControl } from "../components/quincy/VideoPlayer";
import type { SocialPreviewMode } from "../components/quincy/SocialPreviewControls";
import { currentOverlay, useSocialPreview } from "../lib/use-social-preview";
import type { TimelineMarker } from "../components/quincy/VideoTimelineMarkers";
import type { GuestApi, WriteResult } from "./guest-api";
import { decisionFailureText, failureText, openThreadCount, removeThread, upsertThread, type EditPatch } from "./guest-compose";
import type { ActionOutcome, NoteActions, Writing } from "./GuestNoteItem";
import { GuestNotesPanel } from "./GuestNotesPanel";
import { EmptyState } from "../components/quincy/EmptyState";
import { NotesFilterHead, blurNotesSearchField, type NotesSearchState } from "../components/quincy/NotesFilterHead";
import { GUEST_PHONE_FILTERS, guestNoteAuthors, guestNoteCounts, guestVisibleThreads, type GuestNoteFilters, type GuestNoteStatus } from "./guest-notes-filter";
import { GuestSubscriptionRow } from "./GuestSubscriptionRow";
import type { GuestSubscription } from "./guest-subscription";
import { GuestPasteDialog } from "./GuestPasteDialog";
import { GuestDecisionDialog, decisionDraftKey, type DecisionOutcome, type DecisionValue } from "./GuestDecisionDialog";
import { DecisionBadge, GuestDeliveryChips, ReleasedBadge } from "./GuestDeliveryChips";
import { GuestDownload, GuestDownloadLocked } from "./GuestDownload";
import { GuestDownloadAllButton } from "./GuestDownloadAll";
import { useGuestDownloadAll } from "./use-guest-download-all";
import type { GuestDrafts } from "./guest-drafts";
import { useGuestCompose } from "./use-guest-compose";
import { GuestNoteComposer } from "./GuestNoteComposer";
import { preloadGuestNoteEditor } from "./GuestNoteField";
import { EMPTY_MARKS, marksToFrames } from "../lib/video-note-marks";
import type { GuestVerify } from "./use-guest-verify";
import type { GuestWriter, Skipped, WriterBinding } from "./use-guest-writer";
import { useGuestMarkup } from "./GuestMarkup";
import { PremiumWatermark } from "./PremiumWatermark";

const VERSION_SELECT_ID = "guest-version";
const FIELD = "input, textarea, select, [contenteditable], [role=listbox], [role=combobox]";
const NOTES_HEADING = "m-0 text-foreground [font:var(--type-h3)]";
const MODAL = "[role=dialog], [role=alertdialog]";
const POPUP = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=combobox]";
const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
/** The phone header's ⋯ (`ReviewActionSheet`'s trigger): where focus returns from a dialog one of its rows opened, since the row is gone by then (#879 PR 3b). */
const headerMenu = () => document.querySelector<HTMLElement>('[data-testid="video-header-menu"]');

/** `[` and `]` step through the videos unless a field, list, modal or modifier owns the key. */
function useVideoStepKeys(onStep: (delta: -1 | 1) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key !== "[" && event.key !== "]") return;
      if (event.target instanceof Element && event.target.closest(`${FIELD}, ${MODAL}`)) return;
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
export function GuestVideoScreen({ api, verify, writer, drafts, subscription, session, onSession, archived, onArchived, videos, socialOverlays, index, onIndex, onBack, onUnavailable, onGrantsChanged, onDecided, onResyncDelivery, onShownVersion, identity = null, viewportRoot = null }: {
  api: GuestApi;
  /** The element the phone keyboard box is written on (#879 PR 2): `GuestApp`'s guest column, which holds the notices above this screen too. */
  viewportRoot?: HTMLElement | null;
  /** The "Reviewing as … / Not you? Sign out" row (#854), at the top of the notes-panel footer, above the email-updates switch. */
  identity?: ReactNode;
  /** The page's one verify dialog and continuation slot, owned by `GuestApp`. */
  verify: GuestVerify;
  /** Owned by `GuestApp`, so a write still out survives this screen being left and opened again. */
  writer: GuestWriter;
  drafts: GuestDrafts;
  /** The email-updates switch's state, owned by `GuestApp` for the same reason. */
  subscription: GuestSubscription;
  session: GuestSessionResponse;
  /** The session changed: verified (the verify route's body), or verification lost (a 401 on a write). */
  onSession: (next: GuestSessionResponse) => void;
  /** A write found the Project archived: notes are read-only from here. */
  archived: boolean;
  onArchived: () => void;
  videos: readonly GuestVideoDto[];
  /** The Project's resolved Social overlays (#872); none hides the Social control. */
  socialOverlays: readonly GuestSocialOverlay[];
  index: number;
  onIndex: (next: number) => void;
  /** Present only when there is a list to go back to (a single-Video link has none). */
  onBack: (() => void) | null;
  onUnavailable: () => void;
  /** The displayed Version is no longer granted: the freshly read list, for the page to show instead. */
  onGrantsChanged: (fresh: GuestVideoDto[]) => void;
  /** A decision landed on the Version `assetId` (the one it was sent for, which may no longer be the one on screen). */
  onDecided: (assetId: string, decision: GuestDecision) => void;
  /** A decision may or may not have landed: read the delivery list again. The page reconciles the result against the screen as it is when the answer arrives. */
  onResyncDelivery: () => void;
  /** The Version on screen now (null once this screen is left), so the page can reconcile against it whenever an answer arrives. */
  onShownVersion: (assetId: string | null) => void;
}) {
  const video = videos[index]!;
  const [assetId, setAssetId] = useState(video.versions[0]!.assetId);
  // A different Video starts on its latest granted Version.
  // Keyed on the Video's id, not the object: a decision landing replaces the Video object, and must not throw the guest back to the latest Version.
  useEffect(() => { setAssetId(video.versions[0]!.assetId); }, [video.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only a different Video resets the Version
  const version = video.versions.find((candidate) => candidate.assetId === assetId) ?? video.versions[0]!;

  const phone = useMediaQuery(PHONE_QUERY);
  const [threads, setThreads] = useState<GuestNoteThreadDto[] | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);
  // Popups (Version select, Versions and action sheets) portal into this slot, inside the inverse scope, not to body (#877).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const sheetControl = useReviewSheet({ drawing: false, filmAspect: version.height > 0 ? version.width / version.height : 16 / 9 });
  const sheetStopRef = useRef(sheetControl.stop);
  sheetStopRef.current = sheetControl.stop;
  const setSheetStop = sheetControl.onStop;
  // Full screen (#880; "immersive" is the code name): held here, above the layout, so it survives the 721px crossing a rotation makes. A phone that opens already sideways starts in it (D14).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [immersive, setImmersive] = useState<ImmersiveState>(() => rotate(null, { landscape: readLandscape(), phoneDevice: readPhoneDevice() }));
  const [composeShown, setComposeShown] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);
  useDeviceOrientation((landscape) => {
    const phoneDevice = readPhoneDevice();
    // A turn that enters Full screen (#880 S5) leaves the sheet's field: a turn is always sideways, and a sideways phone writes no note there (owner decision 2026-10-16), so
    // mid-compose the field is left (the draft stays in the composer) and the prompt asks to turn upright; mid-search search mode ends (the query stays).
    // Read at the turn, from this render's state, while the sheet's own blur path still runs.
    if (immersive === null && rotate(null, { landscape, phoneDevice }) !== null) {
      if (sheetControl.composing) { blurComposerField(); askUpright(); }
      else if (sheetControl.searching) { blurNotesSearchField(); sheetControl.onSearching(false); }
    }
    setImmersive((current) => rotate(current, { landscape, phoneDevice }));
  });
  const full = useImmersive({ rootRef, state: immersive, setState: setImmersive });
  const imm = immersive !== null;
  // The phone's handling (#880 S1): a phone width, or a phone device in Full screen. A sideways iPhone is 844pt wide, so `phone` is off, yet its keyboard still pans the
  // page: the root follows the visual viewport and the canvas is ink there too. In Full screen the keyboard going away blurs the composer's field and leaves the composer shown.
  const [phoneDevice] = useState(readPhoneDevice);
  // A sideways phone writes no note in Full screen (owner decision 2026-10-16): Add note shows the prompt instead, and a composer open when the phone turns closes, the draft kept.
  const sideways = useLandscape();
  const upright = mustTurnUpright({ immersive: imm, phoneDevice, landscape: sideways });
  const uprightRef = useRef(upright);
  uprightRef.current = upright;
  const [prompt, setPrompt] = useState<ImmersivePrompt | null>(null);
  const askUpright = useCallback(() => { setPrompt((previous) => nextPrompt(previous, UPRIGHT_PROMPT)); }, []);
  useEffect(() => { if (!upright) setPrompt(null); }, [upright]);
  const handheld = phone || (imm && phoneDevice);
  // The software keyboard went away without blurring the field (some iOS paths): blur it, so compose mode ends the ordinary way (#879 fix).
  // The guest column follows the visual viewport for as long as the phone screen is up (#879 PR 2, the staff viewer's r5 mechanism): the hook alone writes its height, transform
  // and transition, so the strip ends on the keyboard's top edge and the notices above the screen stay inside the box.
  // Searching too (#879 PR 3b, F1): the search field raises the keyboard without composing; its keyboard-gone fallback blurs the field and leaves search open.
  useVisualViewport(handheld && (sheetControl.composing || sheetControl.searching || (imm && composeShown)), () => { if (sheetControl.composing || (imm && composeShown)) { if (!sheetControl.held) blurComposerField(); } else blurNotesSearchField(); }, viewportRoot, handheld);
  // Meanwhile the document's canvas is ink: iOS shows it under the page while it scrolls back as the keyboard drops (#879 fix r11).
  useInkCanvas(handheld);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [summaries, setSummaries] = useState<{ videoId: string; rows: Parameters<typeof withSummaries>[1] } | null>(null);
  const [selectionCount, setSelectionCount] = useState(0);
  const [notesAttempt, setNotesAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState<VideoFrameClock | null>(null);
  const closeCard = useCallback(() => { setCardId(null); }, []);
  useCloseOnPlay(imm ? clock : null, cardId !== null, closeCard);
  // The side pane (#859): open / width are the per-browser preference the staff viewer shares. A phone keeps the drawer and ignores them.
  const reviewPane = useReviewPane(phone);
  const paneId = useId();
  const setPaneOpen = reviewPane.setOpen;
  // The pane's collapse control (#877 S2): ⇥ beside the Notes heading, ⇤ in a strip once collapsed. A phone has the drawer and no toggle.
  const paneControls = useReviewPaneControls({ open: reviewPane.open, onOpenChange: setPaneOpen, paneId, noun: "notes" });

  // Copy my notes (13d): the dialog, and what the last paste came to for the Version on screen.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState<string | null>(null);
  const resyncRef = useRef<() => void>(() => undefined);
  const binding = useRef<WriterBinding>({ scope: version.assetId, effects: { onUnverified: () => undefined, onGone: () => undefined, onArchived: () => undefined }, onLostSettle: () => undefined });
  binding.current.scope = version.assetId;
  binding.current.effects = {
    onUnverified: () => {
      // The paste dialog would sit over the verify dialog: close it before asking.
      setPasteOpen(false);
      verify.request(); onSession({ ...session, verified: false, email: null, name: null, notifications: null });
    },
    onGone: onUnavailable,
    onArchived,
  };
  binding.current.onLostSettle = () => { resyncRef.current(); };
  useEffect(() => {
    const mine = binding.current;
    writer.attach(mine);
    return () => { writer.detach(mine); };
  }, [writer]);

  useEffect(() => {
    let live = true;
    noteGeneration.current += 1;
    setThreads(null); setSelectedId(null); setNotesFailed(false);
    // A write that started or settled while this read was out has already applied its own, newer answer: drop the read and read again, so it can never overwrite that answer.
    const epoch = writer.epoch();
    void api.notes(version.assetId).then((result) => {
      if (!live) return;
      if (result.kind === "ok" && writer.epoch() !== epoch) { setNotesAttempt((n) => n + 1); return; }
      if (result.kind === "gone") onUnavailable();
      else if (result.kind === "transient") setNotesFailed(true);
      else setThreads(result.value);
    });
    return () => { live = false; };
  }, [api, version.assetId, notesAttempt, onUnavailable, writer]);

  // A stream that fails mid-play (a seek needing another range request) may mean staff revoked the link. The player has already shown its own notice; recheck access.
  // If the session is fine, the Video or this Version may still have been taken off the link: re-read the granted list, and leave only when the displayed Version is no longer in it.
  // Each recheck is bound to the Version it started on: a token that moves on every selection change and on unmount makes a late completion a no-op.
  const shownAssetId = version.assetId;
  useEffect(() => { onShownVersion(shownAssetId); }, [shownAssetId, onShownVersion]);
  useEffect(() => () => { onShownVersion(null); }, [onShownVersion]);
  const selectionToken = useRef(0);
  useEffect(() => {
    selectionToken.current += 1;
    return () => { selectionToken.current += 1; };
  }, [shownAssetId]);
  /** Rechecks access on the Version this call started on: the session, then the granted list. Resolves "valid" only when both are fine and the displayed Version is still granted; an
   * unavailable or grants-changed outcome has already been handed to the page ("handled"), and a late completion is "stale" and does nothing. */
  const recheckAccess = useCallback(async (): Promise<"valid" | "handled" | "stale" | "unknown"> => {
    const token = selectionToken.current;
    const stale = () => selectionToken.current !== token;
    const session = await api.session();
    if (stale()) return "stale";
    if (session.kind === "gone") { onUnavailable(); return "handled"; }
    if (session.kind !== "ok") return "unknown";
    const list = await api.videos();
    if (stale()) return "stale";
    if (list.kind === "gone") { onUnavailable(); return "handled"; }
    if (list.kind !== "ok") return "unknown";
    if (!list.value.some((candidate) => candidate.versions.some((granted) => granted.assetId === shownAssetId))) { onGrantsChanged(list.value); return "handled"; }
    return "valid";
  }, [api, onUnavailable, onGrantsChanged, shownAssetId]);
  // A stream that fails while the Version is still granted: another Version of this film may have been removed (#776 E), so the picker is read again. Quietly: no notice, no navigation unless the page decides the shown Version left.
  const onMediaError = useCallback(() => { void recheckAccess().then((outcome) => { if (outcome === "valid") onResyncDelivery(); }); }, [recheckAccess, onResyncDelivery]);
  // A markup read answered with the stub is not proof the link is gone: the drawing note may just have been deleted. Recheck access; if it is fine, drop the stale note and re-read the list.
  // The recovery also ends if the guest picks another note while it is in flight (`noteGeneration` moves on every selection), so it never deselects or refetches over a newer choice.
  const noteGeneration = useRef(0);
  const onMarkupGone = useCallback(() => {
    const generation = noteGeneration.current;
    void recheckAccess().then((outcome) => {
      if (outcome !== "valid" || noteGeneration.current !== generation) return;
      setSelectedId(null);
      setNotesAttempt((n) => n + 1);
    });
  }, [recheckAccess]);

  const step = useCallback((delta: -1 | 1) => { const next = index + delta; if (next >= 0 && next < videos.length) onIndex(next); }, [index, videos.length, onIndex]);
  useVideoStepKeys(step);
  const playerRef = useRef<VideoPlayerControl>(null);
  usePlayerKeysFromScreen(playerRef);

  // The Versions sheet's dates and open-note counts (D16), read when it opens; a failure only leaves them off. Fenced by Video.
  useEffect(() => {
    if (!phone || !versionsOpen) return;
    let live = true;
    void api.versionSummaries(video.id).then((result) => { if (live && result.kind === "ok") setSummaries({ videoId: video.id, rows: result.value }); });
    return () => { live = false; };
  }, [phone, versionsOpen, api, video.id]);
  const timecode = useFrameLabel(version);
  const selected = threads?.find((thread) => thread.id === selectedId) ?? null;
  const select = useCallback((thread: GuestNoteThreadDto) => {
    noteGeneration.current += 1;
    setSelectedId(thread.id);
    setSelectionCount((n) => n + 1);
    // A drawing shows only on the exact frame it was drawn on, which can sit anywhere inside the note's range: seek there, else to the anchor.
    const frame = thread.hasMarkup && thread.drawingFrame !== null ? thread.drawingFrame : thread.startFrame;
    if (frame !== null) clock?.seekToFrame(frame);
    setPaneOpen(true);
    if (phone && sheetStopRef.current === "collapsed") setSheetStop("half"); // a note or marker chosen while the sheet is collapsed opens it to half (D6)
  }, [clock, setPaneOpen, phone, setSheetStop]);
  const markupOverlay = useGuestMarkup(api, clock, selected, onMarkupGone, selectionCount);
  const watermark = video.premium && !video.unlocked;

  // Writes (#741 13c). Every answer is applied to the thread list by id, and only if it is not stale; the settle below is the one place a WriteResult becomes list state and words.
  const canWrite = session.link.allow.comments && !archived;
  const assetRef = useRef(version.assetId);
  assetRef.current = version.assetId;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  /** Reads the notes again without clearing the list (open forms and drafts stay). A write that starts or settles while the read is out has applied a newer answer: read again rather than overwrite it. */
  const resync = useCallback(() => {
    const asked = assetRef.current;
    const epoch = writer.epoch();
    const token = selectionToken.current;
    void api.notes(asked).then((result) => {
      // The token moves on every selection change and on unmount: a late answer for a Version the guest has left is a no-op.
      if (assetRef.current !== asked || selectionToken.current !== token) return;
      if (result.kind === "gone") onUnavailable();
      else if (result.kind !== "ok") return;
      else if (writer.epoch() !== epoch) resync();
      else setThreads(result.value);
    });
  }, [api, writer, onUnavailable]);
  resyncRef.current = resync;
  const settle = useCallback((result: WriteResult | Skipped, rootId: string | null): ActionOutcome => {
    // A stale answer changes nothing on this screen, but a write that landed is still a write that landed: the form that sent it is done.
    if (result.kind === "stale") return result.result.kind === "ok" ? { ok: false, message: null, saved: true } : { ok: false, message: null };
    if (result.kind === "busy") return { ok: false, message: "Another change to this note is still saving." };
    if (result.kind === "ok" || result.kind === "conflict") {
      if (result.thread !== null) { const fresh = result.thread; setThreads((list) => (list === null ? list : upsertThread(list, fresh))); }
      else if (rootId !== null) { setThreads((list) => (list === null ? list : removeThread(list, rootId))); setSelectedId((current) => (current === rootId ? null : current)); }
    } else if (result.kind === "deleted") setNotesAttempt((n) => n + 1);
    else if (result.kind === "unreachable") resync(); // the write may have landed: look before the guest sends it again
    const message = failureText(result);
    if (message === null) return { ok: true };
    return result.kind === "conflict" ? { ok: false, message, conflict: result.thread } : { ok: false, message };
  }, [resync]);
  const assetForWrites = version.assetId;
  // The phone notes filter's state (read further down). Declared here so a post can clear it.
  const [heldFilters, setNoteFilters] = useState<GuestNoteFilters>(GUEST_PHONE_FILTERS);
  // A sent note is listed (#879 PR 3b, S1, as the staff post): success clears the author and the search, which could hide it; the status stays the guest's choice. A post that lands
  // after a Version change clears nothing that matters: the filter scope has already cleared both for the new Version.
  const post = useCallback(async (input: Parameters<GuestApi["createNote"]>[1]) => {
    const outcome = settle(await writer.run(`new:${assetForWrites}`, () => api.createNote(assetForWrites, input)), null);
    if (outcome.ok) setNoteFilters((current) => (current.author === null && current.query === null ? current : { ...current, author: null, query: null }));
    return outcome;
  }, [api, writer, settle, assetForWrites]);
  const editRoot = useCallback(async (id: string, patch: EditPatch, expectedRevision: number): Promise<ActionOutcome> => {
    const current = threadsRef.current?.find((thread) => thread.id === id);
    if (current === undefined || current.deleted) return { ok: false, message: "This note was deleted." };
    return settle(await writer.run(id, () => api.editNote(id, { expectedRevision, ...patch })), id);
  }, [api, writer, settle]);
  const latestOf = useCallback((id: string) => threads?.find((thread) => thread.id === id) ?? null, [threads]);
  const actions = useMemo<NoteActions>(() => ({
    reply: async (root, content) => settle(await writer.run(root.id, () => api.replyToNote(root.id, content)), root.id),
    edit: async (root, note, content, expectedRevision) => settle(await writer.run(root.id, () => api.editNote(note.id, { expectedRevision, content })), root.id),
    remove: async (root, note, expectedRevision) => settle(await writer.run(root.id, () => api.deleteNote(note.id, expectedRevision)), note.id === root.id ? root.id : null),
  }), [api, writer, settle]);

  const compose = useGuestCompose({ phone, clock, frameCount: version.frameCount, timecode, markupAllowed: session.link.allow.markup, media: api.media, post, edit: editRoot, latestOf });
  // Social preview (#872): in memory, shared by every Video and Version of this screen, off again after All videos. Nothing else changes (#877): notes, marks and drawing work with it on, and turning it on or off touches no draft or drawing.
  const preview = useSocialPreview();
  const socialOn = preview.on && socialOverlays.length > 0;
  const setSocial = preview.setOn;
  const socialMode: SocialPreviewMode | undefined = socialOn ? {
    overlays: socialOverlays, currentId: currentOverlay(socialOverlays, preview.overlayId)?.id ?? null, onOverlay: preview.setOverlayId,
    status: "ready", onRetry: () => undefined,
  } : undefined;
  // The range button and handles (#861) exist where the link allows comments; they take the open draft's marks and are disabled with no draft (the hint says how to start one), an archived Project, or marks the draft has locked (a drawing).
  const rangeProps = session.link.allow.comments ? {
    range: { marks: compose.isOpen ? compose.marks : EMPTY_MARKS, locked: archived || !compose.onMark, ...(!compose.isOpen && !archived ? { hint: "Add a note to mark a range" } : {}), clear: compose.clearMarks },
    pendingRange: compose.isOpen ? marksToFrames(compose.marks, version.frameCount) : null,
  } : {};
  // A draft belongs to the Version it was made on; an archived Project takes it away.
  const { close: closeComposer, editingId } = compose;
  // Back in the sheet (#880 S5), compose mode follows where the focus really is: in Full screen nothing reported the field's blur (the sheet's blur check is off there).
  const syncComposing = sheetControl.onComposing;
  useEffect(() => { if (!imm && phone) syncComposing(isComposerField(document.activeElement)); }, [imm, phone, syncComposing]);
  useEffect(() => { if (!imm) setCardId(null); }, [imm]);
  useEffect(() => { setCardId(null); }, [version.assetId, video.id]);
  /** Put the floating composer away (the draft stays) with focus already on Add note: lesson P3, focus moves before the pane holding it is hidden. */
  const hideComposer = useCallback(() => { document.querySelector<HTMLElement>('[data-testid="video-immersive-add-note"]')?.focus({ preventScroll: true }); setComposeShown(false); }, []);
  // Leaving Full screen, a Version change or a finished/cancelled draft puts the floating composer away. A draft that closes in Full screen (Cancel, a post) hands the focus to
  // Add note before the pane hides, as the toggle does (#880 fix round 1, item 2; lesson P3): left in the closing pane it would fall to the page.
  useLayoutEffect(() => {
    if (composeShown && upright) { blurComposerField(); hideComposer(); askUpright(); return; }
    if (!composeShown || (imm && compose.isOpen)) return;
    if (!imm) { setComposeShown(false); return; }
    const active = document.activeElement;
    const pane = rootRef.current?.querySelector('[data-testid="video-review-pane"]');
    if (active === null || active === document.body || (pane?.contains(active) ?? false)) hideComposer(); else setComposeShown(false);
  }, [imm, compose.isOpen, composeShown, hideComposer, upright, askUpright]);
  useEffect(() => { closeComposer(); }, [version.assetId, closeComposer]);
  useEffect(() => { if (archived) closeComposer(); }, [archived, closeComposer]);
  // A paste belongs to the Version it was made for.
  useEffect(() => { setPasteOpen(false); setPasted(null); }, [version.assetId]);
  useEffect(() => { if (archived) setPasteOpen(false); }, [archived]);
  // An edit of a note that has since been deleted (here or elsewhere) has nothing left to save to.
  // Only a notes read that has completed can say so: while a re-read is out (after re-verifying) `threads` is null, which is "not known yet", not "gone".
  const editedGone = editingId !== null && threads !== null && (latestOf(editingId)?.deleted ?? true);
  useEffect(() => { if (editedGone) closeComposer(); }, [editedGone, closeComposer]);

  // The phone notes filter (#879 PR 3b, P2 `NotesFilter`): status, author and search, phone only (a desktop guest sees every note, as before). A phone guest starts on Open. The author
  // and the search belong to one Version and one layout: they clear in render when either changes, so no frame shows them over another Version's notes. Status carries over.
  const [filterScope, setFilterScope] = useState({ assetId: version.assetId, phone });
  const scopeMoved = filterScope.assetId !== version.assetId || filterScope.phone !== phone;
  if (scopeMoved) {
    setFilterScope({ assetId: version.assetId, phone });
    if (heldFilters.author !== null || heldFilters.query !== null) setNoteFilters({ ...heldFilters, author: null, query: null });
  }
  const noteAuthorOptions = useMemo(() => guestNoteAuthors(threads ?? []), [threads]);
  // An author with no notes left reads as Everyone.
  const noteFilters = useMemo<GuestNoteFilters>(() => {
    const scoped = scopeMoved ? { ...heldFilters, author: null, query: null } : heldFilters;
    return scoped.author !== null && !noteAuthorOptions.some((option) => option.key === scoped.author) ? { ...scoped, author: null } : scoped;
  }, [heldFilters, scopeMoved, noteAuthorOptions]);
  // A root with an edit or a reply open on it stays listed whatever the filters say: the drafts store says which (it outlives the list), and the pill's edit is `editingId`.
  const pinnedKey = useSyncExternalStore(drafts.subscribe, () => (threads ?? []).filter((thread) => thread.id === editingId || drafts.get(`edit:${thread.id}`) !== null || drafts.get(`reply:${thread.id}`) !== null).map((thread) => thread.id).join(","));
  const pinned = useMemo(() => new Set(pinnedKey === "" ? [] : pinnedKey.split(",")), [pinnedKey]);
  const listedThreads = useMemo(() => (threads === null || !phone ? threads : guestVisibleThreads(threads, noteFilters, pinned)), [threads, phone, noteFilters, pinned]);
  // Markers follow the filters alone on a phone (a pinned root is not a filter result); a desktop marks every live note.
  const markers = useMemo<TimelineMarker[]>(() => (phone && threads ? guestVisibleThreads(threads, noteFilters, new Set()) : threads ?? []).filter((thread) => thread.startFrame !== null && !thread.deleted)
    .map((thread) => ({ id: thread.id, startFrame: thread.startFrame!, endFrame: thread.endFrame, tone: "public" as const, selected: thread.id === selectedId, createdAt: thread.createdAt })), [threads, phone, noteFilters, selectedId]);
  const noteCountsByStatus = useMemo(() => guestNoteCounts(threads ?? [], noteFilters), [threads, noteFilters]);
  const anyNotes = threads !== null && guestNoteCounts(threads, { status: "all", author: null, query: null }).all > 0;
  // Search takes the sheet to full while the keyboard is up, and back to the stop it was at when it closes (owner decision); a stop dragged to meanwhile is the guest's.
  const searchReturn = useRef<typeof sheetControl.stop | null>(null);
  const onSearching = sheetControl.onSearching;
  const onSearchChange = useCallback((state: NotesSearchState) => {
    // Typing is the sheet's search mode (F1): the film gives way so the field and the results stand above the keyboard.
    onSearching(state === "typing");
    if (state !== "closed") { if (searchReturn.current === null) { searchReturn.current = sheetStopRef.current; setSheetStop("full"); } return; }
    const back = searchReturn.current;
    searchReturn.current = null;
    if (back !== null && sheetStopRef.current === "full") setSheetStop(back);
  }, [setSheetStop, onSearching]);
  const notesHead = phone && anyNotes ? <NotesFilterHead<GuestNoteStatus, never>
    status={{ label: "Show notes that are", value: noteFilters.status, onChange: (status) => { setNoteFilters({ ...noteFilters, status }); }, options: [{ value: "open", label: "Open", count: noteCountsByStatus.open }, { value: "resolved", label: "Resolved", count: noteCountsByStatus.resolved }, { value: "all", label: "All", count: noteCountsByStatus.all }] }}
    authors={{ value: noteFilters.author, options: noteAuthorOptions, onChange: (author) => { setNoteFilters({ ...noteFilters, author }); } }}
    query={noteFilters.query}
    onQueryChange={(query) => { setNoteFilters({ ...noteFilters, query }); }}
    onSearchChange={onSearchChange}
  /> : null;
  const filteredEmpty = phone && anyNotes
    ? <EmptyState size="compact" data-testid="guest-notes-filtered-empty" title="No notes match."><Button type="button" variant="ghost" data-testid="guest-notes-reset-filters" className={TOUCH} onClick={() => { setNoteFilters(GUEST_PHONE_FILTERS); }}>Reset filters</Button></EmptyState>
    : undefined;

  // The phone sheet (#879): the film stays on top at every stop, so opening a draft needs no drawer dance; the composer is the sheet's foot (compose and draw modes follow the editor's focus and the pen).
  const startDraft = useCallback((start: () => void) => { start(); }, []);

  // What the guest was doing when verification was asked for, so a successful code lands them where they were going. Each request carries its own, and the page's verify owner keeps only the newest active one.
  const afterVerify = useRef<(then: "compose" | "download" | DecisionValue) => void>(() => undefined);
  const requestVerify = useCallback((then: "compose" | "download" | "none" | DecisionValue, active: () => boolean = () => true) => {
    // On a phone, verifying for a note ends in the pill's field with the focus, which the closing dialog must leave there (#879 PR 2).
    verify.request({ active, keepFocus: phone && then === "compose", done: (verified) => {
      if (verified && then !== "none") afterVerify.current(then);
    } });
  }, [verify, phone]);
  // The notes read before verifying carried no 'self' marks: whoever caused the verification (this screen's actions or Download all), read them again as the verified guest.
  const wasVerified = useRef(session.verified);
  useEffect(() => { if (session.verified && !wasVerified.current) setNotesAttempt((n) => n + 1); wasVerified.current = session.verified; }, [session.verified]);
  const { beginEdit } = compose;
  const { focusField } = compose.strip;
  const writing = useMemo<Writing>(() => ({
    canWrite, verified: session.verified, media: api.media, actions, drafts, onNeedVerify: () => { requestVerify("none"); },
    // On a phone the edit opens in the pill, and its field takes the focus inside ⋯ Edit's click, so iOS raises the keyboard (#879 PR 2).
    composerOpen: compose.isOpen, editRoot: (thread) => { startDraft(() => { beginEdit(thread); }); if (phone) focusField(); }, editTakesFocus: phone,
  }), [canWrite, session.verified, api, actions, drafts, requestVerify, compose.isOpen, startDraft, beginEdit, phone, focusField]);
  const canPaste = canWrite && video.versions.length >= 2;
  const openPaste = () => {
    if (!session.verified) { requestVerify("none"); return; }
    setPasted(null);
    setPasteOpen(true);
  };
  const changePasteOpen = (next: boolean) => { setPasteOpen(next); };
  const pasteStatus = pasted !== null ? <p role="status" data-testid="guest-paste-status" className="m-0 text-foreground-secondary [font:var(--type-label)]">{pasted}</p> : null;
  // On a phone the sheet ends in the pill at every stop (#879 PR 2, P2); Copy my notes is a row of the ⋯ sheet there, and its status a line in the notes body.
  const addNote = !canWrite ? null : phone
    ? <GuestNoteComposer strip={compose.strip} clock={clock} timecode={timecode} media={api.media} verified={session.verified} onShellPress={() => { preloadGuestNoteEditor(); requestVerify("compose"); }} />
    : <>{compose.isOpen ? compose.form : <div className="flex flex-col items-start gap-[var(--space-2)]">
      <Button type="button" variant="outline" data-testid="guest-add-note" className={TOUCH} onClick={() => { if (session.verified) startDraft(compose.begin); else requestVerify("compose"); }}>Add a note</Button>
      {canPaste && <Button type="button" variant="ghost" data-testid="guest-paste-open" className={TOUCH} onClick={openPaste}>Copy my notes from another version</Button>}
      {pasteStatus}
    </div>}</>;

  // Approve / Request changes (#741 14-ui-guest). The note draft is in `drafts` and the write is the writer's, so both outlive this screen; the dialog is per Version and decision.
  const [decideFor, setDecideFor] = useState<DecisionValue | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  // Every opening of the dialog gets an id. A completion closes the dialog only if the opening it came from is still the one showing; the decision itself applies by Version either way.
  const opening = useRef(0);
  const openDecision = useCallback((value: DecisionValue) => { opening.current += 1; setDecideFor(value); }, []);
  // After verifying for Download, the Download button becomes the anchor and the guest presses it again (a click made after the async verification would be blocked as a popup).
  const [downloadHint, setDownloadHint] = useState(false);
  const immRef = useRef(imm);
  immRef.current = imm;
  const cardRef = useRef(cardId);
  cardRef.current = cardId;
  const composeShownRef = useRef(composeShown);
  composeShownRef.current = composeShown;
  useEffect(() => { opening.current += 1; setDecideFor(null); setDecisionNotice(null); setDownloadHint(false); }, [version.assetId]);
  const canDecide = session.link.allow.approve && !archived;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const confirmDecision = useCallback(async (value: DecisionValue, note: string | undefined): Promise<DecisionOutcome> => {
    // Everything below is about the Version the decision was sent for, however far the guest has moved on by the time it settles.
    const sentFor = version.assetId;
    const mine = opening.current;
    const closeIfShowing = () => { if (opening.current === mine) setDecideFor(null); };
    const key = decisionDraftKey(sentFor, value);
    const rev = drafts.get(key)?.rev ?? null;
    const result = await writer.run(`decision:${sentFor}`, () => api.decide(sentFor, value, note));
    if (result.kind === "busy") return { ok: false, message: "Your last answer is still being sent." };
    const stale = result.kind === "stale";
    const settled = result.kind === "stale" ? result.result : result;
    if (settled.kind === "ok") {
      onDecided(sentFor, settled.decision);
      if (rev !== null) drafts.clearIf(key, rev);
      if (stale) return { ok: false, message: null };
      closeIfShowing();
      return { ok: true };
    }
    if (settled.kind === "conflict" || settled.kind === "unreachable") onResyncDelivery(); // the decision may exist: look before the guest sends it again
    if (stale) return { ok: false, message: null };
    // An older request that needs verification has already marked the session unverified; it only decides the dialog and what verifying leads to while it is still the opening showing.
    if (settled.kind === "unverified") { if (opening.current === mine) { closeIfShowing(); requestVerify(value, () => opening.current === mine); } }
    else if (settled.kind === "archived" || settled.kind === "gone") closeIfShowing();
    else if (settled.kind === "disabled") {
      closeIfShowing(); setDecisionNotice("Approving is no longer available on this link.");
      const now = sessionRef.current;
      onSession({ ...now, link: { ...now.link, allow: { ...now.link.allow, approve: false } } });
    }
    return { ok: false, message: decisionFailureText(settled) };
  }, [api, writer, drafts, version.assetId, onDecided, onResyncDelivery, onSession, requestVerify]);
  afterVerify.current = (then) => {
    // On a phone the code lands the guest in the pill's field (the focus starts the draft) when the keyboard is still up: the code field kept the focus through the check, and iOS
    // keeps the keyboard for a focus moving from one field to another. A focus after the check with the keyboard gone (the guest put it away) is not a tap, so iOS would show a caret
    // with no keyboard and then drop compose mode: the guest lands at rest instead, and one tap on the pill starts the note (PR 2 fix round 1).
    // In Full screen (#880) the floating composer is shown first, in the same commit, so the field it focuses is not inside a hidden pane.
    if (then === "compose" && uprightRef.current) askUpright();
    else if (then === "compose") { if (immRef.current) flushSync(() => { setComposeShown(true); }); if (!phone) startDraft(compose.begin); else if (keyboardField(document.activeElement)) focusField(); }
    else if (then === "download") setDownloadHint(true);
    else openDecision(then);
  };
  // Which control opened the decision: a ⋯ row is gone when its dialog closes, so focus goes back to the ⋯; the header's Approve keeps the default return.
  const decisionFromSheet = useRef(false);
  const startDecision = (value: DecisionValue, fromSheet = false) => { decisionFromSheet.current = fromSheet; if (session.verified) openDecision(value); else requestVerify(value); };
  const allowDownload = session.link.allow.download;
  // Download all (#741 14-ui-guest) on a film of a multi-film link: one controller for both layouts, so a crossing keeps its dialog. A desktop draws its button in the delivery row; a phone, a ⋯ row (P10).
  const downloadAll = useGuestDownloadAll({ api, verify, session, onSession, onUnavailable, finalFocus: phone ? headerMenu : undefined });
  const offerDownloadAll = videos.length > 1;

  const savedHidden = compose.replacesSavedDrawing(selectedId);
  const overlay = useCallback((box: Box | null) => <>{!savedHidden && markupOverlay(box)}{compose.overlay(box)}</>, [savedHidden, markupOverlay, compose.overlay]); // eslint-disable-line react-hooks/exhaustive-deps -- compose.overlay is the dependency that matters

  const newest = video.versions[0]!.version;
  const optionLabel = (candidate: GuestVideoDto["versions"][number]) => `v${candidate.version}${candidate.version === newest ? " · latest" : ""}`;
  // The open notes (#879 PR 2, owner decision: the phone tab and the desktop heading both, 0 included).
  const headingContent = <>Notes{threads !== null && <><span className="sr-only"> </span><span data-testid="guest-notes-count" className="ms-[var(--space-1)] text-foreground-secondary [font:var(--type-label)]">{openThreadCount(threads)}</span><span className="sr-only"> open</span></>}</>;
  const heading = <h2 data-testid="guest-notes-heading" className={NOTES_HEADING}>{headingContent}</h2>;
  // The phone tab's count is P2's chip (#879 PR 3a): a secondary Badge, as on the staff Notes tab.
  const tabContent = <>Notes{threads !== null && <><span className="sr-only"> </span><Badge variant="secondary" data-testid="guest-notes-count" className="tabular-nums">{openThreadCount(threads)}</Badge><span className="sr-only"> open</span></>}</>;
  const toggleSubscription = useCallback((next: boolean, previous: boolean) => { void subscription.toggle(next, previous, () => writer.runLink("subscription", () => api.setSubscription(next))); }, [subscription, writer, api]);
  const subscriptionRow = session.verified && session.notifications?.available
    ? <GuestSubscriptionRow store={subscription} initial={session.notifications.subscribed} readOnly={archived} onToggle={toggleSubscription} />
    : null;
  const downloadHintLine = downloadHint && session.verified && version.downloadUrl !== null ? <p role="status" data-testid="guest-download-hint" className="m-0 text-foreground-secondary [font:var(--type-label)]">You're verified. Press Download to start it.</p> : null;
  const decisionNoticeLine = decisionNotice !== null ? <p role="status" data-testid="guest-decision-notice" className="m-0 text-foreground-secondary [font:var(--type-label)]">{decisionNotice}</p> : null;
  // P2's quiet line (#879 PR 3b) at the end of the phone's notes scroll: Released first (a session default, no frame), then the hints and notices the delivery row held, then who is reviewing and email updates.
  const quietLine = <div data-testid="guest-quiet-line" className="flex flex-wrap items-center gap-[var(--space-2)] empty:hidden">
    {version.released && <ReleasedBadge />}
    <GuestDownloadLocked video={video} version={version} allowDownload={allowDownload} />
    {downloadHintLine}
    {decisionNoticeLine}
    {pasteStatus}
    {offerDownloadAll && downloadAll.notice}
  </div>;
  const footer = phone
    ? <>{quietLine}{session.verified && <>{identity}{subscriptionRow}</>}</>
    : session.verified ? <>{identity}{subscriptionRow}</> : null;
  // The desktop delivery row (chips, Approve, Request changes, Download, Download all, the hints). A phone has none (#879 PR 3b): the decision is in the header's Approve slot, the
  // actions are ⋯ rows (P10), and the rest is the quiet line.
  const deliveryRow = <div data-testid="guest-delivery" className="flex flex-wrap items-center gap-[var(--space-2)] empty:hidden min-[721px]:px-[var(--space-4)] min-[721px]:pb-[var(--space-2)]">
    <GuestDeliveryChips version={version} />
    {canDecide && <>
      <Button type="button" variant={version.decision?.value === "approved" ? "outline" : "default"} data-testid="guest-approve" className={TOUCH} onClick={() => { startDecision("approved"); }}><Check aria-hidden="true" />Approve</Button>
      <Button type="button" variant="outline" data-testid="guest-request-changes" className={TOUCH} onClick={() => { startDecision("changes_requested"); }}><MessageSquareWarning aria-hidden="true" />Request changes</Button>
    </>}
    <GuestDownload video={video} version={version} allowDownload={allowDownload} verified={session.verified} onNeedVerify={() => { requestVerify("download"); }} />
    {offerDownloadAll && <GuestDownloadAllButton controller={downloadAll} />}
    {downloadHintLine}
    {decisionNoticeLine}
  </div>;
  // Full screen. A marker press pauses and shows the root note as a card (the drawer stays where it is: D19). Add note pauses, stamps the frame, floats the composer and focuses the editor inside the press.
  const cardThread = cardId === null ? undefined : threads?.find((thread) => thread.id === cardId);
  const onMarkerTap = (id: string) => {
    const thread = threads?.find((candidate) => candidate.id === id);
    if (!thread || compose.drawing) return;
    clock?.pause();
    noteGeneration.current += 1;
    setSelectedId(thread.id); setSelectionCount((n) => n + 1);
    const frame = thread.hasMarkup && thread.drawingFrame !== null ? thread.drawingFrame : thread.startFrame;
    if (frame !== null) clock?.seekToFrame(frame);
    setCardId(id);
  };
  const toggleAddNote = () => {
    if (composeShown) { hideComposer(); return; }
    if (upright) { askUpright(); return; }
    setCardId(null);
    if (!session.verified) { requestVerify("compose"); return; }
    clock?.pause();
    flushSync(() => { if (!compose.isOpen) compose.begin(); setComposeShown(true); });
    focusField();
  };
  const immersiveHost = {
    on: imm, onToggle: full.toggle, heading: `${video.title} · v${version.version}`,
    ...(canWrite ? { addNote: { pressed: composeShown, onToggle: toggleAddNote } } : {}),
    onMarkerTap,
    prompt,
    ...(cardThread ? { card: <GuestImmersiveNoteCard thread={cardThread} timecode={timecode} media={api.media} onClose={closeCard} onShowInNotes={() => { full.leave(); setPaneOpen(true); openSheet(); }} /> } : {}),
  };
  // Escape: its own ladder (the page is not a dialog). A popup or modal that is open owns the key; then the card, then the floating composer (the draft stays), then Full screen itself. Decided at capture, before any popup handler has run.
  useEffect(() => {
    if (!imm) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const root = rootRef.current;
      if (hasOpenAlertDialog() || hasOpenFloatingPopup(root, slot) || hasOpenModalAbove(root, document)) return;
      event.preventDefault();
      if (cardRef.current !== null) setCardId(null);
      else if (composeShownRef.current) hideComposer();
      else full.leave();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); };
  }, [imm, slot, hideComposer, full]);
  const panel = <GuestNotesPanel threads={listedThreads} failed={notesFailed} onRetry={() => { setNotesAttempt((n) => n + 1); }} selectedId={selectedId} onSelect={select} timecode={timecode} {...(filteredEmpty ? { filteredEmpty } : {})} header={phone ? notesHead : <div className="flex items-center justify-between gap-[var(--space-2)]">{heading}{paneControls.hideButton}</div>} top={addNote} footer={footer} writing={writing} phone={phone} />;
  const openSheet = () => { if (sheetStopRef.current === "collapsed") setSheetStop("half"); };
  // Draw mode from the moment the pen goes down (its frame confirm included), so the sheet does not flash back to its browse stop meanwhile (#879 PR 2).
  const sheet = phone ? { ...sheetControl, mode: compose.penDown ? "draw" as const : sheetControl.mode } : undefined;
  const latestLabel = `v${version.version}${version.version === newest ? " · latest" : ""}`;
  // P10's rows (#879 PR 3b), in the settled order: Social preview, Download vN, Download all…, Copy my notes…, then the decisions under a rule. Approve is a row only while
  // the header's slot holds the Changes requested badge (owner decision; F6: undecided, the header's Approve is the one way in, and an approval leaves nothing to approve).
  const downloadRow = allowDownload && version.downloadUrl !== null;
  const downloadAllRow = offerDownloadAll && downloadAll.state === "ready";
  // The system player row (#880 S6, F4) is always there (disabled, with its hint, where the browser has no player of its own), so the ⋯ always has an action, as the staff ⋯ does,
  // and the decisions always sit under a rule.
  const phoneBar = <>
    <ReviewPhoneBar
      back={onBack ? <Button type="button" variant="ghost" className={`${TOUCH} shrink-0 max-[721px]:min-w-11`} onClick={onBack}><ChevronLeft aria-hidden="true" /><span className="sr-only">All videos</span></Button> : null}
      title={<h1 data-testid="guest-video-title" title={video.title} className="m-0 w-full min-w-[6rem] truncate [font:var(--type-body)]">{video.title}</h1>}
      chip={<VersionChip buttonRef={chipRef} label={latestLabel} onClick={() => { setVersionsOpen(true); }} />}
      // A recorded decision takes the Approve slot as its badge (P2), whether or not the link still lets the guest decide.
      approve={version.decision !== null ? <DecisionBadge decision={version.decision} icon /> : canDecide ? <Button type="button" size="sm" variant="outline" data-testid="guest-approve" className={STRIP_TEXT_BUTTON} onClick={() => { startDecision("approved"); }}>Approve</Button> : undefined}
      actions={<ReviewActionSheet container={slot}>
        {(close) => <>
          {socialOverlays.length > 0 && <ActionRow testId="guest-social-toggle" icon={<Smartphone aria-hidden="true" />} pressed={socialOn} onSelect={() => { setSocial(!socialOn); close(); }}>Social preview</ActionRow>}
          {downloadRow && (session.verified
            ? <ActionRow testId="guest-download" icon={<DownloadIcon aria-hidden="true" />} href={version.downloadUrl ?? undefined} download onSelect={() => { close(); }}>{`Download v${version.version}`}</ActionRow>
            : <ActionRow testId="guest-download" icon={<DownloadIcon aria-hidden="true" />} onSelect={() => { close(true); requestVerify("download"); }}>{`Download v${version.version}`}</ActionRow>)}
          {downloadAllRow && <ActionRow testId="guest-download-all" icon={<FolderDown aria-hidden="true" />} onSelect={() => { close(true); downloadAll.start(); }}>Download all…</ActionRow>}
          <ActionRow testId="guest-open-system-player" icon={<Maximize aria-hidden="true" />} disabled={!(playerRef.current?.nativePlayerSupported?.() ?? false)} hint={(playerRef.current?.nativePlayerSupported?.() ?? false) ? undefined : "This browser has no player of its own to open the film in."} onSelect={() => { playerRef.current?.openSystemPlayer?.(); close(); }}>{nativePlayerLabel()}</ActionRow>
          {canPaste && <ActionRow testId="guest-paste-open" icon={<Copy aria-hidden="true" />} onSelect={() => { close(true); openPaste(); }}>Copy my notes…</ActionRow>}
          {canDecide && <>
            <ActionSeparator />
            {/* Approve here only when the header's slot holds the Changes requested badge (#879 PR 3b, F6): undecided, the header's Approve button is the one way in, and approved has nothing to approve. */}
            {version.decision?.value === "changes_requested" && <ActionRow testId="guest-approve-row" icon={<Check aria-hidden="true" />} onSelect={() => { close(true); startDecision("approved", true); }}>Approve</ActionRow>}
            <ActionRow testId="guest-request-changes" icon={<MessageSquareWarning aria-hidden="true" />} onSelect={() => { close(true); startDecision("changes_requested", true); }}>Request changes…</ActionRow>
          </>}
        </>}
      </ReviewActionSheet>}
    />
    <VideoVersionsSheet
      open={versionsOpen} onOpenChange={setVersionsOpen} container={slot} returnFocusTo={chipRef} currentAssetId={version.assetId} onChoose={setAssetId}
      rows={withSummaries(video.versions.map((candidate): VersionSheetRow => ({ assetId: candidate.assetId, version: candidate.version })), summaries?.videoId === video.id ? summaries.rows : undefined)}
    />
  </>;

  // The page is not a dialog, so in Full screen the root becomes a fixed layer over it and floating-ui keeps Tab inside it (#880). Its containing block is the guest column, which the
  // visual-viewport hook transforms while it tracks the keyboard: `fixed inset-0` then fills the visual viewport's box, not the layout viewport.
  const { context: trapContext, refs: trapRefs } = useFloating({ open: imm });
  const setRoot = useCallback((element: HTMLDivElement | null) => { rootRef.current = element; trapRefs.setFloating(element); }, [trapRefs]);
  return <FloatingFocusManager context={trapContext} modal returnFocus={false} initialFocus={-1} disabled={!imm}>
  <div ref={setRoot} data-testid="guest-video-screen" data-surface="inverse" {...(imm ? { "data-immersive": "" } : {})} className={`flex min-h-0 flex-1 flex-col bg-background text-foreground${imm ? " fixed inset-0 z-[var(--z-dialog)]" : ""}`}>
    {/* The bar, the delivery row and the decision badge (the phone bar's Approve slot) go away in Full screen, hidden and inert but mounted. */}
    <div data-testid="guest-header-hide" className={imm ? "hidden" : "contents"} inert={imm}>
    {phone ? phoneBar : <header className="flex flex-col border-b border-border bg-card text-card-foreground">
     <div data-testid="guest-bar" className="flex min-h-12 flex-nowrap items-center gap-x-[var(--space-3)] px-[var(--space-4)] py-[var(--space-1)]">
      {onBack && <Button type="button" variant="ghost" className={`${TOUCH} shrink-0`} onClick={onBack}><ChevronLeft aria-hidden="true" /><span>All videos</span></Button>}
      <h1 data-testid="guest-video-title" title={video.title} className="m-0 min-w-0 flex-1 truncate [font:var(--type-body)]">{video.title}</h1>
      <div className="flex min-w-0 flex-none items-center gap-[var(--space-3)]">
      {videos.length > 1 && <div className="flex items-center gap-[var(--space-2)]">
        <Button type="button" variant="outline" size="icon" aria-label="Previous video" className={TOUCH} disabled={index === 0} onClick={() => { step(-1); }}><ChevronLeft aria-hidden="true" /></Button>
        <span data-testid="guest-video-position" className="text-foreground-secondary tabular-nums [font:var(--type-label)]">{`${index + 1} of ${videos.length}`}</span>
        <Button type="button" variant="outline" size="icon" aria-label="Next video" className={TOUCH} disabled={index === videos.length - 1} onClick={() => { step(1); }}><ChevronRight aria-hidden="true" /></Button>
      </div>}
      <div className="flex min-w-0 max-w-full items-center gap-[var(--space-2)]">
        <label htmlFor={VERSION_SELECT_ID} className="shrink-0 text-foreground-secondary [font:var(--type-label)]">Version</label>
        <OverlayContainerContext.Provider value={slot}>
        <Select value={version.assetId} onValueChange={(next) => { if (typeof next === "string") setAssetId(next); }}>
          <SelectTrigger id={VERSION_SELECT_ID} data-testid="guest-version-trigger" className={`${TOUCH} min-w-0 max-w-full`}>
            <SelectValue>{() => <span className="block truncate">{optionLabel(version)}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {video.versions.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} className={TOUCH}>{optionLabel(candidate)}</SelectItem>)}
          </SelectContent>
        </Select>
        </OverlayContainerContext.Provider>
      </div>
      {socialOverlays.length > 0 && <Button type="button" variant="outline" aria-pressed={socialOn} onClick={() => { setSocial(!socialOn); }} data-testid="guest-social-toggle" aria-label="Social preview" className={`${TOUCH} aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:!text-foreground`}>
        <Smartphone aria-hidden="true" /><span>Social preview</span>
      </Button>}
      </div>
     </div>
      {deliveryRow}
    </header>}
    </div>
    <ReviewSplit
      open={reviewPane.open}
      width={reviewPane.width}
      onWidth={reviewPane.setWidth}
      onNarrow={reviewPane.onNarrow}
      paneId={paneId}
      handleLabel="Resize notes"
      stacked={phone}
      immersive={imm ? (composeShown ? "compose" : "watch") : "off"}
      {...(sheet ? { sheet } : {})}
      strip={paneControls.strip}
      player={<OverlayContainerContext.Provider value={slot}><VideoPlayer key={version.assetId} controlRef={playerRef} keyboard="host" phoneFrameStep={!canWrite} version={version} title={`${video.title}, version ${version.version}`} className="flex-1" markers={markers} onMarkerSelect={(id) => { const thread = threads?.find((candidate) => candidate.id === id); if (thread) select(thread); }} onClockChange={setClock} {...rangeProps} {...(compose.onMark ? { onMark: (kind: "in" | "out", frame: number) => { setPaneOpen(true); compose.onMark!(kind, frame); } } : {})} overlay={overlay} watermark={watermark ? (box) => <PremiumWatermark box={box} /> : undefined} {...(socialMode ? { social: socialMode } : {})} onMediaError={onMediaError} transportReplacement={compose.transportReplacement} transportHidden={phone && (sheetControl.mode === "search" || (sheetControl.mode === "compose" && !compose.penDown))} immersive={immersiveHost} /></OverlayContainerContext.Provider>}
      // The pane's popups (a note's ⋯ menu) portal into the same slot as the player's, inside the inverse scope (fix round 1: they drew light on the dark viewer).
      pane={<OverlayContainerContext.Provider value={slot}><aside data-testid="guest-notes-aside" className="flex min-h-0 flex-1 flex-col bg-card text-card-foreground min-[721px]:overflow-hidden min-[721px]:border-l min-[721px]:border-border min-[721px]:p-[var(--space-5)] min-[721px]:in-data-[immersive=compose]:border-l-0 min-[721px]:in-data-[immersive=compose]:p-0"><div data-sheet-part="head" className="flex shrink-0 items-center border-b border-border bg-card px-[var(--space-3)] min-[721px]:hidden" onClick={openSheet}>{phone && <Tabs value="notes" className="w-full"><TabsList variant="line" className="w-full justify-start rounded-none bg-card px-0 max-[721px]:!h-11 max-[721px]:!p-0"><TabsTrigger value="notes" data-testid="guest-notes-heading" className="max-[721px]:!h-11 max-[721px]:flex-none max-[721px]:px-[var(--space-3)] max-[721px]:after:!bottom-0">{tabContent}</TabsTrigger></TabsList></Tabs>}</div><div data-testid="guest-notes-aside-body" className="flex min-h-0 flex-1 flex-col max-[721px]:p-[var(--space-4)] max-[721px]:in-data-[mode=browse]:py-0 max-[721px]:in-data-[mode=compose]:py-[var(--space-2)] max-[721px]:in-data-[immersive=compose]:p-0">{panel}</div></aside></OverlayContainerContext.Provider>}
    />
    {canPaste && <GuestPasteDialog api={api} writer={writer} open={pasteOpen} onOpenChange={changePasteOpen} video={video} target={version} markupAllowed={session.link.allow.markup} finalFocus={phone ? headerMenu : undefined}
      onGone={onUnavailable}
      onPasted={(landed) => { if (landed !== null) setPasted(landed.copied === 0 ? `Nothing new to copy from v${landed.sourceVersion}.` : `Copied ${landed.copied} ${landed.copied === 1 ? "note" : "notes"} from v${landed.sourceVersion}.`); resync(); }} />}
    {decideFor !== null && canDecide && <GuestDecisionDialog key={`${version.assetId}:${decideFor}`} value={decideFor} assetId={version.assetId} film={video.title} version={version.version} drafts={drafts} open onClose={() => { opening.current += 1; setDecideFor(null); }} onConfirm={(note) => confirmDecision(decideFor, note)} finalFocus={phone ? () => (decisionFromSheet.current ? headerMenu() : null) : undefined} />}
    {offerDownloadAll && downloadAll.dialog}
    <div ref={setSlot} />
  </div>
  </FloatingFocusManager>;
}

/** Whether the focus is in a field that holds the on-screen keyboard (an enabled text input, textarea or editable element). */
function keyboardField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement) || element.matches(":disabled")) return false;
  return element.matches('textarea, input:not([type="button"],[type="submit"],[type="checkbox"],[type="radio"],[type="range"],[type="file"],[type="hidden"]), [contenteditable]:not([contenteditable="false"])');
}
