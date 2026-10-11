import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VIDEO_TRASH_RETENTION_DAYS, type VideoDto, type VideoRemovalImpact } from "@quincy/shared";
import { useOptionalProjectQueryClient, useProjectAccessTermination } from "../../lib/project-data";
import { pushToast } from "../../lib/toast-store";
import { UNDO_TOAST_TTL_MS } from "../../lib/use-scheduling-undo-toast";
import { readRemovalImpact, removeVideoVersion, restoreVideoVersion, restoreWholeVideo } from "../../lib/video-trash-data";
import { classifyVideoTrashError, type ClassifiedVideoTrashError } from "../../lib/video-trash-errors";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../reui/alert-dialog";
import { Badge } from "../reui/badge";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
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

type Target = { assetId: string; version: number; videoId: string; title: string };
const MENU_TRIGGER_SELECTOR = '[data-testid="video-version-menu"]';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Errors a second press of Remove cannot fix: the row is gone, the Project is archived, or access is lost. */
const FINAL: ReadonlySet<ClassifiedVideoTrashError["kind"]> = new Set(["gone", "archived", "access"]);

export function VideoVersionMenu({ projectId, archived, video, version, hasDraft, onRemoved }: {
  projectId: string;
  archived: boolean;
  video: VideoDto;
  version: VideoDto["versions"][number];
  /** The Version has an unsent note or an open note form; the confirmation says it will go. */
  hasDraft: (assetId: string) => boolean;
  /** The removal went through: retire everything that points at that Version. */
  onRemoved: (removed: RemovedVersion) => void;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const [target, setTarget] = useState<Target | null>(null);
  const [impact, setImpact] = useState<VideoRemovalImpact | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [problem, setProblem] = useState<ClassifiedVideoTrashError | null>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState(false);
  // Each opening and each send owns the state it writes; a completion of an earlier one (a closed dialog's read, a Version left behind) applies nothing.
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; run.current += 1; }; }, []);
  // The menu closes before the dialog has focus: while Remove is handing off, the menu moves no focus (#463); the dialog returns focus to the trigger itself.
  const handOff = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (next: Target) => {
    const mine = ++run.current;
    setImpact(null); setLoadFailure(null); setProblem(null);
    try {
      const read = await readRemovalImpact(projectId, next.assetId);
      if (alive.current && run.current === mine) setImpact(read);
    } catch (error) {
      terminate(error);
      if (alive.current && run.current === mine) setLoadFailure(classifyVideoTrashError(error, "remove").message);
    }
  }, [projectId, terminate]);

  const open = () => {
    const next: Target = { assetId: version.assetId, version: version.version, videoId: video.id, title: video.title };
    setTarget(next); setPending(false); setDraft(hasDraft(next.assetId));
    void load(next);
  };
  const close = () => { run.current += 1; setTarget(null); setImpact(null); setLoadFailure(null); setProblem(null); setPending(false); };

  /** `whole`: what the person confirmed (the last Version, so the whole film), never what the answer turned out to be: another editor may have removed the other Versions first. */
  const announce = useCallback((done: Target, whole: boolean) => {
    if (!queryClient) return;
    const ctx = { queryClient, projectId, videoId: done.videoId };
    const subject = `“${done.title}”`;
    const undo = async () => {
      try {
        if (whole) await restoreWholeVideo(ctx); else await restoreVideoVersion({ ...ctx, assetId: done.assetId });
        pushToast(whole ? `Restored ${subject}.` : `Restored version ${done.version} of ${subject}.`);
      } catch (error) {
        pushToast(classifyVideoTrashError(error, "restore").message, "error");
      }
    };
    pushToast(whole ? `${subject} removed.` : `Version ${done.version} of ${subject} removed.`, "success", { ttlMs: UNDO_TOAST_TTL_MS, action: { label: "Undo", onAction: () => { void undo(); } } });
  }, [queryClient, projectId]);

  const confirm = async () => {
    if (!target || !impact || !queryClient) return;
    const mine = ++run.current;
    setPending(true); setProblem(null);
    const sent = target; const confirmed = impact;
    try {
      const response = await removeVideoVersion({ queryClient, projectId, videoId: sent.videoId, assetId: sent.assetId }, confirmed, confirmed.lastVersion);
      // The removal happened whatever this dialog has become since: retire the Version and say so.
      onRemoved({ assetId: sent.assetId, videoId: sent.videoId, video: response.video });
      announce(sent, confirmed.lastVersion);
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
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={archived || !queryClient} data-testid="video-version-remove" onClick={() => { handOff.current = true; open(); }}>Remove version…</MenuPrimitive.Item>
    </Menu>
    <AlertDialog open={target !== null} onOpenChange={(next) => { if (!next && !pending) close(); }}>
      <AlertDialogContent data-testid="video-remove-dialog" initialFocus={cancelRef} finalFocus={() => document.querySelector<HTMLElement>(MENU_TRIGGER_SELECTOR) ?? true}>
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
        {impact !== null && <ItemGroup data-testid="video-remove-impact">
          {rows.length === 0
            ? <Item size="xs"><ItemContent><ItemTitle className="font-normal">Nothing else is affected.</ItemTitle></ItemContent></Item>
            : rows.map((row) => <Item key={row.key} size="xs"><ItemContent>
              <ItemTitle className="font-normal">{row.title}{row.badge && <Badge variant="warning-light" size="sm">{row.badge}</Badge>}</ItemTitle>
              <ItemDescription>{row.description}</ItemDescription>
            </ItemContent></Item>)}
        </ItemGroup>}
        {blockedByUpload && <Notice tone="caution" role="status">A new version is being uploaded to this film. Wait for it to finish or cancel it before removing the whole film.</Notice>}
        {draft && <Notice tone="caution" role="status" data-testid="video-remove-draft">You have an unsent note on this version. It will be discarded.</Notice>}
        {problem !== null && <Notice tone="critical" role="alert" data-testid="video-remove-problem">{problem.message}</Notice>}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} data-testid="video-remove-cancel" disabled={pending}>{problem && FINAL.has(problem.kind) ? "Close" : "Cancel"}</AlertDialogCancel>
          {loadFailure !== null && target !== null && <Button type="button" variant="secondary" data-testid="video-remove-retry" onClick={() => { void load(target); }}>Retry</Button>}
          <AlertDialogAction variant="destructive" data-testid="video-remove-confirm" disabled={!canConfirm} onClick={() => { void confirm(); }}>{pending ? "Removing…" : last ? "Remove film" : "Remove version"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

type Row = { key: string; title: string; description: string; badge?: string };
/** What the removal hides, one row each; empty when nothing else is touched. */
function impactRows(impact: VideoRemovalImpact): Row[] {
  const rows: Row[] = [];
  if (impact.notes > 0) rows.push({ key: "notes", title: plural(impact.notes, "note"), description: "Notes, replies and drawings on this version are hidden. A restore brings them back." });
  if (impact.decisions > 0) rows.push({ key: "decisions", title: plural(impact.decisions, "client decision"), description: "The client's approvals and change requests are hidden with it." });
  if (impact.release) rows.push({ key: "release", title: "Released to the client", badge: "Live", description: "Clients lose this version while it is in Trash. A restore brings the release back." });
  if (impact.links.length > 0) rows.push({ key: "links", title: plural(impact.links.length, "review link"), description: `${impact.links.map((link) => link.label ?? "Untitled link").join(", ")} will stop showing this version.` });
  return rows;
}
