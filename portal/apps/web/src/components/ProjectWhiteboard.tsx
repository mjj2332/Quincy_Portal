import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import type { WhiteboardMode, WhiteboardPeer } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import type { WhiteboardController, WhiteboardPresence, WhiteboardSaveOutcome, WhiteboardSaveStatus } from "./reui/whiteboard/whiteboard";
import { CopyProjectLinkButton } from "./quincy/CopyProjectLinkButton";
import { ViewLoadBoundary } from "./ViewLoadBoundary";
import { openWhiteboardSocket, type WhiteboardConnection, type WhiteboardInit, type WhiteboardSocket } from "../lib/whiteboard-socket";
import { interactingIds } from "../lib/whiteboard-merge";
import { createRemoteApplier } from "../lib/whiteboard-remote";
import { createWhiteboardSaver, type SavedElement, type WhiteboardSaver } from "../lib/whiteboard-saver";
import { toCollaborator } from "../lib/whiteboard-collaborators";
import { pushToast } from "../lib/toast-store";

// The ReUI block lazy-loads Excalidraw itself (`whiteboard.tsx` imports `whiteboard-canvas` on demand); this
// second `lazy` keeps even the block's own chunk out of the Workspace until the board opens (#498).
const Whiteboard = lazy(() => import("./reui/whiteboard/whiteboard").then((module) => ({ default: module.Whiteboard })));


