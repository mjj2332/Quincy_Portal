import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VIDEO_TRASH_RETENTION_DAYS, type VideoDeletionImpact } from "@quincy/shared";
import { useOptionalProjectQueryClient, useProjectAccessTermination } from "../../lib/project-data";
import { pushTrashToast, trashSession } from "../../lib/video-trash-session";
import { UNDO_TOAST_TTL_MS } from "../../lib/use-scheduling-undo-toast";
import { deleteWholeVideo, readVideoDeletionImpact, refreshAfterRefusal, restoreWholeVideo } from "../../lib/video-trash-data";
import { classifyVideoTrashError, type ClassifiedVideoTrashError } from "../../lib/video-trash-errors";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../reui/alert-dialog";
import { Spinner } from "../reui/spinner";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { plural, RemovalImpactList, type ImpactRow } from "./RemovalImpactList";

/**
 * Delete a film from the grid (#868): the card's "⋯" menu opens this one confirmation, owned by the collection panel so it outlives the card that opened it. It reads what deleting the whole film
 * (every live Version) takes out of sight, lists it, sends the counts the person saw, and answers with an Undo toast. The target is captured when the confirmation opens. Drafts are not
 * retired: a grid Delete has no open composer, and an unsent note stays dormant and returns with Undo (docs/lessons.md "Don't retire user-typed state from list diffs").
 */
export type DeleteTarget = { videoId: string; title: string };
const CARD_MENU = (videoId: string) => `[data-testid="video-card-menu"][data-video-id="${videoId}"]`;
export const TRASH_BUTTON = '[data-testid="video-trash-open"]';
/** Errors a second press of Delete cannot fix: the row is gone, the Project is archived, or access is lost. */
const FINAL: ReadonlySet<ClassifiedVideoTrashError["kind"]> = new Set(["gone", "archived", "access"]);

