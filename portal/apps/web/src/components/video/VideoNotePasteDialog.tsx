import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { framesToTimecode, type VideoNotePasteCommitResponse, type VideoNotePastePreviewResponse, type VideoNotePasteRow, type VideoNotePasteSkipReason, type VideoVersionDto } from "@quincy/shared";
import type { NoteFormStore, PasteClipboard } from "../../lib/video-note-form-store";
import { noteAnchorLabel } from "../../lib/video-note-view";
import { cn } from "../../lib/utils";
import { Button } from "../quincy/Button";
import { Notice } from "../quincy/Notice";
import { Checkbox } from "../reui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../reui/dialog";
import { Label } from "../reui/label";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "../reui/number-field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../reui/table";
import { VisibilityBadge } from "./VideoNoteThread";

/** How long the offset field rests before the preview is asked again. */
export const PASTE_PREVIEW_DEBOUNCE_MS = 300;

/** Why a note is not in the table, in the words a person would use. */
export const PASTE_SKIP_COPY: Record<VideoNotePasteSkipReason, string> = {
  already_copied: "Already copied to this version",
  out_of_range: "Falls outside this version",
  deleted: "Deleted on the source version",
  reply: "Replies are not copied on their own",
};

type Mapped = Extract<VideoNotePasteRow, { status: "mapped" }>;
type Skipped = Extract<VideoNotePasteRow, { status: "skipped" }>;

const MONO = "[font:var(--type-mono)] tabular-nums whitespace-nowrap";
const timecodeOf = (version: VideoVersionDto) => (frame: number) => framesToTimecode(frame, { nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }, version.startTimecodeFrames ?? 0);

/**
 * Paste the notes copied from another Version of this Video onto the one on screen (#741 5c-ui). It asks the server for the plan (nothing is
 * written), shows source → new timecodes with a tick per note and the notes that will be left out with the reason, and commits the ticked
 * ones with the revisions it showed. Visibility is shown and never chosen: the server copies it from each source note.
 * The offset and the ticks live in the Video tab's form store (keyed by this Version), so closing and reopening loses nothing; everything
 * else here is only what the server last said, asked again on open. A commit is idempotent, so after a network failure it may simply be sent again.
 */
