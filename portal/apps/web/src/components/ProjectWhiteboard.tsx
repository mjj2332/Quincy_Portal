import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, HistoryIcon, PlayIcon } from "lucide-react";
import type { WhiteboardMode, WhiteboardPeer } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import { Input } from "@/components/reui/input";
import type { WhiteboardController, WhiteboardMediaTool, WhiteboardPresence, WhiteboardSaveOutcome, WhiteboardSaveStatus, WhiteboardScenePoint } from "./reui/whiteboard/whiteboard";
import { CopyProjectLinkButton } from "./quincy/CopyProjectLinkButton";
import { EmbeddedUploadTray, type EmbeddedUpload } from "./quincy/EmbeddedUploadTray";
import { EmbeddedVideoDialog } from "./quincy/EmbeddedVideoDialog";
import { ViewLoadBoundary } from "./ViewLoadBoundary";
import { openWhiteboardSocket, type WhiteboardConnection, type WhiteboardInit, type WhiteboardSocket } from "../lib/whiteboard-socket";
import { interactingIds } from "../lib/whiteboard-merge";
import { createRemoteApplier } from "../lib/whiteboard-remote";
import { createWhiteboardSaver, type SavedElement, type WhiteboardSaver } from "../lib/whiteboard-saver";
import { createVanishObserver, type VanishObserver } from "../lib/whiteboard-vanish";
import { toCollaborator } from "../lib/whiteboard-collaborators";
import { pushToast } from "../lib/toast-store";
import { ApiError } from "../lib/api";
import { EMBEDDED_IMAGE_ACCEPT, EMBEDDED_VIDEO_ACCEPT, embeddedImageProblem, embeddedVideoContentType, embeddedVideoProblem, uploadEmbeddedImage, uploadEmbeddedVideo } from "../lib/embedded-media";
import { createMediaFileResolver, type MediaFileResolver, type ResolvedMedia } from "../lib/whiteboard-media-files";
import { canvasMediaRenderer } from "../lib/whiteboard-media-render";
import { whiteboardMediaRef } from "@quincy/shared";

// The ReUI block lazy-loads Excalidraw itself (`whiteboard.tsx` imports `whiteboard-canvas` on demand); this
// second `lazy` keeps even the block's own chunk out of the Workspace until the board opens (#498).
// #500: the History sheet (the ReUI panel, its History tab and the restore confirmation) loads the first time it is opened.
const WhiteboardHistoryPanel = lazy(() => import("./WhiteboardHistoryPanel").then((module) => ({ default: module.WhiteboardHistoryPanel })));
const Whiteboard = lazy(() => import("./reui/whiteboard/whiteboard").then((module) => ({ default: module.Whiteboard })));


/**
 * #498: the Project whiteboard (ADR 0017), composed on ReUI `whiteboard-1`. The Portal's own parts are the
 * toolbar (street, view-only badge, save status, a link that reopens THIS board, Close) and the transport:
 * a WebSocket to the Project's Durable Object. #499 makes it live: other people's elements are merged into the
 * board (Excalidraw's element-version reconciliation, never `replace`, so nothing local is dropped and nothing is
 * echoed back), their cursors, names, colours and selections show as Excalidraw collaborators, and archive/restore
 * flips the board between view-only and editable without a reload. #500 adds versions. #501 adds images and videos: an element only
 * REFERENCES an Embedded media row, so this shell uploads through the Embedded media pipeline (the editor's own image tool stays off),
 * resolves every file itself into a loaded data URL (`lib/whiteboard-media-files.ts`, kept here so it survives the editor remount a
 * restore causes), and plays a clicked video in the Portal's player. Quincy has no dark tokens, so the theme is fixed light.
 */
const FINAL_FLUSH_TIMEOUT_MS = 10_000;
const frame = (run: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => run()) : window.setTimeout(run, 16));
const cancelFrame = (handle: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(handle) : window.clearTimeout(handle));

