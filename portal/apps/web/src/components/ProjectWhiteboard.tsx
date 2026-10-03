import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import type { WhiteboardMode } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import type { WhiteboardController, WhiteboardSaveStatus } from "./reui/whiteboard/whiteboard";
import { CopyProjectLinkButton } from "./quincy/CopyProjectLinkButton";
import { ViewLoadBoundary } from "./ViewLoadBoundary";
import { openWhiteboardSocket, type WhiteboardConnection, type WhiteboardInit, type WhiteboardSocket } from "../lib/whiteboard-socket";
import { createWhiteboardSaver, type SavedElement, type WhiteboardSaver } from "../lib/whiteboard-saver";
import { pushToast } from "../lib/toast-store";

// The ReUI block lazy-loads Excalidraw itself (`whiteboard.tsx` imports `whiteboard-canvas` on demand); this
// second `lazy` keeps even the block's own chunk out of the Workspace until the board opens (#498).
const Whiteboard = lazy(() => import("./reui/whiteboard/whiteboard").then((module) => ({ default: module.Whiteboard })));


/**
 * #498: the Project whiteboard (ADR 0017), composed on ReUI `whiteboard-1`. The Portal's own parts are the
 * toolbar (street, view-only badge, save status, a link that reopens THIS board, Close) and the transport:
 * a WebSocket to the Project's Durable Object. Live broadcast and presence arrive with #499, versions with
 * #500 and media with #501, so the image tool is off. Quincy has no dark tokens, so the theme is fixed light.
 */
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
  const socketRef = useRef<WhiteboardSocket | null>(null);
  const controllerRef = useRef<WhiteboardController | null>(null);
  const saverRef = useRef<WhiteboardSaver | null>(null);
  const closeFailed = useRef(false);
  const accessFailureRef = useRef(onAccessFailure);
  accessFailureRef.current = onAccessFailure;

  useEffect(() => {
    const saver = createWhiteboardSaver({
      getElements: () => (controllerRef.current?.api.getSceneElementsIncludingDeleted() ?? []) as unknown as ReadonlyArray<SavedElement>,
      send: (batch) => socketRef.current?.send(batch) ?? Promise.reject(new Error("The whiteboard is not connected.")),
    });
    saverRef.current = saver;
    const socket = openWhiteboardSocket(projectId, {
      onInit: (next, reconnect) => {
        // A reconnect keeps the board the user is looking at (#499 reconciles it live); only the mode moves.
        setInit((current) => (reconnect && current ? { ...current, mode: next.mode } : next));
        if (!reconnect) saver.seed(next.elements as unknown as SavedElement[]);
        // Anything that was not acknowledged before the drop goes out again now.
        else if (next.mode === "edit") saver.flush().catch(() => setSaveStatus("error"));
      },
      onConnection: setConnection,
      onDeleted: () => { setDeleted(true); pushToast("This project's whiteboard was deleted.", "error"); },
      onAccessFailure: (error) => accessFailureRef.current(error),
    });
    socketRef.current = socket;
    return () => {
      // Best effort for closes that bypass the Close button (Esc, tab switch, navigation): send what is
      // left, then let the socket wait briefly for the acks. The Close button itself waits and reports.
      saver.flush().catch(() => undefined);
      socket.close();
      socketRef.current = null;
    };
  }, [projectId]);

  const save = useCallback(async () => { await saverRef.current?.flush(); }, []);

  const mode: WhiteboardMode = init?.mode ?? (archivedHint ? "view" : "edit");

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
    onClose();
  }, [mode, onClose]);
  const initialData = useMemo(() => (init ? { elements: init.elements as never } : undefined), [init]);
  const statusLabel = connection === "reconnecting" ? "Reconnecting" : saveStatus === "saving" ? "Saving" : saveStatus === "error" ? "Not saved" : saveStatus === "unsaved" ? "Unsaved changes" : "Saved";

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[var(--space-3)] h-[calc(100dvh-var(--space-8))] min-h-[28rem]" data-testid="project-whiteboard" data-quincy-whiteboard aria-label={`Whiteboard for ${street}`}>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <Button type="button" variant="ghost" onClick={() => void requestClose()} data-testid="project-whiteboard-close"><ArrowLeftIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />Close whiteboard</Button>
        <h2 className="serif [font:var(--type-h3)] me-auto min-w-0 truncate">{street}</h2>
        {mode === "view" && <Badge variant="primary-light" data-testid="project-whiteboard-view-only">View only</Badge>}
        <span className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" role="status" data-testid="project-whiteboard-status">{deleted ? "Deleted" : statusLabel}</span>
        <CopyProjectLinkButton projectId={projectId} tab="collaboration" whiteboard />
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
                    imageTool={false}
                    background="grid"
                    onReady={(controller) => { controllerRef.current = controller; }}
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