export function VideoDeleteDialog({ projectId, target, uploadKey, localUpload, onClose, onDeleted }: {
  projectId: string;
  /** The film being deleted; null while the confirmation is closed. */
  target: DeleteTarget | null;
  /** The film's upload reservation id in the list ("" when none): a change means an upload started or ended, so the impact is read again. */
  uploadKey: string;
  /** This tab has an upload of a new Version of the film running (it may not hold a reservation yet). */
  localUpload: boolean;
  onClose: () => void;
  /** The delete went through: whatever points at the film (focus fallbacks, selection) lets go. */
  onDeleted: (videoId: string) => void;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const [impact, setImpact] = useState<VideoDeletionImpact | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [problem, setProblem] = useState<ClassifiedVideoTrashError | null>(null);
  const [pending, setPending] = useState(false);
  // Each opening and each send owns the state it writes; a completion of an earlier one applies nothing.
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; run.current += 1; }; }, []);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Both buttons are disabled while Deleting, so focus drops to <body>; a refusal keeps the dialog open, so the problem takes focus (#568).
  const problemRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (problem) problemRef.current?.focus(); }, [problem]);
  // Where focus goes when the dialog closes: the card's ⋯ after Cancel, the Trash button once the card is gone. Read from refs, because closing clears the state (#463).
  const lastVideoId = useRef<string | null>(null);
  const deleted = useRef(false);

  const uploadKeyNow = useRef(uploadKey);
  uploadKeyNow.current = uploadKey;
  const load = useCallback(async (next: DeleteTarget) => {
    const mine = ++run.current;
    const issuedUnder = uploadKeyNow.current;
    setImpact(null); setLoadFailure(null); setProblem(null);
    try {
      const read = await readVideoDeletionImpact(projectId, next.videoId);
      if (!alive.current || run.current !== mine) return;
      if (uploadKeyNow.current !== issuedUnder) { void load(next); return; }
      setImpact(read);
    } catch (error) {
      terminate(error);
      if (queryClient) void refreshAfterRefusal({ queryClient, projectId, videoId: next.videoId }, error, "delete");
      if (alive.current && run.current === mine) setLoadFailure(classifyVideoTrashError(error, "delete").message);
    }
  }, [projectId, terminate, queryClient]);

  const videoId = target?.videoId ?? null;
  useEffect(() => {
    if (videoId === null || target === null) { run.current += 1; setImpact(null); setLoadFailure(null); setProblem(null); setPending(false); return; }
    lastVideoId.current = videoId; deleted.current = false;
    setPending(false);
    void load(target);
    // Only a different film restarts the read; the title is captured with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, load]);

  // An upload that blocks the delete ends (finished or cancelled) in the film the list already observes: read the impact again, so Delete is offered without reopening.
  const seenUploadKey = useRef(uploadKey);
  useEffect(() => {
    if (seenUploadKey.current === uploadKey) return;
    seenUploadKey.current = uploadKey;
    if (target && impact?.uploading === true && !pending) void load(target);
  }, [uploadKey, target, impact, pending, load]);

  const announce = useCallback((done: DeleteTarget, started: string) => {
    if (!queryClient) return;
    const ctx = { queryClient, projectId, videoId: done.videoId };
    const subject = `“${done.title}”`;
    const undo = async () => {
      if (started !== trashSession(queryClient)) return;
      try {
        await restoreWholeVideo(ctx);
        pushTrashToast(queryClient, started, `Restored ${subject}.`);
      } catch (error) {
        pushTrashToast(queryClient, started, classifyVideoTrashError(error, "restore").message, "error");
      }
    };
    pushTrashToast(queryClient, started, `${subject} moved to Trash.`, "success", { ttlMs: UNDO_TOAST_TTL_MS, action: { label: "Undo", onAction: () => { void undo(); } } });
  }, [queryClient, projectId]);

  const confirm = async () => {
    if (!target || !impact || !queryClient) return;
    const mine = ++run.current;
    setPending(true); setProblem(null);
    const sent = target; const confirmed = impact; const started = trashSession(queryClient);
    try {
      await deleteWholeVideo({ queryClient, projectId, videoId: sent.videoId }, confirmed, () => { deleted.current = true; onDeleted(sent.videoId); });
      announce(sent, started);
      if (alive.current && run.current === mine) onClose();
    } catch (error) {
      terminate(error);
      if (!alive.current || run.current !== mine) return;
      const classified = classifyVideoTrashError(error, "delete");
      setPending(false);
      if (classified.filmImpact) setImpact(classified.filmImpact);
      setProblem(classified);
    }
  };

  const blockedByUpload = localUpload || impact?.uploading === true;
  const blockedByDelivery = impact?.published === true;
  const canConfirm = impact !== null && !pending && !blockedByUpload && !blockedByDelivery && queryClient !== undefined && !(problem && FINAL.has(problem.kind));
  const rows = useMemo(() => (impact ? filmImpactRows(impact) : []), [impact]);
  const title = target?.title ?? "";

  return <AlertDialog open={target !== null} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
    <AlertDialogContent data-testid="video-delete-dialog" initialFocus={cancelRef} finalFocus={() => (deleted.current ? document.querySelector<HTMLElement>(TRASH_BUTTON) : lastVideoId.current ? document.querySelector<HTMLElement>(CARD_MENU(lastVideoId.current)) : null) ?? true}>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
        <AlertDialogDescription className="text-foreground-secondary">
          “{title}” and its {impact ? plural(impact.versions, "version") : "versions"} move to Trash for {VIDEO_TRASH_RETENTION_DAYS} days. You can restore the film from Trash until then.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {impact === null && loadFailure === null && <p className="m-0 flex items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]" role="status"><Spinner aria-hidden="true" />Checking what this affects…</p>}
      {loadFailure !== null && <Notice tone="critical" role="alert" data-testid="video-delete-load-error">{loadFailure}</Notice>}
      {impact !== null && <RemovalImpactList rows={rows} testId="video-delete-impact" />}
      {blockedByUpload && <Notice tone="caution" role="status" data-testid="video-delete-blocked">A new version is being uploaded to this film. Wait for it to finish or cancel it before deleting the film.</Notice>}
      {!blockedByUpload && blockedByDelivery && <Notice tone="caution" role="status" data-testid="video-delete-blocked">This film is on the published Client Delivery page, so it can't be deleted. Publish the Delivery again without it, then delete it.</Notice>}
      {problem !== null && <Notice ref={problemRef} tabIndex={-1} tone="critical" role="alert" data-testid="video-delete-problem">{problem.message}</Notice>}
      <AlertDialogFooter>
        <AlertDialogCancel ref={cancelRef} data-testid="video-delete-cancel" disabled={pending}>{problem && FINAL.has(problem.kind) ? "Close" : "Cancel"}</AlertDialogCancel>
        {loadFailure !== null && target !== null && <Button type="button" variant="secondary" data-testid="video-delete-retry" onClick={() => { void load(target); }}>Retry</Button>}
        <AlertDialogAction variant="destructive" data-testid="video-delete-confirm" disabled={!canConfirm} onClick={() => { void confirm(); }}>{pending ? "Deleting…" : "Delete film"}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

/** What deleting the film hides, one row each; empty when nothing beyond the film is touched. */
function filmImpactRows(impact: VideoDeletionImpact): ImpactRow[] {
  const rows: ImpactRow[] = [];
  if (impact.notes > 0) rows.push({ key: "notes", title: plural(impact.notes, "note"), description: "Notes, replies and drawings on every version are hidden. A restore brings them back." });
  if (impact.decisions > 0) rows.push({ key: "decisions", title: plural(impact.decisions, "client decision"), description: "The client's approvals and change requests are hidden with the film." });
  if (impact.releases > 0) rows.push({ key: "releases", title: plural(impact.releases, "released version"), badge: "Live", description: "Clients lose these versions while the film is in Trash. A restore brings the releases back." });
  if (impact.links.length > 0) rows.push({ key: "links", title: plural(impact.links.length, "review link"), description: `${impact.links.map((link) => link.label ?? "Untitled link").join(", ")} will stop showing this film.` });
  return rows;
}
