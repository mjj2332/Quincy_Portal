import { useCallback, useEffect, useMemo, useImperativeHandle, useRef, useState, type Ref } from "react";
import { VIDEO_TRASH_RETENTION_DAYS, type VideoDto, type VideoRemovalImpact } from "@quincy/shared";
import { useOptionalProjectQueryClient, useProjectAccessTermination } from "../../lib/project-data";
import { pushTrashToast, trashSession } from "../../lib/video-trash-session";
import { UNDO_TOAST_TTL_MS } from "../../lib/use-scheduling-undo-toast";
import { readRemovalImpact, refreshAfterRefusal, removeVideoVersion, restoreVideoVersion, restoreWholeVideo } from "../../lib/video-trash-data";
import { classifyVideoTrashError, type ClassifiedVideoTrashError } from "../../lib/video-trash-errors";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../reui/alert-dialog";
import { plural, RemovalImpactList, type ImpactRow } from "./RemovalImpactList";
import { Spinner } from "../reui/spinner";
import { Button } from "../quincy/Button";
import { ICON_BUTTON } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { Notice } from "../quincy/Notice";
import { cn } from "@/lib/utils";

/**
 * The Version menu of the staff review viewer (#776 E): a "⋯" beside the Version select whose one item, Remove version…, reads what removing this Version takes out of sight, asks for a
 * confirmation that lists it (a stronger one, for the whole film, when this is the last Version), sends the counts the person saw, and answers with an Undo toast. It is its own chunk: a
 * Project whose `trash` part is off never loads it. The target Version is captured when the confirmation opens, so a Version switch (or the list refreshing) while it is open cannot
 * change what is removed. Reuse ledger: docs/plans/776-e-ledger.md.
 */
export type RemovedVersion = { assetId: string; videoId: string; /** The Video as it stands, or null when removing the last Version removed the Video. */ video: VideoDto | null };

/** How the viewer opens the removal confirmation for a Version (its list rows, #862). The Version is resolved against the Video at call time; an unknown id does nothing. `returnFocusTo`: where focus goes when the confirmation closes. */
export type VersionRemovalHandle = { open: (assetId: string, returnFocusTo: () => HTMLElement | null) => void };

type Target = { assetId: string; version: number; videoId: string; title: string };
const MENU_TRIGGER_SELECTOR = '[data-testid="video-version-menu"]';
/** Errors a second press of Remove cannot fix: the row is gone, the Project is archived, or access is lost. */
const FINAL: ReadonlySet<ClassifiedVideoTrashError["kind"]> = new Set(["gone", "archived", "access"]);