/**
 * #498: the Project whiteboard (ADR 0017), composed on ReUI `whiteboard-1`. The Portal's own parts are the
 * toolbar (street, view-only badge, save status, a link that reopens THIS board, Close) and the transport:
 * a WebSocket to the Project's Durable Object. #499 makes it live: other people's elements are merged into the
 * board (Excalidraw's element-version reconciliation, never `replace`, so nothing local is dropped and nothing is
 * echoed back), their cursors, names, colours and selections show as Excalidraw collaborators, and archive/restore
 * flips the board between view-only and editable without a reload. Versions arrive with #500 and media with #501,
 * so the image tool is off. Quincy has no dark tokens, so the theme is fixed light.
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
  const [saveStatus, setSaveStatus] = useState<WhiteboardSaveStatus>("saved");
  const [deleted, setDeleted] = useState(false);
  // #499: the mode the server last set (init, then `mode` frames), which moves without a reconnect.
  const [liveMode, setLiveMode] = useState<WhiteboardMode | null>(null);
  const modeRef = useRef<WhiteboardMode>(archivedHint ? "view" : "edit");
  const lastPresenceRef = useRef<WhiteboardPresence>({ pointer: null, button: "up", selectedIds: [] });
  const socketRef = useRef<WhiteboardSocket | null>(null);
  const controllerRef = useRef<WhiteboardController | null>(null);
  const saverRef = useRef<WhiteboardSaver | null>(null);
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

  useEffect(() => {
    // This effect's own socket: a final flush that runs after a remount must not use the new one.
    let socket: WhiteboardSocket | null = null;
    const saver = createWhiteboardSaver({
      getElements: () => elementsRef.current,
      send: (batch) => socket?.send(batch) ?? Promise.reject(new Error("The whiteboard is not connected.")),
      // A version the saver raised is written into the scene element; the change tracker is told, so it does not read as an edit.
      onRaised: (raised) => controllerRef.current?.adoptRevisions(raised),
    });
    saverRef.current = saver;
    const peers = new Map<string, WhiteboardPeer>();
    let frameHandle: number | undefined;
    const showPeers = () => {
      if (frameHandle !== undefined) return;                // a cursor moves up to 30 times a second: draw once a frame
      frameHandle = frame(() => { frameHandle = undefined; controllerRef.current?.setCollaborators([...peers.values()].map(toCollaborator)); });
    };
    // Merging, recording what the board took as stored, and deferring winners the editor skipped: `lib/whiteboard-remote.ts`.
    const remoteApplier = createRemoteApplier({
      saver,
      merge: () => { const controller = controllerRef.current; return controller ? (remote, hold) => controller.applyRemote(remote, (element) => hold(element as unknown as SavedElement)) as unknown as SavedElement[] : null; },
      setScene: (scene) => { elementsRef.current = scene; },
      getScene: () => elementsRef.current,
      interacting: () => { const controller = controllerRef.current; return controller ? interactingIds(controller.api.getAppState()).size > 0 : false; },
    });
    const applyRemote = remoteApplier.apply;
    drainRemote.current = () => { remoteApplier.drain(); showPeers(); };
    replayRemote.current = remoteApplier.replay;
    const opened = openWhiteboardSocket(projectId, {
      onInit: (next, reconnect) => {
        modeRef.current = next.mode; setLiveMode(next.mode);
        peers.clear(); for (const peer of next.peers) peers.set(peer.sessionId, peer); showPeers();
        if (!reconnect) { setInit(next); saver.seed(next.elements as unknown as SavedElement[]); elementsRef.current = next.elements as unknown as SavedElement[]; return; }
        // A reconnect keeps the board the user is looking at: what happened while away is merged into it first (the
        // server's copy of anything newer wins, anything only we have stays), and only then does what was not
        // acknowledged before the drop go out again, now above what it was merged with.
        applyRemote(next.elements);
        if (next.mode === "edit") saver.flush().catch(() => setSaveStatus("error"));
      },
      onConnection: setConnection,
      onDeleted: () => { setDeleted(true); pushToast("This project's whiteboard was deleted.", "error"); },
      onAccessFailure: (error) => accessFailureRef.current(error),
      onElements: applyRemote,
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
      // Best effort for closes that bypass the Close button (Esc, tab switch, navigation): send what is
      // left, then let the socket wait briefly for the acks. The Close button itself waits and reports.
      // The flush may queue behind a save in flight, so the socket closes only once it settles (bounded).
      const finalFlush = saver.flush().catch(() => undefined);
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
  const save = useCallback(async (): Promise<WhiteboardSaveOutcome> => { if (modeRef.current === "view") return "skipped"; await saverRef.current?.flush(); }, []);
  const sharePresence = useCallback((presence: WhiteboardPresence) => { lastPresenceRef.current = presence; socketRef.current?.sendPresence(presence); }, []);

  const mode: WhiteboardMode = liveMode ?? init?.mode ?? (archivedHint ? "view" : "edit");

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
        <CopyProjectLinkButton projectId={projectId} tab="collaboration" whiteboard />
        </div>
      </div>
      <div className="min-h-0 relative border-solid border-[length:var(--border-width-hair)] border-border bg-card">
        {deleted
          ? <p className="p-[var(--space-5)]" role="alert">This project's whiteboard was deleted.</p>
          : initialData
            ? (
              <ViewLoadBoundary viewLabel="whiteboard">
                <Suspense fallback={<p className="p-[var(--space-5)]" role="status">Loading whiteboard.</p>}>
                  <Whiteboard
                    className="absolute inset-0"
                    theme="light"
                    name={street}
                    label={`Whiteboard for ${street}`}
                    initialData={initialData}
                    readOnly={mode === "view"}
                    viewOnlyIndicator={false}
                    imageTool={false}
                    background="grid"
                    onReady={(controller) => { controllerRef.current = controller; controller.adoptRevisions((init?.elements ?? []) as unknown as SavedElement[]); drainRemote.current(); }}
                    onPresence={sharePresence}
                    onElements={(elements) => { elementsRef.current = elements as ReadonlyArray<SavedElement>; replayRemote.current(); }}
                    onSave={save}
                    onSaveStatusChange={setSaveStatus}
                    onToast={pushToast}
                  />
                </Suspense>
              </ViewLoadBoundary>
            )
            : <p className="p-[var(--space-5)]" role="status">Connecting to the whiteboard.</p>}
      </div>
    </section>
  );
}