export function ProjectWhiteboard({ projectId, street, archivedHint, onClose, onAccessFailure }: {
  projectId: string;
  street: string;
  /** The Project's archived state as the Workspace knows it; the server's `init` mode is what decides. */
  archivedHint?: boolean;
  onClose: () => void;
  onAccessFailure: (error: unknown) => void;
}) {
  const [init, setInit] = useState<WhiteboardInit | null>(null);
  const [connection, setConnection] = useState<WhiteboardConnection>("connecting");
  const [saveStatus, setSaveStatusState] = useState<WhiteboardSaveStatus>("saved");
  /** The latest save status, readable from the socket effect: a reset says "replaced" only when an edit was actually pending. */
  const saveStatusRef = useRef<WhiteboardSaveStatus>("saved");
  const setSaveStatus = useCallback((status: WhiteboardSaveStatus) => { saveStatusRef.current = status; setSaveStatusState(status); }, []);
  const [deleted, setDeleted] = useState(false);
  // #499: the mode the server last set (init, then `mode` frames), which moves without a reconnect.
  // #500: the editor remounts (a new key) when a restored version replaces the board; `generationRef` is the board generation this tab holds.
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(0);
  const generationRef = useRef(0);
  /** True from the moment a restore is seen until the new editor has committed: the old editor's teardown must not flush. */
  const resettingRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  /** This person started a restore and its `reset` has not been seen yet: their own reset reads "Board restored", not "your changes were replaced". */
  const restoreStartedRef = useRef(false);
  const [liveMode, setLiveMode] = useState<WhiteboardMode | null>(null);
  const modeRef = useRef<WhiteboardMode>(archivedHint ? "view" : "edit");
  const lastPresenceRef = useRef<WhiteboardPresence>({ pointer: null, button: "up", selectedIds: [] });
  const socketRef = useRef<WhiteboardSocket | null>(null);
  const controllerRef = useRef<WhiteboardController | null>(null);
  const saverRef = useRef<WhiteboardSaver | null>(null);
  const vanishRef = useRef<VanishObserver | null>(null);
  // The editor's own API is empty by the time the board unmounts; the last change it reported is not.
  const elementsRef = useRef<ReadonlyArray<SavedElement>>([]);
  /** Set by the socket effect: merges what arrived before the editor was ready, and draws the peers. */
  const drainRemote = useRef<() => void>(() => undefined);
  /** Set by the socket effect: replays remote winners that were skipped for an edit in progress. */
  const replayRemote = useRef<() => void>(() => undefined);
  const closeFailed = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const leftByClose = useRef(false);
  const accessFailureRef = useRef(onAccessFailure);
  accessFailureRef.current = onAccessFailure;

  // #501: Embedded media on the board.
  const resolverRef = useRef<MediaFileResolver | null>(null);
  if (resolverRef.current === null) resolverRef.current = createMediaFileResolver({ renderer: canvasMediaRenderer });
  useEffect(() => () => resolverRef.current?.dispose(), []);
  const [uploads, setUploads] = useState<EmbeddedUpload[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [picking, setPicking] = useState<{ n: number; at: WhiteboardScenePoint | undefined } | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const uploadSeq = useRef(0);
  const runningUploads = useRef(new Map<number, { cancel: () => void }>());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; for (const entry of [...runningUploads.current.values()]) entry.cancel(); }; }, []);
  useEffect(() => { if (picking !== null) pickerRef.current?.click(); }, [picking]);
  const uploadingVideo = uploads.some((entry) => entry.kind === "video");
  useEffect(() => {
    if (!uploadingVideo) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadingVideo]);

  useEffect(() => {
    // This effect's own socket: a final flush that runs after a remount must not use the new one.
    let socket: WhiteboardSocket | null = null;
    const peers = new Map<string, WhiteboardPeer>();
    let frameHandle: number | undefined;
    const showPeers = () => {
      if (frameHandle !== undefined) return;                // a cursor moves up to 30 times a second: draw once a frame
      frameHandle = frame(() => { frameHandle = undefined; controllerRef.current?.setCollaborators([...peers.values()].map(toCollaborator)); });
    };
    /**
     * #500: everything that belongs to ONE board generation: the saver (what the server holds), the vanish observer, and the remote applier
     * with its queued and deferred batches. A restore throws the whole session away and starts another on the restored scene, so nothing the
     * old one tracked (pending acks, retries, buffered batches) can reach the new board. The transport and the peers stay.
     * `seal.generation` is what every save of this session is sealed for: the socket refuses it once the board has moved on.
     */
    const startSession = (seal: { generation: number | undefined }) => {
      const saver = createWhiteboardSaver({
        getElements: () => elementsRef.current,
        send: (batch) => socket?.send(batch, seal.generation) ?? Promise.reject(new Error("The whiteboard is not connected.")),
      });
      // An element the editor dropped with no tombstone (a resize to zero size) is deleted the way the editor deletes, as soon as the change is seen:
      // the deletion goes on the board as the person's own change (so autosave sends it), and the saver only ever sends what the scene holds.
      const vanish = createVanishObserver({
        mayHold: saver.mayHold,
        ready: () => controllerRef.current !== null,
        deletion: (last, patch) => controllerRef.current!.author(last as never, { isDeleted: true, ...patch }) as unknown as SavedElement,
        install: (deletions) => { elementsRef.current = controllerRef.current!.applyLocal(deletions, (element) => saver.hold(element as unknown as SavedElement)) as unknown as SavedElement[]; return elementsRef.current; },
      });
      vanishRef.current = vanish;
      saverRef.current = saver;
      // Merging, recording what the board took as stored, and deferring winners the editor skipped: `lib/whiteboard-remote.ts`.
      const remoteApplier = createRemoteApplier({
        saver,
        merge: () => { const controller = controllerRef.current; return controller ? (remote, hold) => controller.applyRemote(remote, (element) => hold(element as unknown as SavedElement)) as unknown as SavedElement[] : null; },
        setScene: (scene) => { elementsRef.current = scene; },
        getScene: () => elementsRef.current,
        settle: () => vanish.observe(elementsRef.current),
        interactingIds: () => { const controller = controllerRef.current; return controller ? interactingIds(controller.api.getAppState()) : new Set<string>(); },
        forget: (ids) => vanish.forget(ids),
      });
      drainRemote.current = () => { remoteApplier.drain(); showPeers(); };
      replayRemote.current = remoteApplier.replay;
      return { saver, vanish, seal, applyRemote: remoteApplier.apply };
    };
    let session = startSession({ generation: undefined });
    /** #500: a version was restored (a `reset` frame, or a reconnect's `init` on a newer generation): the editor remounts on the restored scene. */
    const resetBoard = (next: { generation: number; elements: Array<Record<string, unknown>> }) => {
      if (next.generation <= generationRef.current) return;      // a straggler of a generation this board has already left
      generationRef.current = next.generation;
      resettingRef.current = true;                               // the old editor's teardown must not flush what the restore replaced
      session.vanish.stop();
      elementsRef.current = next.elements as unknown as SavedElement[];
      controllerRef.current = null;
      session = startSession({ generation: next.generation });
      session.saver.seed(next.elements as unknown as SavedElement[]);
      epochRef.current += 1;
      setInit((previous) => (previous ? { ...previous, generation: next.generation, elements: next.elements } : previous));
      const discardedEdit = saveStatusRef.current !== "saved";    // unsaved, saving or failed: an edit of this person's is being thrown away
      setSaveStatus("saved");
      setEpoch(epochRef.current);
      if (restoreStartedRef.current || !discardedEdit) pushToast("Board restored");
      else pushToast("Board restored — your unsaved changes were replaced", "caution");   // work was thrown away: advisory, not plain success
      restoreStartedRef.current = false;
    };
    const opened = openWhiteboardSocket(projectId, {
      onInit: (next, reconnect) => {
        modeRef.current = next.mode; setLiveMode(next.mode);
        peers.clear(); for (const peer of next.peers) peers.set(peer.sessionId, peer); showPeers();
        if (!reconnect) { generationRef.current = next.generation; session.seal.generation = next.generation; setInit(next); session.saver.seed(next.elements as unknown as SavedElement[]); elementsRef.current = next.elements as unknown as SavedElement[]; return; }
        // #500: the board was restored while this tab was away. Merging would let its newer element versions beat the restored scene,
        // so the editor is replaced by the restored scene instead.
        if (next.generation !== generationRef.current) { resetBoard(next); return; }
        // A reconnect keeps the board the user is looking at: what happened while away is merged into it first (the
        // server's copy of anything newer wins, anything only we have stays), and only then does what was not
        // acknowledged before the drop go out again, now above what it was merged with.
        session.applyRemote(next.elements);
        if (next.mode === "edit") session.saver.flush().catch(() => setSaveStatus("error"));
      },
      onConnection: setConnection,
      onDeleted: () => { setDeleted(true); pushToast("This project's whiteboard was deleted.", "error"); },
      onAccessFailure: (error) => accessFailureRef.current(error),
      onElements: (elements) => session.applyRemote(elements as Array<Record<string, unknown>>),
      onReset: resetBoard,
      onPresence: (peer) => { peers.set(peer.sessionId, peer); showPeers(); },
      onPeerLeft: (sessionId) => { peers.delete(sessionId); showPeers(); },
      onMode: (next) => {
        if (modeRef.current === next) return;
        modeRef.current = next; setLiveMode(next);                 // the View only badge is the indicator
      },
    });
    socket = opened;
    socketRef.current = opened;
    return () => {
      session.vanish.stop();                                // the editor is going away: whatever it no longer holds was not deleted
      // Best effort for closes that bypass the Close button (Esc, tab switch, navigation): send what is
      // left, then let the socket wait briefly for the acks. The Close button itself waits and reports.
      // The flush may queue behind a save in flight, so the socket closes only once it settles (bounded).
      const finalFlush = session.saver.flush().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, FINAL_FLUSH_TIMEOUT_MS); });
      void Promise.race([finalFlush, bound]).then(() => { clearTimeout(timer); opened.close(); });
      if (socketRef.current === opened) socketRef.current = null;
      drainRemote.current = () => undefined; replayRemote.current = () => undefined;
      if (frameHandle !== undefined) cancelFrame(frameHandle);
    };
  }, [projectId]);

  // The pointer is shared only while the tab is visible: a hidden tab's last cursor would hang on everyone's board.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") socketRef.current?.sendPresence({ ...lastPresenceRef.current, pointer: null, button: "up" }); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // The sheet focuses its popup when it opens, and a deep link mounts the board after that (and the entry
  // button that opened it is hidden now): focus lands on the way out of the board instead.
  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      // Close hands the Workspace back; its entry button is what the user came from. Only the Close button
      // asks for this: Esc or navigation leave focus to whatever took over.
      if (!leftByClose.current) return;
      document.querySelector<HTMLElement>('[data-testid="project-whiteboard-open"]')?.focus({ preventScroll: true });
    };
  }, []);

  // View-only boards never send: the server would refuse, and the refusal would read as a failed save.
  // The autosave is told so ("skipped"), not shown a success: the edit stays dirty and goes out when the board is editable again.
  const saveFor = useCallback((editor: number) => async (): Promise<WhiteboardSaveOutcome> => {
    if (epochRef.current !== editor || modeRef.current === "view") return "skipped";   // #500: an editor the restore replaced saves nothing
    await saverRef.current?.flush();
  }, []);
  const discardSave = useCallback(() => resettingRef.current, []);
  useEffect(() => { resettingRef.current = false; setSelectedVideo(null); }, [epoch]);
  const sharePresence = useCallback((presence: WhiteboardPresence) => {
    lastPresenceRef.current = presence;
    socketRef.current?.sendPresence(presence);
    // #501: the header's Play video button follows a selection of exactly one video.
    const only = presence.selectedIds.length === 1 ? elementsRef.current.find((element) => element.id === presence.selectedIds[0]) : undefined;
    const ref = only && only.isDeleted !== true ? whiteboardMediaRef(only) : null;
    setSelectedVideo(ref?.kind === "video" ? ref.id : null);
  }, []);

  const mode: WhiteboardMode = liveMode ?? init?.mode ?? (archivedHint ? "view" : "edit");
  // #501: Play video rides the board's own floating action slot (over the canvas), so a selection change never reflows the header.
  const playAction = useMemo(() => (mode === "edit" && selectedVideo !== null
    ? [{ id: "play-video", label: "Play video", icon: <PlayIcon aria-hidden="true" />, onSelect: () => setPlaying(selectedVideo) }]
    : undefined), [mode, selectedVideo]);

  /**
   * #501: every file goes through the Embedded media pipeline on its own (presign, bytes straight to R2, complete; a video's poster is
   * captured and stored on the way), and its element is put on the board only once the server has accepted it, so a failed, cancelled or
   * abandoned upload leaves nothing behind. The insertion point is remembered from the start (the view moves while a video uploads) and
   * the element is never selected. A video can be cancelled from its tray row.
   */
  const uploadMedia = useCallback((files: File[], at?: WhiteboardScenePoint) => {
    if (modeRef.current !== "edit") return;
    const problems: string[] = [];
    let placed = 0;
    for (const file of files) {
      const kind: "image" | "video" = embeddedVideoContentType(file) ? "video" : "image";
      const problem = kind === "video" ? embeddedVideoProblem(file) : embeddedImageProblem(file);
      if (problem) { problems.push(problem); continue; }
      const cascade = placed; placed += 1;
      const key = ++uploadSeq.current;
      const name = file.name || (kind === "video" ? "Video" : "Image");
      const controller = new AbortController();
      let released = false; let cancelled = false;
      const release = () => {
        if (released) return; released = true;
        runningUploads.current.delete(key);
        if (mountedRef.current) setUploads((entries) => entries.filter((entry) => entry.key !== key));
      };
      runningUploads.current.set(key, { cancel: () => { cancelled = true; controller.abort(); release(); } });
      setUploads((entries) => [...entries, { key, name, percent: 0, kind }]);
      const onProgress = (percent: number) => { if (mountedRef.current && !released) setUploads((entries) => entries.map((entry) => entry.key === key ? { ...entry, percent } : entry)); };
      const uploading = kind === "video" ? uploadEmbeddedVideo(projectId, file, { signal: controller.signal, onProgress, owner: "whiteboard" }) : uploadEmbeddedImage({ projectId, owner: "whiteboard" }, file, onProgress);
      void uploading
        .then(async (mediaId) => {
          if (cancelled || !mountedRef.current) return;
          const resolver = resolverRef.current!;
          // An image this tab holds is decoded from the file; a video's poster is read back from the server like any viewer's.
          let media: ResolvedMedia | null = kind === "image" ? await resolver.adoptImage(mediaId, file) : null;
          if (!media) { const outcome = await resolver.resolve(mediaId, kind); media = outcome.ok ? outcome.media : null; }
          if (cancelled || !mountedRef.current) return;
          const live = controllerRef.current;
          if (!media || !live) { setUploadErrors((entries) => [...entries, `${name} was uploaded but could not be shown on the board.`]); return; }
          const placedId = live.insertMedia({ fileId: mediaId, kind, file: media.file, width: media.width, height: media.height, at, cascade });
          if (placedId === null) setUploadErrors((entries) => [...entries, `${name} was uploaded, but the whiteboard is view only now, so it was not placed.`]);
        })
        .catch((reason) => {
          if (cancelled || (reason instanceof Error && reason.name === "AbortError")) return;
          if (reason instanceof ApiError && reason.status === 409) { pushToast("Archived projects cannot accept media", "error"); return; }
          if (mountedRef.current) setUploadErrors((entries) => [...entries, `${name} could not be uploaded${reason instanceof Error && reason.message ? `: ${reason.message}` : "."}`]);
        })
        .finally(release);
    }
    setUploadErrors(problems);
  }, [projectId]);
  const mediaTool = useMemo<WhiteboardMediaTool | undefined>(() => mode === "view" ? undefined : {
    label: "Image or video",
    // The picker is mounted only while a choice is being made (lessons #493): a standing file input would be a second upload control.
    onPick: (at) => setPicking((previous) => ({ n: (previous?.n ?? 0) + 1, at })),
    onFiles: uploadMedia,
  }, [mode, uploadMedia]);

  const requestClose = useCallback(async () => {
    // Flush the final state through the live socket and wait for its ack before the board unmounts.
    if (mode === "edit" && !closeFailed.current) {
      try { await saverRef.current?.flush(); }
      catch {
        closeFailed.current = true;
        setSaveStatus("error");
        pushToast("Your latest changes could not be saved. Close again to leave without saving them.", "error");
        return;
      }
    }
    leftByClose.current = true;
    onClose();
  }, [mode, onClose]);
  const initialData = useMemo(() => (init ? { elements: init.elements as never } : undefined), [init]);
  const statusLabel = connection === "reconnecting" ? "Reconnecting" : saveStatus === "saving" ? "Saving" : saveStatus === "error" ? "Not saved" : saveStatus === "unsaved" ? "Unsaved changes" : "Saved";

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[var(--space-3)] px-[var(--space-6)] py-[var(--space-5)] max-[721px]:p-[var(--space-4)] h-[calc(100dvh-var(--space-5)*2-var(--border-width-hair)*2)] [[data-impersonating]_&]:h-[calc(100dvh-var(--impersonation-banner-height)-var(--space-5)*2-var(--border-width-hair)*2)] max-[721px]:h-dvh max-[721px]:[[data-impersonating]_&]:h-[calc(100dvh-var(--impersonation-banner-height))] min-h-[28rem]" data-testid="project-whiteboard" data-quincy-whiteboard aria-label={`Whiteboard for ${street}`}>
      <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        <Button ref={closeButtonRef} type="button" variant="ghost" onClick={() => void requestClose()} data-testid="project-whiteboard-close"><ArrowLeftIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />Close whiteboard</Button>
        <h2 className="serif [font:var(--type-h3)] min-w-0 truncate">{street}</h2>
        <div className="ms-auto flex flex-wrap items-center gap-[var(--space-2)]">
        {mode === "view" && <Badge variant="primary-light" data-testid="project-whiteboard-view-only">View only</Badge>}
        {(deleted || mode !== "view") && <span className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" role="status" data-testid="project-whiteboard-status">{deleted ? "Deleted" : statusLabel}</span>}
        <Button type="button" variant="ghost" data-testid="project-whiteboard-history" aria-haspopup="dialog" onClick={() => { setHistoryLoaded(true); setHistoryOpen(true); }}><HistoryIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />History</Button>
        <CopyProjectLinkButton projectId={projectId} tab="collaboration" whiteboard />
        </div>
        {picking !== null && <Input
          key={picking.n} ref={pickerRef} type="file" multiple accept={`${EMBEDDED_IMAGE_ACCEPT},${EMBEDDED_VIDEO_ACCEPT}`} tabIndex={-1} aria-hidden="true" aria-label="Choose images or videos" data-testid="project-whiteboard-media-picker" className="sr-only"
          onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); const at = picking.at; setPicking(null); if (files.length) uploadMedia(files, at); }}
          {...{ onCancel: () => setPicking(null) }}
        />}
      </div>
      <div className="min-h-0 relative border-solid border-[length:var(--border-width-hair)] border-border bg-card">
        <EmbeddedUploadTray uploads={uploads} errors={uploadErrors} onCancel={(key) => runningUploads.current.get(key)?.cancel()} testId="project-whiteboard-upload-tray" className="absolute inset-x-[var(--space-4)] bottom-[calc(var(--space-4)+var(--space-7)+var(--space-2))] z-20 mx-auto grid max-w-[28rem] gap-[var(--space-2)] rounded-lg border-solid border-[length:var(--border-width-hair)] border-border bg-card p-[var(--space-3)] shadow-sm" />
        {deleted
          ? <p className="p-[var(--space-5)]" role="alert">This project's whiteboard was deleted.</p>
          : initialData
            ? (
              <ViewLoadBoundary viewLabel="whiteboard">
                <Suspense fallback={<p className="p-[var(--space-5)]" role="status">Loading whiteboard.</p>}>
                  <Whiteboard
                    key={epoch}
                    className="absolute inset-0"
                    theme="light"
                    name={street}
                    label={`Whiteboard for ${street}`}
                    initialData={initialData}
                    readOnly={mode === "view"}
                    viewOnlyIndicator={false}
                    imageTool={false}
                    background="grid"
                    mediaTool={mediaTool}
                    onVideoOpen={setPlaying}
                    actions={playAction}
                    onReady={(controller) => {
                      if (epochRef.current !== epoch) return;
                      controllerRef.current = controller; controller.adoptRevisions((init?.elements ?? []) as unknown as SavedElement[]); drainRemote.current();
                      // #501: the files the scene references come back from the resolver's cache (a restore mounted a new editor), or are fetched.
                      resolverRef.current?.attach({ has: (id) => id in controller.api.getFiles(), add: (files) => controller.addMediaFiles(files) });
                      resolverRef.current?.ensure(elementsRef.current);
                    }}
                    onPresence={sharePresence}
                    onElements={(elements) => { if (epochRef.current !== epoch) return; elementsRef.current = elements as ReadonlyArray<SavedElement>; vanishRef.current?.observe(elementsRef.current); replayRemote.current(); resolverRef.current?.ensure(elements); }}
                    onSave={saveFor(epoch)}
                    discardSave={discardSave}
                    onSaveStatusChange={(status) => { if (epochRef.current === epoch) setSaveStatus(status); }}
                    onToast={pushToast}
                  />
                </Suspense>
              </ViewLoadBoundary>
            )
            : <p className="p-[var(--space-5)]" role="status">Connecting to the whiteboard.</p>}
      </div>
      <EmbeddedVideoDialog mediaId={playing} onOpenChange={(open) => { if (!open) setPlaying(null); }} />
      {historyLoaded && (
        <Suspense fallback={null}>
          <WhiteboardHistoryPanel
            projectId={projectId}
            title={street}
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            readOnly={mode === "view"}
            onRestoreStarted={() => { restoreStartedRef.current = true; }}
            onRestoreFailed={() => { restoreStartedRef.current = false; }}
          />
        </Suspense>
      )}
    </section>
  );
}
