import { useCallback, useEffect, useRef, useState } from "react";
import { whiteboardRestorePath, whiteboardVersionsPath, type WhiteboardVersionSummary, type WhiteboardVersionsResponse } from "@quincy/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/reui/alert-dialog";
import { BoardPanel, type PanelTab } from "./reui/whiteboard/board-panel";
import { HistoryTab, type HistoryState } from "./reui/whiteboard/history-tab";
import { ApiError, apiGet, apiPost } from "../lib/api";
import { pushToast } from "../lib/toast-store";

const STALE_MESSAGE = "The board changed since this list loaded. The list is refreshed, so check it and try again.";

const OFFLINE_SUFFIX = " Check your connection and try again.";

/** What the person reads for a failed request: a server's own sentence for a 4xx, plain copy for a dropped connection or a server fault, never the raw `Failed to fetch`. */
function failureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return fallback + OFFLINE_SUFFIX;
  return error.status >= 500 ? fallback : error.message;
}

/**
 * #500: the Project whiteboard's History (ADR 0017). The ReUI `whiteboard-1` panel (`reui/whiteboard/board-panel`) with only its `history`
 * pane, as a sheet; `ProjectWhiteboard` lazy-loads this file the first time History is opened. Versions are the server's automatic snapshots.
 * Restore is confirmed first (the current board is backed up before anything changes), sent with a fresh `requestId` (a retry is idempotent)
 * and the generation the list was read at (a restore of a board that has since changed is refused, and the list refetched). The board itself
 * is replaced by the server's `reset` frame, not by this response. A view-only or archived board lists the versions and cannot restore.
 */
/** How long the board must be quiet before the open list is read again (#559): live drawing is one read after it settles, not one per stroke. */
export const HISTORY_REFRESH_QUIET_MS = 1500;

export function WhiteboardHistoryPanel({ projectId, title, open, onOpenChange, readOnly, onRestoreStarted, onRestoreFailed, changes }: {
  projectId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
  /** Called just before the restore request leaves, so the board can tell its own reset from someone else's. */
  onRestoreStarted: () => void;
  /** The restore request failed, so no reset is coming for it. */
  onRestoreFailed: () => void;
  /** #559: while the sheet is open the panel puts a "the board changed" function here (a collaborator's edit, a reset); a quiet moment later the list is read again so the Current marker follows the board. */
  changes?: { current: (() => void) | null };
}) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [tab, setTab] = useState<PanelTab>("history");
  const [confirming, setConfirming] = useState<WhiteboardVersionSummary | null>(null);
  const [restoring, setRestoring] = useState(false);
  const generationRef = useRef(0);
  const loadToken = useRef(0);
  const tabRef = useRef<HTMLButtonElement | null>(null);
  const restoreButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /** The row whose Restore opened the confirmation: `confirming` is already null when the dialog's focus returns, so the id is kept here. */
  const confirmedFromRef = useRef<string | null>(null);

  const load = useCallback(async (silent = false) => {
    const token = ++loadToken.current;
    if (!silent) setState({ status: "loading" });
    try {
      const response = await apiGet<WhiteboardVersionsResponse>(whiteboardVersionsPath(projectId));
      if (token !== loadToken.current) return;
      generationRef.current = response.generation;
      setState({ status: "ready", versions: response.versions, currentVersionId: response.currentVersionId ?? null });
    } catch (error) {
      if (token !== loadToken.current) return;
      if (silent) return; // a background refresh that fails leaves the list as it was
      setState({ status: "error", message: failureMessage(error, "The history could not be loaded.") });
    }
  }, [projectId]);

  // Every opening reads the list afresh: it is what a restore's expected generation comes from.
  useEffect(() => { if (open) void load(); else loadToken.current += 1; }, [open, load]);

  const restoringRef = useRef(false);
  useEffect(() => {
    if (!open || !changes) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    changes.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!restoringRef.current) void load(true); }, HISTORY_REFRESH_QUIET_MS);
    };
    return () => { clearTimeout(timer); changes.current = null; };
  }, [open, changes, load]);

  const restore = useCallback(async (version: WhiteboardVersionSummary) => {
    setRestoring(true);
    restoringRef.current = true;
    onRestoreStarted();
    try {
      await apiPost(whiteboardRestorePath(projectId, version.id), { expectedGeneration: generationRef.current, requestId: crypto.randomUUID() });
      setConfirming(null);
      onOpenChange(false);
    } catch (error) {
      onRestoreFailed();
      setConfirming(null);
      const details = error instanceof ApiError ? (error.details as { code?: unknown } | undefined) : undefined;
      if (error instanceof ApiError && error.status === 409 && details?.code === "stale_generation") {
        pushToast(STALE_MESSAGE, "error");
        void load();
      } else {
        pushToast(failureMessage(error, "The board could not be restored."), "error");
      }
    } finally {
      setRestoring(false);
      restoringRef.current = false;
    }
  }, [projectId, load, onOpenChange, onRestoreStarted, onRestoreFailed]);

  return (
    <>
      <BoardPanel
        title="History"
        description={title}
        panelId="whiteboard-history-panel"
        tabRef={tabRef}
        docked={false}
        measured
        dockOpen={false}
        sheetOpen={open}
        // The confirmation sits in its own layer: a press in it is not a press outside the sheet.
        onSheetOpenChange={(next) => { if (!next && confirming) return; onOpenChange(next); }}
        tab={tab}
        onTabChange={setTab}
        panes={{
          history: (
            <HistoryTab
              state={state}
              readOnly={readOnly}
              onRestore={(version) => { confirmedFromRef.current = version.id; setConfirming(version); }}
              onRetry={() => void load()}
              restoreRef={(id) => (node) => { restoreButtons.current.set(id, node); }}
            />
          ),
        }}
      />
      <AlertDialog open={confirming !== null} onOpenChange={(next) => { if (!next && !restoring) setConfirming(null); }}>
        <AlertDialogContent
          data-testid="whiteboard-restore-confirm"
          initialFocus={cancelRef}
          finalFocus={() => (confirmedFromRef.current ? restoreButtons.current.get(confirmedFromRef.current) : null) ?? tabRef.current}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              The board goes back to how it was then, for everyone who has it open, and changes not yet saved are replaced. A backup of the board as it is now is saved first, so you can restore it from History.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} data-testid="whiteboard-restore-confirm-cancel" disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="whiteboard-restore-confirm-action" disabled={restoring} onClick={() => { if (confirming) void restore(confirming); }}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
