import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { VIDEO_NOTE_PASTE_OFFSET_MAX, framesToTimecode, type GuestNotePasteCommitResponse, type GuestNotePasteRow, type GuestNotePastePreviewResponse, type GuestVideoDto } from "@quincy/shared";
import { noteAnchorLabel } from "../lib/video-note-view";
import { cn } from "../lib/utils";
import { Button } from "../components/reui/button";
import { Checkbox } from "../components/reui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/reui/dialog";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../components/reui/item";
import { Label } from "../components/reui/label";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "../components/reui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/reui/select";
import { Notice } from "../components/quincy/Notice";
import type { GuestApi, PasteResult } from "./guest-api";
import { defaultSource, pastableNotes, pasteFailureText, PASTE_SKIP_COPY } from "./guest-paste";
import type { GuestWriter, Skipped as WriterSkipped } from "./use-guest-writer";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const SOURCE_SELECT_ID = "guest-paste-source-select";
const OFFSET_ID = "guest-paste-offset";
/** How long the offset field rests before the preview is asked again (a preview spends one note attempt). */
export const GUEST_PASTE_PREVIEW_DEBOUNCE_MS = 300;

type Version = GuestVideoDto["versions"][number];
type Mapped = Extract<GuestNotePasteRow, { status: "mapped" }>;
type Skipped = Extract<GuestNotePasteRow, { status: "skipped" }>;
/** `sourceId` is the Version the list was read for: a plan is only asked for notes that belong to the source now chosen. */
type Own = { status: "loading" } | { status: "failed" } | { status: "ready"; sourceId: string; ids: string[]; drawn: number; capped: boolean };
type View = { plan: GuestNotePastePreviewResponse | null; status: "idle" | "loading" | "ok" | "failed"; error: string | null };

const timecodeOf = (version: Version) => (frame: number) => framesToTimecode(frame, { nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }, version.startTimecodeFrames ?? 0);

/**
 * Copy the guest's own notes from another granted Version of this Video onto the one on screen (#741 13d). It is the guest twin of the staff paste dialog (`VideoNotePasteDialog`), which is bound
 * to the staff form store and `lib/api` and so cannot be imported here (`guest-boundary.guard.test.ts`): the same flow (choose the source, a frame offset, a plan with a tick per note and the
 * notes left out with the reason, then commit the ticked ones with the revisions shown), built from the installed `dialog`, `select`, `number-field`, `item` and `checkbox`.
 *
 * - The notes asked for are the guest's own roots on the source Version (read from the notes list); the server still decides, and says `not_author` for anything else.
 * - Every call goes through the `GuestApp`-owned writer, so a verification lost, a link gone or an archive reaches the page, and an answer that arrives after the Version changed is dropped there.
 *   The dialog adds a generation: closing, or the Version changing, moves it on, and a completion that started under an earlier one changes nothing.
 * - The commit is idempotent on the server, so after a dropped connection the guest may press Paste again; the list is read again meanwhile.
 */
export function GuestPasteDialog({ api, writer, open, onOpenChange, video, target, markupAllowed, onPasted, onGone }: {
  api: GuestApi;
  writer: GuestWriter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  video: GuestVideoDto;
  /** The Version on screen: the notes are pasted onto it. */
  target: Version;
  markupAllowed: boolean;
  /** A commit landed (`copied` notes from `sourceVersion`), or may have (null: the connection dropped, so read the list again). */
  onPasted: (landed: { copied: number; sourceVersion: number } | null) => void;
  onGone: () => void;
}) {
  const generation = useRef(0);
  const committing = useRef(false);
  useEffect(() => { if (!open) generation.current += 1; }, [open]);
  // A different Version on screen is a different paste: whatever was started for the earlier one is dropped when it settles.
  const shownTarget = useRef(target.assetId);
  if (shownTarget.current !== target.assetId) { shownTarget.current = target.assetId; generation.current += 1; }
  // Each opening gets its own flow, whether or not the previous one has finished its exit animation.
  const [opening, setOpening] = useState(0);
  const wasOpen = useRef(open);
  if (open && !wasOpen.current) setOpening((n) => n + 1);
  wasOpen.current = open;
  return <Dialog open={open} onOpenChange={(next) => { if (!committing.current || next) onOpenChange(next); }}>
    <DialogContent data-testid="guest-paste-dialog" showCloseButton={false} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-3)] sm:max-w-xl">
      <PasteFlow key={opening} api={api} writer={writer} video={video} target={target} markupAllowed={markupAllowed} generation={generation} committing={committing} onClose={() => { onOpenChange(false); }} onPasted={onPasted} onGone={onGone} />
    </DialogContent>
  </Dialog>;
}

