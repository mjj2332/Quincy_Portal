import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import type { WhiteboardMode } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import type { WhiteboardController, WhiteboardSaveStatus } from "./reui/whiteboard/whiteboard";
import { CopyProjectLinkButton } from "./quincy/CopyProjectLinkButton";
import { ViewLoadBoundary } from "./ViewLoadBoundary";
import { openWhiteboardSocket, type WhiteboardConnection, type WhiteboardInit, type WhiteboardSocket } from "../lib/whiteboard-socket";
import { pushToast } from "../lib/toast-store";

// The ReUI block lazy-loads Excalidraw itself (`whiteboard.tsx` imports `whiteboard-canvas` on demand); this
// second `lazy` keeps even the block's own chunk out of the Workspace until the board opens (#498).
const Whiteboard = lazy(() => import("./reui/whiteboard/whiteboard").then((module) => ({ default: module.Whiteboard })));

type SceneElement = { id: string; version: number; versionNonce: number };

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
  const sentVersions = useRef(new Map<string, { version: number; versionNonce: number }>());
  const accessFailureRef = useRef(onAccessFailure);
  accessFailureRef.current = onAccessFailure;

  useEffect(() => {
    const socket = openWhiteboardSocket(projectId, {
      onInit: (next, reconnect) => {
        // A reconnect keeps the board the user is looking at (#499 reconciles it live); only the mode moves.
        setInit((current) => (reconnect && current ? { ...current, mode: next.mode } : next));
        if (!reconnect) for (const element of next.elements as SceneElement[]) sentVersions.current.set(element.id, { version: element.version, versionNonce: element.versionNonce });
      },
      onConnection: setConnection,
      onDeleted: () => { setDeleted(true); pushToast("This project's whiteboard was deleted.", "error"); },
      onAccessFailure: (error) => accessFailureRef.current(error),
    });
    socketRef.current = socket;
    return () => {
      // The board's unmount save is sent just before this cleanup runs; the socket waits briefly for its ack.
      socket.close();
      socketRef.current = null;
    };
  }, [projectId]);

  const save = useCallback(async () => {
    const controller = controllerRef.current;
    const socket = socketRef.current;
    if (!controller || !socket) return;
    const all = controller.api.getSceneElementsIncludingDeleted() as unknown as ReadonlyArray<SceneElement>;
    const changed = all.filter((element) => {
      const sent = sentVersions.current.get(element.id);
      return !sent || sent.version !== element.version || sent.versionNonce !== element.versionNonce;
    });
    if (changed.length === 0) return;
    await socket.send(changed);
    for (const element of changed) sentVersions.current.set(element.id, { version: element.version, versionNonce: element.versionNonce });
  }, []);

  const mode: WhiteboardMode = init?.mode ?? (archivedHint ? "view" : "edit");
  const initialData = useMemo(() => (init ? { elements: init.elements as never } : undefined), [init]);
  const statusLabel = connection === "reconnecting" ? "Reconnecting" : saveStatus === "saving" ? "Saving" : saveStatus === "error" ? "Not saved" : saveStatus === "unsaved" ? "Unsaved changes" : "Saved";

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[var(--space-3)] h-[calc(100dvh-var(--space-8))] min-h-[28rem]" data-testid="project-whiteboard" data-quincy-whiteboard aria-label={`Whiteboard for ${street}`}>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <Button type="button" variant="ghost" onClick={onClose} data-testid="project-whiteboard-close"><ArrowLeftIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />Close whiteboard</Button>
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