export function VideoVersionMenu({ projectId, archived, video, version, hasDraft, captureDrafts, onRemoved, removeRef }: {
  projectId: string;
  archived: boolean;
  video: VideoDto;
  version: VideoDto["versions"][number];
  /** The Version has an unsent note or an open note form; the confirmation says it will go. */
  hasDraft: (assetId: string, videoId: string, whole: boolean) => boolean;
  /** Notes what the slots the removal retires hold now; the returned function retires them (the Video's too when `whole`) only if they hold exactly that when the answer arrives. */
  captureDrafts: (assetId: string, videoId: string) => (whole: boolean) => void;
  /** The removal went through: retire everything that points at that Version. */
  onRemoved: (removed: RemovedVersion) => void;
  /** Receives `open`, so a Version's own row in the list can start the same removal (#862). */
  removeRef?: Ref<VersionRemovalHandle>;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const [target, setTarget] = useState<Target | null>(null);
  const [impact, setImpact] = useState<VideoRemovalImpact | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [problem, setProblem] = useState<ClassifiedVideoTrashError | null>(null);
  const [pending, setPending] = useState(false);
  // Each opening and each send owns the state it writes; a completion of an earlier one (a closed dialog's read, a Version left behind) applies nothing.
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; run.current += 1; }; }, []);
  // The menu closes before the dialog has focus: while Remove is handing off, the menu moves no focus (#463); the dialog returns focus to the trigger itself.
  const handOff = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Both buttons are disabled while Removing, so focus drops to <body>; a refusal keeps the dialog open, so the problem takes focus (#568).
  const problemRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (problem) problemRef.current?.focus(); }, [problem]);

  // The upload generation: each impact read is issued under one, and an answer that comes back under another predates the change and is read again.
  const uploadKey = video.uploading?.reservationId ?? "";
  const uploadKeyNow = useRef(uploadKey);
  uploadKeyNow.current = uploadKey;
  const load = useCallback(async (next: Target) => {
    const mine = ++run.current;
    const issuedUnder = uploadKeyNow.current;
    setImpact(null); setLoadFailure(null); setProblem(null);
    try {
      const read = await readRemovalImpact(projectId, next.assetId);
      if (!alive.current || run.current !== mine) return;
      if (uploadKeyNow.current !== issuedUnder) { void load(next); return; }
      setImpact(read);
    } catch (error) {
      terminate(error);
      // A refusal here means what it means for the removal itself: the Version is gone, or the Project or gate is.
      if (queryClient) void refreshAfterRefusal({ queryClient, projectId, videoId: next.videoId }, error, "remove");
      if (alive.current && run.current === mine) setLoadFailure(classifyVideoTrashError(error, "remove").message);
    }
  }, [projectId, terminate, queryClient]);

  // An upload that blocks removing the whole film ends (finished or cancelled) in the Video the list already observes: read the impact again, so Remove is offered without reopening.
  const seenUploadKey = useRef(uploadKey);
  useEffect(() => {
    if (seenUploadKey.current === uploadKey) return;
    seenUploadKey.current = uploadKey;
    if (target && impact?.uploading === true && !pending) void load(target);
  }, [uploadKey, target, impact, pending, load]);

  // Where focus returns when the confirmation closes: read from a ref, because closing clears the state (#463). Unset: the ⋯ trigger.
  const returnFocus = useRef<(() => HTMLElement | null) | null>(null);
  const open = (source: VideoDto["versions"][number], returnFocusTo: (() => HTMLElement | null) | null) => {
    const next: Target = { assetId: source.assetId, version: source.version, videoId: video.id, title: video.title };
    returnFocus.current = returnFocusTo;
    setTarget(next); setPending(false);
    void load(next);
  };
  const videoNow = useRef(video);
  videoNow.current = video;
  const openNow = useRef(open);
  openNow.current = open;
  useImperativeHandle(removeRef, () => ({
    open: (assetId, returnFocusTo) => {
      const found = videoNow.current.versions.find((candidate) => candidate.assetId === assetId);
      if (found) openNow.current(found, returnFocusTo);
    },
  }), []);
  const close = () => { run.current += 1; setTarget(null); setImpact(null); setLoadFailure(null); setProblem(null); setPending(false); };

  /** `whole`: what the person confirmed (the last Version, so the whole film), never what the answer turned out to be: another editor may have removed the other Versions first. */
  const announce = useCallback((done: Target, whole: boolean, started: string) => {
    if (!queryClient) return;
    const ctx = { queryClient, projectId, videoId: done.videoId };
    const subject = `“${done.title}”`;
    const undo = async () => {
      if (started !== trashSession(queryClient)) return;
      try {
        if (whole) await restoreWholeVideo(ctx); else await restoreVideoVersion({ ...ctx, assetId: done.assetId });
        pushTrashToast(queryClient, started, whole ? `Restored ${subject}.` : `Restored version ${done.version} of ${subject}.`);
      } catch (error) {
        pushTrashToast(queryClient, started, classifyVideoTrashError(error, "restore").message, "error");
      }
    };
    pushTrashToast(queryClient, started, whole ? `${subject} removed.` : `Version ${done.version} of ${subject} removed.`, "success", { ttlMs: UNDO_TOAST_TTL_MS, action: { label: "Undo", onAction: () => { void undo(); } } });
  }, [queryClient, projectId]);

  const confirm = async () => {
    if (!target || !impact || !queryClient) return;
    const mine = ++run.current;
    setPending(true); setProblem(null);
    const sent = target; const confirmed = impact; const retireDrafts = captureDrafts(sent.assetId, sent.videoId); const started = trashSession(queryClient);
    try {
      const response = await removeVideoVersion({ queryClient, projectId, videoId: sent.videoId, assetId: sent.assetId }, confirmed, confirmed.lastVersion, (applied) => {
        // The removal happened whatever this dialog has become since: retire the Version as the answer is applied, before the refetches (a restored Version may be drafted on meanwhile).
        retireDrafts(applied.video === null);
        onRemoved({ assetId: sent.assetId, videoId: sent.videoId, video: applied.video });
      });
      // ...and say so.
      announce(sent, confirmed.lastVersion, started);
      if (alive.current && run.current === mine) close();
    } catch (error) {
      terminate(error);
      if (!alive.current || run.current !== mine) return;
      const classified = classifyVideoTrashError(error, "remove");
      setPending(false);
      if (classified.impact) setImpact(classified.impact);
      setProblem(classified);
    }
  };

  const last = impact?.lastVersion ?? false;
  const draft = target !== null && hasDraft(target.assetId, target.videoId, last);
  const blockedByUpload = last && impact?.uploading === true;
  const title = last ? "Remove the whole film?" : `Remove version ${target?.version ?? ""}?`;
  const canConfirm = impact !== null && !pending && !blockedByUpload && queryClient !== undefined && !(problem && FINAL.has(problem.kind));
  const rows = useMemo(() => (impact ? impactRows(impact) : []), [impact]);

  return <>
    <Menu
      triggerLabel="Version actions" label="Version menu" triggerTestId="video-version-menu"
      triggerClassName={cn(ICON_BUTTON, "text-foreground")}
      trigger={<span aria-hidden="true">⋯</span>}
      finalFocus={() => (handOff.current ? false : undefined)}
      onOpenChange={(isOpen) => { if (isOpen) handOff.current = false; }}
    >
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive-wash-foreground")} disabled={archived || !queryClient} data-testid="video-version-remove" onClick={() => { handOff.current = true; open(version, null); }}>Remove version…</MenuPrimitive.Item>
    </Menu>
    <AlertDialog open={target !== null} onOpenChange={(next) => { if (!next && !pending) close(); }}>
      <AlertDialogContent data-testid="video-remove-dialog" initialFocus={cancelRef} finalFocus={() => returnFocus.current?.() ?? document.querySelector<HTMLElement>(MENU_TRIGGER_SELECTOR) ?? true}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground-secondary">
            {last
              ? <>Version {target?.version} is the only version of “{target?.title}”, so removing it removes the whole film. The film moves to Trash for {VIDEO_TRASH_RETENTION_DAYS} days, and you can restore it from Trash until then.</>
              : <>Version {target?.version} of “{target?.title}” moves to Trash for {VIDEO_TRASH_RETENTION_DAYS} days. The film keeps its other versions, and you can restore this one from Trash until then.</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {impact === null && loadFailure === null && <p className="m-0 flex items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]" role="status"><Spinner aria-hidden="true" />Checking what this affects…</p>}
        {loadFailure !== null && <Notice tone="critical" role="alert" data-testid="video-remove-load-error">{loadFailure}</Notice>}
        {impact !== null && <RemovalImpactList rows={rows} testId="video-remove-impact" />}
        {blockedByUpload && <Notice tone="caution" role="status">A new version is being uploaded to this film. Wait for it to finish or cancel it before removing the whole film.</Notice>}
        {draft && <Notice tone="caution" role="status" data-testid="video-remove-draft">You have an unsent note or entry on this version. It will be discarded.</Notice>}
        {problem !== null && <Notice ref={problemRef} tabIndex={-1} tone="critical" role="alert" data-testid="video-remove-problem">{problem.message}</Notice>}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} data-testid="video-remove-cancel" disabled={pending}>{problem && FINAL.has(problem.kind) ? "Close" : "Cancel"}</AlertDialogCancel>
          {loadFailure !== null && target !== null && <Button type="button" variant="secondary" data-testid="video-remove-retry" onClick={() => { void load(target); }}>Retry</Button>}
          <AlertDialogAction variant="destructive" data-testid="video-remove-confirm" disabled={!canConfirm} onClick={() => { void confirm(); }}>{pending ? "Removing…" : last ? "Remove film" : "Remove version"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

/** What the removal hides, one row each; empty when nothing else is touched. */
function impactRows(impact: VideoRemovalImpact): ImpactRow[] {
  const rows: ImpactRow[] = [];
  if (impact.notes > 0) rows.push({ key: "notes", title: plural(impact.notes, "note"), description: "Notes, replies and drawings on this version are hidden. A restore brings them back." });
  if (impact.decisions > 0) rows.push({ key: "decisions", title: plural(impact.decisions, "client decision"), description: "The client's approvals and change requests are hidden with it." });
  if (impact.release) rows.push({ key: "release", title: "Released to the client", badge: "Live", description: "Clients lose this version while it is in Trash. A restore brings the release back." });
  if (impact.links.length > 0) rows.push({ key: "links", title: plural(impact.links.length, "review link"), description: `${impact.links.map((link) => link.label ?? "Untitled link").join(", ")} will stop showing this version.` });
  return rows;
}