function PasteFlow({ api, writer, video, target, markupAllowed, generation, committing, onClose, onPasted, onGone }: {
  api: GuestApi; writer: GuestWriter; video: GuestVideoDto; target: Version; markupAllowed: boolean;
  generation: MutableRefObject<number>; committing: MutableRefObject<boolean>;
  onClose: () => void; onPasted: (landed: { copied: number; sourceVersion: number } | null) => void; onGone: () => void;
}) {
  const others = useMemo(() => video.versions.filter((candidate) => candidate.assetId !== target.assetId), [video, target.assetId]);
  const [sourceId, setSourceId] = useState(() => defaultSource(video.versions, target)?.assetId ?? "");
  const source = others.find((candidate) => candidate.assetId === sourceId) ?? others[0];
  const [own, setOwn] = useState<Own>({ status: "loading" });
  const [ownAttempt, setOwnAttempt] = useState(0);
  const [offset, setOffset] = useState(0);
  const [asked, setAsked] = useState(0);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [view, setView] = useState<View>({ plan: null, status: "idle", error: null });
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Moves on with every plan asked for, so only the newest answer is applied. */
  const planSeq = useRef(0);

  // The offset field is always live; the plan follows it once it has rested.
  useEffect(() => {
    if (offset === asked) return;
    const timer = setTimeout(() => { setAsked(offset); }, GUEST_PASTE_PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [offset, asked]);

  // The guest's own notes on the source Version.
  useEffect(() => {
    if (source === undefined) return;
    const started = generation.current;
    let live = true;
    setOwn({ status: "loading" }); setView({ plan: null, status: "idle", error: null }); setUnticked(new Set()); setNotice(null); setFailure(null);
    void api.notes(source.assetId).then((result) => {
      if (!live || generation.current !== started) return;
      if (result.kind === "gone") { onGone(); return; }
      setOwn(result.kind === "ok" ? { status: "ready", sourceId: source.assetId, ...pastableNotes(result.value, markupAllowed) } : { status: "failed" });
    });
    return () => { live = false; };
  }, [api, source?.assetId, ownAttempt, markupAllowed, generation, onGone]); // eslint-disable-line react-hooks/exhaustive-deps -- `source` is read through its id

  // The plan for those notes at the offset that has rested. Nothing is written.
  const ids = own.status === "ready" && own.sourceId === source?.assetId ? own.ids : null;
  const idsKey = ids?.join(",") ?? null;
  useEffect(() => {
    if (ids === null || ids.length === 0 || source === undefined) return;
    const started = generation.current;
    const mine = ++planSeq.current;
    setView((current) => ({ ...current, status: "loading", error: null }));
    void writer.run(`paste-preview:${target.assetId}:${mine}`, () => api.previewPaste(target.assetId, { sourceAssetId: source.assetId, noteIds: ids, offsetFrames: asked })).then((result) => {
      if (generation.current !== started || planSeq.current !== mine) return;
      if (result.kind === "stale" || result.kind === "busy") return;
      if (result.kind === "ok" || result.kind === "changed") { setView({ plan: result.kind === "ok" ? result.value : result.preview, status: "ok", error: null }); return; }
      const text = pasteFailureText(result, "preview");
      if (text === null) { onClose(); return; } // verification lost, link gone or archived: the page has already been told
      setView((current) => ({ ...current, status: "failed", error: text }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the plan depends on which notes, from where, to where and the offset
  }, [idsKey, asked, source?.assetId, target.assetId, previewAttempt]);

  const plan = view.plan;
  const mapped = useMemo(() => (plan?.rows ?? []).filter((row): row is Mapped => row.status === "mapped"), [plan]);
  const left = useMemo(() => (plan?.rows ?? []).filter((row): row is Skipped => row.status === "skipped"), [plan]);
  const chosen = mapped.filter((row) => !unticked.has(row.noteId));
  const settled = plan !== null && view.status === "ok" && plan.offsetFrames === offset;
  const sourceTc = useMemo(() => (source ? timecodeOf(source) : (frame: number) => String(frame)), [source]);
  const targetTc = useMemo(() => timecodeOf(target), [target]);
  const sourceLabel = source ? `v${source.version}` : "";

  async function submit() {
    if (plan === null || source === undefined || pending || chosen.length === 0 || !settled) return;
    const started = generation.current;
    setPending(true); committing.current = true; setFailure(null); setNotice(null);
    let result: PasteResult<GuestNotePasteCommitResponse> | WriterSkipped<PasteResult<GuestNotePasteCommitResponse>>;
    try {
      result = await writer.run(`paste-commit:${target.assetId}`, () => api.commitPaste(target.assetId, { sourceAssetId: source.assetId, notes: chosen.map((row) => ({ noteId: row.noteId, revision: row.source.revision })), offsetFrames: plan.offsetFrames }));
    } finally { committing.current = false; }
    // The Version changed (or the dialog went) while it was out: the screen now on show is not this paste's.
    if (generation.current !== started) return;
    if ("result" in result) return; // `stale`: the writer saw the screen move on
    setPending(false);
    switch (result.kind) {
      case "busy": setFailure("Still pasting. Wait a moment, then try again."); return;
      case "ok": onPasted({ copied: result.value.copied, sourceVersion: result.value.sourceVersion }); onClose(); return;
      case "changed": setView({ plan: result.preview, status: "ok", error: null }); setNotice("Some of your notes changed since you looked. Check the list, then paste again."); return;
      case "unverified": case "gone": case "archived": onClose(); return;
      case "unreachable": onPasted(null); setFailure(pasteFailureText(result, "commit")); return;
      default: setFailure(pasteFailureText(result, "commit"));
    }
  }

  const empty = own.status === "ready" && own.ids.length === 0;
  const loading = own.status === "loading" || view.status === "loading";
  return <>
    <DialogHeader>
      <DialogTitle className="text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{`Copy my notes onto v${target.version}`}</DialogTitle>
      <DialogDescription className="text-foreground-secondary">Your notes keep their text. Replies stay behind.</DialogDescription>
    </DialogHeader>

    <div className="flex flex-wrap items-end gap-[var(--space-3)]">
      <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
        <Label htmlFor={SOURCE_SELECT_ID} className="text-foreground-secondary">Copy from</Label>
        <Select value={sourceId} onValueChange={(next) => { if (typeof next === "string") setSourceId(next); }} disabled={pending}>
          <SelectTrigger id={SOURCE_SELECT_ID} data-testid="guest-paste-source" className={cn(TOUCH, "min-w-32")}>
            <SelectValue>{() => <span className="block truncate">{sourceLabel}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {others.map((candidate) => <SelectItem key={candidate.assetId} value={candidate.assetId} className={TOUCH}>{`v${candidate.version}`}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {!empty && <NumberField value={offset} onValueChange={(next) => { setOffset(next ?? 0); }} min={-VIDEO_NOTE_PASTE_OFFSET_MAX} max={VIDEO_NOTE_PASTE_OFFSET_MAX} step={1} smallStep={1} largeStep={10} disabled={pending} className="max-w-48">
        <Label htmlFor={OFFSET_ID} className="text-foreground-secondary">Frame offset</Label>
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label="One frame earlier" className={TOUCH} />
          <NumberFieldInput id={OFFSET_ID} data-testid="guest-paste-offset" className={TOUCH} />
          <NumberFieldIncrement aria-label="One frame later" className={TOUCH} />
        </NumberFieldGroup>
      </NumberField>}
    </div>

    {notice && <Notice tone="caution" role="status" data-testid="guest-paste-notice">{notice}</Notice>}
    {own.status === "failed" && <Notice tone="critical" role="alert" data-testid="guest-paste-load-error" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>Couldn't reach Quincy. Check your connection and try again.</span><Button type="button" variant="ghost" className={TOUCH} onClick={() => { setOwnAttempt((n) => n + 1); }}>Try again</Button></Notice>}
    {view.status === "failed" && <Notice tone="critical" role="alert" data-testid="guest-paste-load-error" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{view.error}</span><Button type="button" variant="ghost" className={TOUCH} onClick={() => { setPreviewAttempt((n) => n + 1); }}>Try again</Button></Notice>}

    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="guest-paste-body" aria-busy={loading}>
      {own.status === "loading" && <p role="status" className="m-0 text-foreground-secondary [font:var(--type-label)]">Looking for your notes…</p>}
      {empty && <p data-testid="guest-paste-none" className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">{`You have no notes on ${sourceLabel} that can be copied.`}</p>}
      {own.status === "ready" && own.drawn > 0 && <p data-testid="guest-paste-drawn" className="m-0 mt-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{`${own.drawn} ${own.drawn === 1 ? "note with a drawing" : "notes with drawings"} can't be copied on this link.`}</p>}
      {own.status === "ready" && own.capped && <p className="m-0 mt-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">Only the first 60 of your notes are shown.</p>}
      {plan !== null && mapped.length > 0 && <ItemGroup aria-label="Notes to copy" className={cn("gap-[var(--space-2)]", !settled && "opacity-60")}>
        {mapped.map((row) => <Item key={row.noteId} variant="outline" size="xs" data-testid="guest-paste-row" data-note-id={row.noteId} className={cn(TOUCH, "flex-nowrap items-start")}>
          <Checkbox aria-label={`Copy note: ${row.source.excerpt}`} data-testid="guest-paste-tick" className="mt-0.5 pointer-coarse:after:-inset-3.5 max-[721px]:after:-inset-3.5 data-unchecked:border-[var(--control-off)]" checked={!unticked.has(row.noteId)} disabled={pending}
            onCheckedChange={(checked) => { setUnticked((current) => { const next = new Set(current); if (checked) next.delete(row.noteId); else next.add(row.noteId); return next; }); }} />
          <ItemContent>
            <ItemTitle className="line-clamp-3 w-full [overflow-wrap:anywhere]">{row.source.excerpt}</ItemTitle>
            <ItemDescription className="[font:var(--type-mono)] tabular-nums">{`${sourceLabel} ${noteAnchorLabel(row.source.from as { startFrame: number; endFrame: number | null }, sourceTc)} → v${target.version} ${noteAnchorLabel(row.to, targetTc)}`}</ItemDescription>
            {row.shortened && <ItemDescription>Shortened to fit</ItemDescription>}
          </ItemContent>
        </Item>)}
      </ItemGroup>}
      {plan !== null && mapped.length === 0 && <p data-testid="guest-paste-none" className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">None of your notes can be copied onto this version.</p>}
      {left.length > 0 && <div className="mt-[var(--space-3)] grid gap-[var(--space-1)]">
        <h4 className="m-0 text-foreground-secondary [font:var(--type-label)]">Left out</h4>
        <ul className="m-0 list-none p-0">
          {left.map((row) => <li key={row.noteId} data-testid="guest-paste-skipped" data-note-id={row.noteId} data-reason={row.reason} className="grid gap-[var(--space-1)] border-b border-border p-2 last:border-b-0">
            {row.source !== null && <span className="line-clamp-2 [overflow-wrap:anywhere] [font:var(--type-body-sm)]">{row.source.excerpt || "Deleted note"}</span>}
            <span className="text-foreground-secondary [font:var(--type-label)]">{PASTE_SKIP_COPY[row.reason]}</span>
          </li>)}
        </ul>
      </div>}
    </div>

    {failure && <Notice tone="critical" role="alert" data-testid="guest-paste-error">{failure}</Notice>}
    <DialogFooter className="-mx-0 -mb-0 rounded-none border-t border-border bg-transparent p-0 pt-[var(--space-3)]">
      <Button type="button" variant="outline" data-testid="guest-paste-cancel" className={TOUCH} disabled={pending} onClick={onClose}>Cancel</Button>
      <Button type="button" data-testid="guest-paste-submit" className={TOUCH} disabled={pending || !settled || chosen.length === 0} onClick={() => { void submit(); }}>
        {pending ? "Pasting…" : chosen.length > 0 ? `Paste ${chosen.length} ${chosen.length === 1 ? "note" : "notes"}` : "Paste"}
      </Button>
    </DialogFooter>
  </>;
}