export function VideoNotePasteDialog({ open, onOpenChange, store, assetId, target, source, clipboard, previewPaste, commitPaste, finalFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: NoteFormStore;
  /** The Version the notes are pasted onto (the one on screen). */
  assetId: string;
  target: VideoVersionDto;
  source: VideoVersionDto | undefined;
  clipboard: PasteClipboard;
  previewPaste: (input: { sourceAssetId: string; noteIds: readonly string[]; offsetFrames: number }) => Promise<VideoNotePastePreviewResponse>;
  /** Where focus goes when the dialog closes: the ⋯ that opened it, however it closed (Close, Escape, Cancel, Paste). */
  finalFocus?: () => HTMLElement | null;
  commitPaste: (input: { sourceAssetId: string; notes: ReadonlyArray<{ noteId: string; revision: number }>; offsetFrames: number }) => Promise<VideoNotePasteCommitResponse>;
}) {
  const draft = useSyncExternalStore(store.subscribe, () => store.pasteDraft(assetId));
  // The preview follows the offset once it has rested; the field itself is always live.
  const [asked, setAsked] = useState(draft.offset);
  useEffect(() => {
    if (draft.offset === asked) return;
    const timer = setTimeout(() => { setAsked(draft.offset); }, PASTE_PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [draft.offset, asked]);

  // Everything about the plan and the commit is the store's; this only asks (when it opens or the offset rests) and renders.
  const view = useSyncExternalStore(store.subscribe, () => store.pasteView(assetId));
  const op = useSyncExternalStore(store.subscribe, () => store.pasteOp(assetId));
  const pending = op.status === "committing";
  const preview = view.plan;
  const loading = view.status === "loading";
  const loadError = view.status === "failed" ? view.error : null;
  const { notice, failure } = view;
  const noteIdsKey = clipboard.noteIds.join(",");
  const ask = () => { store.requestPreview(assetId, (offsetFrames) => previewPaste({ sourceAssetId: clipboard.sourceAssetId, noteIds: clipboard.noteIds, offsetFrames }), asked); };

  useEffect(() => {
    if (open) ask();
    // `previewPaste` changes identity with the query client only; the plan depends on what is copied, where it goes and the offset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clipboard.sourceAssetId, noteIdsKey, asked, assetId]);

  const mapped = useMemo(() => (preview?.rows ?? []).filter((row): row is Mapped => row.status === "mapped"), [preview]);
  const left = useMemo(() => (preview?.rows ?? []).filter((row): row is Skipped => row.status === "skipped"), [preview]);
  const unticked = useMemo(() => new Set(draft.unticked), [draft.unticked]);
  const chosen = mapped.filter((row) => !unticked.has(row.noteId));
  // With nothing to place there is nothing to shift, so the field goes: but never while it is the way out. An offset that is not 0, or a note
  // left out for falling outside the Version, means the offset may be the cause, and it stays (its value and ticks stay in the store either way).
  const nothingPastable = preview !== null && mapped.length === 0 && draft.offset === 0 && !left.some((row) => row.reason === "out_of_range");
  const settled = preview !== null && view.status === "ok" && preview.offsetFrames === draft.offset;

  const sourceTc = useMemo(() => (source ? timecodeOf(source) : (frame: number) => String(frame)), [source]);
  const targetTc = useMemo(() => timecodeOf(target), [target]);
  const sourceLabel = `v${clipboard.sourceVersion}`;

  function submit() {
    if (!preview || pending || chosen.length === 0) return;
    void store.commitPaste(assetId, () => commitPaste({ sourceAssetId: clipboard.sourceAssetId, notes: chosen.map((row) => ({ noteId: row.noteId, revision: row.source.revision })), offsetFrames: preview.offsetFrames }));
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!pending || next) onOpenChange(next); }}>
    <DialogContent
      data-testid="video-note-paste-dialog"
      showCloseButton={false}
      finalFocus={finalFocus ? () => finalFocus() ?? true : undefined}
      // The dialog is React-nested in the viewer, whose onKeyDown drives the player: keys typed here (arrows on a checkbox, I, O) are not the player's.
      onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
      className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-3)] sm:max-w-2xl"
    >
      <DialogHeader>
        <DialogTitle className="text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{`Paste notes from ${sourceLabel} onto v${target.version}`}</DialogTitle>
        <DialogDescription className="text-foreground-secondary">Each note keeps its text and who can see it. Replies stay behind.</DialogDescription>
      </DialogHeader>

      {!nothingPastable && <NumberField value={draft.offset} onValueChange={(next) => { store.setPasteOffset(assetId, next ?? 0); }} step={1} smallStep={1} largeStep={10} disabled={pending} className="max-w-48">
        <Label htmlFor="video-note-paste-offset" className="text-foreground-secondary">Frame offset</Label>
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label="One frame earlier" />
          <NumberFieldInput id="video-note-paste-offset" data-testid="video-note-paste-offset" />
          <NumberFieldIncrement aria-label="One frame later" />
        </NumberFieldGroup>
      </NumberField>}

      {notice && <Notice tone="caution" role="status" data-testid="video-note-paste-notice">{notice}</Notice>}
      {loadError && <Notice tone="critical" role="alert" data-testid="video-note-paste-load-error" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{loadError}</span><Button type="button" variant="text" onClick={ask}>Try again</Button></Notice>}

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="video-note-paste-body" aria-busy={loading}>
        {preview === null && !loadError && <p role="status" className="m-0 text-foreground-secondary [font:var(--type-label)]">Checking the notes…</p>}
        {preview !== null && mapped.length > 0 && <Table aria-label="Notes to paste" data-testid="video-note-paste-table" data-layout="stack-below-721" className="max-[721px]:block" containerClassName="max-[721px]:overflow-x-visible">
          <TableHeader className="max-[721px]:sr-only">
            <TableRow>
              <TableHead className="w-10"><span className="sr-only">Paste</span></TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="w-px whitespace-nowrap">{`On ${sourceLabel}`}</TableHead>
              <TableHead className="w-px whitespace-nowrap">{`On v${target.version}`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className={cn(!settled && "opacity-60", "max-[721px]:block")}>
            {mapped.map((row) => <TableRow key={row.noteId} data-testid="video-note-paste-row" data-note-id={row.noteId} className="max-[721px]:grid max-[721px]:grid-cols-[auto_auto_1fr] max-[721px]:items-start max-[721px]:gap-x-[var(--space-2)] max-[721px]:py-[var(--space-2)]">
              {/* Coarse pointers get a 44px target: the shared checkbox's own hit area is only 16 + 24 x 16 + 16. */}
              <TableCell className="max-[721px]:row-span-2"><Checkbox aria-label={`Paste note: ${row.source.excerpt}`} data-testid="video-note-paste-tick" className="pointer-coarse:after:-inset-3.5 data-unchecked:border-[var(--control-off)]" checked={!unticked.has(row.noteId)} disabled={pending} onCheckedChange={(checked) => { store.setPasteTicked(assetId, row.noteId, checked); }} /></TableCell>
              <TableCell className="min-w-0 whitespace-normal max-[721px]:col-span-2">
                <span className="line-clamp-2 [overflow-wrap:anywhere]">{row.source.excerpt}</span>
                <span className="mt-[var(--space-1)] flex flex-wrap items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{row.source.authorName}<VisibilityBadge visibility={row.source.visibility} /></span>
              </TableCell>
              <TableCell className={cn(MONO, "max-[721px]:col-start-2 max-[721px]:py-0 max-[721px]:after:ms-[var(--space-2)] max-[721px]:after:content-['→'] max-[721px]:before:content-[attr(data-version)] max-[721px]:before:me-[var(--space-1)] max-[721px]:before:text-foreground-secondary")} data-version={sourceLabel} data-testid="video-note-paste-source">{noteAnchorLabel(row.source.from as { startFrame: number; endFrame: number | null }, sourceTc)}</TableCell>
              <TableCell className={cn(MONO, "max-[721px]:py-0 max-[721px]:before:content-[attr(data-version)] max-[721px]:before:me-[var(--space-1)] max-[721px]:before:text-foreground-secondary")} data-version={`v${target.version}`}>
                <span data-testid="video-note-paste-target">{noteAnchorLabel(row.to, targetTc)}</span>
                {row.shortened && <span className="block text-foreground-secondary [font:var(--type-label)]">Shortened to fit</span>}
              </TableCell>
            </TableRow>)}
          </TableBody>
        </Table>}
        {preview !== null && mapped.length === 0 && <p data-testid="video-note-paste-none" className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">None of the copied notes can be pasted onto this version.</p>}
        {left.length > 0 && <div className="mt-[var(--space-3)] grid gap-[var(--space-1)]">
          <h4 className="m-0 text-foreground-secondary [font:var(--type-label)]">Left out</h4>
          <ul className="m-0 list-none p-0">
            {left.map((row) => <li key={row.noteId} data-testid="video-note-paste-skipped" data-note-id={row.noteId} data-reason={row.reason} className="grid gap-[var(--space-1)] border-b border-border p-2 last:border-b-0">
              <span className="line-clamp-2 [overflow-wrap:anywhere] [font:var(--type-body-sm)]">{row.source?.excerpt || "Deleted note"}</span>
              <span className="text-foreground-secondary [font:var(--type-label)]">{PASTE_SKIP_COPY[row.reason]}</span>
            </li>)}
          </ul>
        </div>}
      </div>

      {failure && <Notice tone="critical" role="alert" data-testid="video-note-paste-error">{failure.text}</Notice>}
      <DialogFooter className="-mx-0 -mb-0 rounded-none border-t border-border bg-transparent p-0 pt-[var(--space-3)]">
        <Button type="button" variant="secondary" data-testid="video-note-paste-cancel" disabled={pending} onClick={() => { onOpenChange(false); }}>Cancel</Button>
        <Button type="button" data-testid="video-note-paste-submit" disabled={pending || !settled || chosen.length === 0} onClick={submit}>
          {pending ? "Pasting…" : failure?.retry ? "Try again" : chosen.length > 0 ? `Paste ${chosen.length} ${chosen.length === 1 ? "note" : "notes"}` : "Paste"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
