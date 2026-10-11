import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronLeft, ChevronRight, MessageSquare, MessageSquareWarning } from "lucide-react";
import { framesToTimecode, type Box, type GuestDecision, type GuestNoteThreadDto, type GuestSessionResponse, type GuestVideoDto } from "@quincy/shared";
import { useMediaQuery } from "../lib/use-media-query";
import type { VideoFrameClock } from "../lib/video-frame-clock";
import { Button } from "../components/reui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/reui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/reui/sheet";
import { SheetCloseButton, SHEET_CLOSE_CLEARANCE } from "../components/quincy/SheetCloseButton";
import { VideoPlayer, type VideoPlayerControl } from "../components/quincy/VideoPlayer";
import type { TimelineMarker } from "../components/quincy/VideoTimelineMarkers";
import type { GuestApi, WriteResult } from "./guest-api";
import { decisionFailureText, failureText, removeThread, upsertThread, type EditPatch } from "./guest-compose";
import type { ActionOutcome, NoteActions, Writing } from "./GuestNoteItem";
import { GuestNotesPanel } from "./GuestNotesPanel";
import { GuestSubscriptionRow } from "./GuestSubscriptionRow";
import type { GuestSubscription } from "./guest-subscription";
import { GuestDecisionDialog, decisionDraftKey, type DecisionOutcome, type DecisionValue } from "./GuestDecisionDialog";
import { GuestDeliveryChips } from "./GuestDeliveryChips";
import { GuestDownload } from "./GuestDownload";
import { GuestDownloadAll } from "./GuestDownloadAll";
import type { GuestDrafts } from "./guest-drafts";
import { useGuestCompose } from "./use-guest-compose";
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
export function GuestVideoScreen({ api, verify, writer, drafts, subscription, session, onSession, archived, onArchived, videos, index, onIndex, onBack, onUnavailable, onGrantsChanged, onDecided, onResyncDelivery, onShownVersion }: {
  api: GuestApi;
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

  const [threads, setThreads] = useState<GuestNoteThreadDto[] | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);
  const [selectionCount, setSelectionCount] = useState(0);
  const [notesAttempt, setNotesAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState<VideoFrameClock | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const phone = useMediaQuery("(max-width: 720px)");

  const resyncRef = useRef<() => void>(() => undefined);
  const binding = useRef<WriterBinding>({ scope: version.assetId, effects: { onUnverified: () => undefined, onGone: () => undefined, onArchived: () => undefined }, onLostSettle: () => undefined });
  binding.current.scope = version.assetId;
  binding.current.effects = {
    onUnverified: () => { verify.request(); onSession({ ...session, verified: false, email: null, name: null, notifications: null }); },
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
  const onMediaError = useCallback(() => { void recheckAccess(); }, [recheckAccess]);
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

  const base = useMemo(() => ({ nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }), [version.tcNominalFps, version.tcDropFrame]);
  const timecode = useCallback((frame: number) => framesToTimecode(frame, base, version.startTimecodeFrames ?? 0), [base, version.startTimecodeFrames]);
  const markers = useMemo<TimelineMarker[]>(() => (threads ?? []).filter((thread) => thread.startFrame !== null && !thread.deleted)
    .map((thread) => ({ id: thread.id, startFrame: thread.startFrame!, endFrame: thread.endFrame, tone: "public" as const, selected: thread.id === selectedId, createdAt: thread.createdAt })), [threads, selectedId]);
  const selected = threads?.find((thread) => thread.id === selectedId) ?? null;
  const select = useCallback((thread: GuestNoteThreadDto) => {
    noteGeneration.current += 1;
    setSelectedId(thread.id);
    setSelectionCount((n) => n + 1);
    // A drawing shows only on the exact frame it was drawn on, which can sit anywhere inside the note's range: seek there, else to the anchor.
    const frame = thread.hasMarkup && thread.drawingFrame !== null ? thread.drawingFrame : thread.startFrame;
    if (frame !== null) clock?.seekToFrame(frame);
    setDrawerOpen(false);
  }, [clock]);
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
  const post = useCallback(async (input: Parameters<GuestApi["createNote"]>[1]) => settle(await writer.run(`new:${assetForWrites}`, () => api.createNote(assetForWrites, input)), null), [api, writer, settle, assetForWrites]);
  const editRoot = useCallback(async (id: string, patch: EditPatch, expectedRevision: number): Promise<ActionOutcome> => {
    const current = threadsRef.current?.find((thread) => thread.id === id);
    if (current === undefined || current.deleted) return { ok: false, message: "This note was deleted." };
    return settle(await writer.run(id, () => api.editNote(id, { expectedRevision, ...patch })), id);
  }, [api, writer, settle]);
  const latestOf = useCallback((id: string) => threads?.find((thread) => thread.id === id) ?? null, [threads]);
  const actions = useMemo<NoteActions>(() => ({
    reply: async (root, body) => settle(await writer.run(root.id, () => api.replyToNote(root.id, body)), root.id),
    edit: async (root, note, body, expectedRevision) => settle(await writer.run(root.id, () => api.editNote(note.id, { expectedRevision, body })), root.id),
    remove: async (root, note, expectedRevision) => settle(await writer.run(root.id, () => api.deleteNote(note.id, expectedRevision)), note.id === root.id ? root.id : null),
  }), [api, writer, settle]);

  const onDrawingChange = useCallback((drawing: boolean) => { if (phone) setDrawerOpen(!drawing); }, [phone]);
  const compose = useGuestCompose({ clock, frameCount: version.frameCount, timecode, markupAllowed: session.link.allow.markup, post, edit: editRoot, latestOf, onDrawingChange });
  // A draft belongs to the Version it was made on; an archived Project takes it away.
  const { close: closeComposer, editingId } = compose;
  useEffect(() => { closeComposer(); }, [version.assetId, closeComposer]);
  useEffect(() => { if (archived) closeComposer(); }, [archived, closeComposer]);
  // An edit of a note that has since been deleted (here or elsewhere) has nothing left to save to.
  // Only a notes read that has completed can say so: while a re-read is out (after re-verifying) `threads` is null, which is "not known yet", not "gone".
  const editedGone = editingId !== null && threads !== null && (latestOf(editingId)?.deleted ?? true);
  useEffect(() => { if (editedGone) closeComposer(); }, [editedGone, closeComposer]);

  // On a phone the composer lives in the notes drawer, which covers the picture the guest is marking: opening a draft closes the drawer, and it comes back when the draft ends.
  const restoreDrawer = useRef(false);
  const startDraft = useCallback((start: () => void) => { start(); if (phone) { restoreDrawer.current = true; setDrawerOpen(false); } }, [phone]);
  const wasComposing = useRef(false);
  useEffect(() => {
    if (wasComposing.current && !compose.isOpen && restoreDrawer.current) { restoreDrawer.current = false; if (phone) setDrawerOpen(true); }
    wasComposing.current = compose.isOpen;
  }, [compose.isOpen, phone]);

  // What the guest was doing when verification was asked for, so a successful code lands them where they were going. Each request carries its own, and the page's verify owner keeps only the newest active one.
  const afterVerify = useRef<(then: "compose" | "download" | DecisionValue) => void>(() => undefined);
  const requestVerify = useCallback((then: "compose" | "download" | "none" | DecisionValue, active: () => boolean = () => true) => {
    const reopen = phone && drawerOpen;
    if (reopen) setDrawerOpen(false);
    verify.request({ active, done: (verified) => {
      if (reopen) setDrawerOpen(true);
      if (verified && then !== "none") afterVerify.current(then);
    } });
  }, [phone, drawerOpen, verify]);
  // The notes read before verifying carried no 'self' marks: whoever caused the verification (this screen's actions or Download all), read them again as the verified guest.
  const wasVerified = useRef(session.verified);
  useEffect(() => { if (session.verified && !wasVerified.current) setNotesAttempt((n) => n + 1); wasVerified.current = session.verified; }, [session.verified]);
  const { beginEdit } = compose;
  const writing = useMemo<Writing>(() => ({
    canWrite, verified: session.verified, actions, drafts, onNeedVerify: () => { requestVerify("none"); },
    composerOpen: compose.isOpen, editRoot: (thread) => { startDraft(() => { beginEdit(thread); }); },
  }), [canWrite, session.verified, actions, drafts, requestVerify, compose.isOpen, startDraft, beginEdit]);
  const addNote = canWrite
    ? compose.isOpen ? compose.form : <Button type="button" variant="outline" data-testid="guest-add-note" className={TOUCH} onClick={() => { if (session.verified) startDraft(compose.begin); else requestVerify("compose"); }}>Add a note</Button>
    : null;

  // Approve / Request changes (#741 14-ui-guest). The note draft is in `drafts` and the write is the writer's, so both outlive this screen; the dialog is per Version and decision.
  const [decideFor, setDecideFor] = useState<DecisionValue | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  // Every opening of the dialog gets an id. A completion closes the dialog only if the opening it came from is still the one showing; the decision itself applies by Version either way.
  const opening = useRef(0);
  const openDecision = useCallback((value: DecisionValue) => { opening.current += 1; setDecideFor(value); }, []);
  // After verifying for Download, the Download button becomes the anchor and the guest presses it again (a click made after the async verification would be blocked as a popup).
  const [downloadHint, setDownloadHint] = useState(false);
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
    if (then === "compose") startDraft(compose.begin);
    else if (then === "download") setDownloadHint(true);
    else openDecision(then);
  };
  const startDecision = (value: DecisionValue) => { if (session.verified) openDecision(value); else requestVerify(value); };
  const allowDownload = session.link.allow.download;

  const savedHidden = compose.replacesSavedDrawing(selectedId);
  const overlay = useCallback((box: Box | null) => <>{watermark && box && <PremiumWatermark box={box} />}{!savedHidden && markupOverlay(box)}{compose.overlay(box)}</>, [watermark, savedHidden, markupOverlay, compose.overlay]); // eslint-disable-line react-hooks/exhaustive-deps -- compose.overlay is the dependency that matters

  const newest = video.versions[0]!.version;
  const optionLabel = (candidate: GuestVideoDto["versions"][number]) => `v${candidate.version}${candidate.version === newest ? " · latest" : ""}`;
  const headingContent = <>Notes{threads !== null && <><span className="sr-only"> </span><span data-testid="guest-notes-count" className="ms-[var(--space-1)] text-foreground-secondary [font:var(--type-label)]">{threads.length}</span></>}</>;
  const heading = <h2 data-testid="guest-notes-heading" className={NOTES_HEADING}>{headingContent}</h2>;
  const toggleSubscription = useCallback((next: boolean, previous: boolean) => { void subscription.toggle(next, previous, () => writer.runLink("subscription", () => api.setSubscription(next))); }, [subscription, writer, api]);
  const footer = session.verified && session.notifications?.available
    ? <GuestSubscriptionRow store={subscription} initial={session.notifications.subscribed} readOnly={archived} onToggle={toggleSubscription} />
    : null;
  const panel = <GuestNotesPanel threads={threads} failed={notesFailed} onRetry={() => { setNotesAttempt((n) => n + 1); }} selectedId={selectedId} onSelect={select} timecode={timecode} header={phone ? undefined : heading} top={addNote} footer={footer} writing={writing} />;

  return <div data-testid="guest-video-screen" data-surface="inverse" className="flex min-h-dvh flex-col bg-background text-foreground min-[721px]:h-dvh">
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
      <div data-testid="guest-delivery" className="flex flex-wrap items-center gap-[var(--space-2)] empty:hidden max-[721px]:basis-full">
        <GuestDeliveryChips version={version} />
        {canDecide && <>
          <Button type="button" variant={version.decision?.value === "approved" ? "outline" : "default"} data-testid="guest-approve" className={TOUCH} onClick={() => { startDecision("approved"); }}><Check aria-hidden="true" />Approve</Button>
          <Button type="button" variant="outline" data-testid="guest-request-changes" className={TOUCH} onClick={() => { startDecision("changes_requested"); }}><MessageSquareWarning aria-hidden="true" />Request changes</Button>
        </>}
        <GuestDownload video={video} version={version} allowDownload={allowDownload} verified={session.verified} onNeedVerify={() => { requestVerify("download"); }} />
        {videos.length > 1 && <GuestDownloadAll api={api} verify={verify} session={session} onSession={onSession} onUnavailable={onUnavailable} />}
        {downloadHint && session.verified && version.downloadUrl !== null && <p role="status" data-testid="guest-download-hint" className="m-0 text-foreground-secondary [font:var(--type-label)]">You're verified. Press Download to start it.</p>}
        {decisionNotice !== null && <p role="status" data-testid="guest-decision-notice" className="m-0 text-foreground-secondary [font:var(--type-label)]">{decisionNotice}</p>}
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-wrap min-[721px]:flex-nowrap min-[721px]:overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-[999_1_640px] flex-col p-[var(--space-5)] min-[721px]:flex-1">
        <VideoPlayer key={version.assetId} controlRef={playerRef} keyboard="host" version={version} title={`${video.title}, version ${version.version}`} className="flex-1" markers={markers} onMarkerSelect={(id) => { const thread = threads?.find((candidate) => candidate.id === id); if (thread) select(thread); }} onClockChange={setClock} onMark={compose.onMark} overlay={overlay} onMediaError={onMediaError} transportReplacement={compose.transportReplacement} />
      </div>
      {!phone && <aside data-surface="default" className="flex flex-[1_1_360px] flex-col border-l border-border bg-card p-[var(--space-5)] text-card-foreground min-[721px]:min-h-0 min-[721px]:overflow-hidden min-[721px]:flex-[0_0_clamp(240px,28vw,360px)]">{panel}</aside>}
    </div>
    {phone && <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <SheetContent side="bottom" showCloseButton={false} data-testid="guest-notes-drawer" className="data-[side=bottom]:h-[80dvh] max-h-[80dvh] p-[var(--space-4)]">
        <SheetHeader className={`p-0 ${SHEET_CLOSE_CLEARANCE}`}><SheetTitle data-testid="guest-notes-heading" className={NOTES_HEADING}>{headingContent}</SheetTitle></SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{panel}</div>
        <SheetCloseButton label="Close notes" data-testid="guest-notes-close" />
      </SheetContent>
    </Sheet>}
    {decideFor !== null && canDecide && <GuestDecisionDialog key={`${version.assetId}:${decideFor}`} value={decideFor} assetId={version.assetId} film={video.title} version={version.version} drafts={drafts} open onClose={() => { opening.current += 1; setDecideFor(null); }} onConfirm={(note) => confirmDecision(decideFor, note)} />}
  </div>;
}
