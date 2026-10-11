import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { GUEST_NOTE_PASTE_MAX, VIDEO_NOTE_PASTE_OFFSET_MAX, framesToTimecode, type GuestNotePasteCommitResponse, type GuestNotePasteRow, type GuestNotePastePreviewResponse, type GuestVideoDto } from "@quincy/shared";
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
import { DIALOG_TITLE } from "../components/video/ReviewLinkDialogFrame";
import type { GuestApi, PasteResult } from "./guest-api";
import { defaultSource, pastableNotes, type PastableNote, pasteFailureText, PASTE_SKIP_COPY } from "./guest-paste";
import type { GuestWriter, Skipped as WriterSkipped } from "./use-guest-writer";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const SOURCE_SELECT_ID = "guest-paste-source-select";
const OFFSET_ID = "guest-paste-offset";
/** How long the offset field rests before the preview is asked again (a preview spends one note attempt). */
export const GUEST_PASTE_PREVIEW_DEBOUNCE_MS = 300;

/** Skip reasons that depend on the frame offset (the other reasons in `VIDEO_NOTE_PASTE_SKIP_REASONS`, `already_copied`, `deleted` and `reply`, do not). */
const OFFSET_DEPENDENT: ReadonlySet<string> = new Set(["out_of_range", "drawing_outside"]);

type Version = GuestVideoDto["versions"][number];
type Mapped = Extract<GuestNotePasteRow, { status: "mapped" }>;
type Entry = { id: string; mapped: Mapped | null; note: PastableNote | null };
type Skipped = Extract<GuestNotePasteRow, { status: "skipped" }>;
/** `sourceId` is the Version the list was read for: a plan is only asked for notes that belong to the source now chosen. */
type Own = { status: "loading" } | { status: "failed" } | { status: "ready"; sourceId: string; ids: string[]; items: PastableNote[]; drawn: number };
/** `key` is the `{source, target}` pair the plan was made for: a plan is only used while the pair on screen is the same. */
type View = { plan: GuestNotePastePreviewResponse | null; status: "idle" | "loading" | "ok" | "failed"; error: string | null; key: string | null; ids: string | null };

/** Whether a plan whose real membership is `planIds` answers for every note that is ticked (an unticked one is not asked for, so its absence is no gap). */
const covered = (planIds: string | null, ticked: readonly string[], unticked: ReadonlySet<string>): boolean => {
  const inPlan = new Set(planIds === null ? [] : planIds.split(","));
  return ticked.every((id) => unticked.has(id) || inPlan.has(id));
};

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
    <DialogContent data-testid="guest-paste-dialog" showCloseButton={false} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-3)] sm:max-w-3xl">
      <PasteFlow key={opening} opening={opening} api={api} writer={writer} video={video} target={target} markupAllowed={markupAllowed} generation={generation} committing={committing} onClose={() => { onOpenChange(false); }} onPasted={onPasted} onGone={onGone} />
    </DialogContent>
  </Dialog>;
}

function PasteFlow({ opening, api, writer, video, target, markupAllowed, generation, committing, onClose, onPasted, onGone }: {
  /** Which opening of the dialog this flow is: the writer outlives the flow, so a preview key must say which opening asked. */
  opening: number; api: GuestApi; writer: GuestWriter; video: GuestVideoDto; target: Version; markupAllowed: boolean;
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
  /** The ticked notes the plan is being asked for, once the ticking has rested (the first list is asked for at once). */
  const [askedNotes, setAskedNotes] = useState<{ sourceId: string; key: string } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [view, setView] = useState<View>({ plan: null, status: "idle", error: null, key: null, ids: null });
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  /** Notes a plan has reported as skipped (any reason), by id: they have no tick, so past the cap they neither count toward it nor go in the commit. A later plan's mapped row takes a note back out. */
  const [leftOut, setLeftOut] = useState<ReadonlyMap<string, Skipped>>(() => new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Names each preview call to the writer, so two in flight never share a key. */
  const previewCalls = useRef(0);
  /** How many times in a row the writer answered `busy` for a preview (it should not, since each key is its own). */
  const busyRetries = useRef(0);
  const learn = (rows: GuestNotePastePreviewResponse["rows"]) => setLeftOut((current) => {
    const next = new Map(current);
    for (const row of rows) { if (row.status === "skipped") next.set(row.noteId, row); else next.delete(row.noteId); }
    return next;
  });
  const pairKey = `${source?.assetId ?? ""}|${target.assetId}`;

  // The offset field is always live; the plan follows it once it has rested.
  useEffect(() => {
    if (offset === asked) return;
    // A note left out for where it lands (out of range, drawing outside) may fit at the new offset, so it is asked about again; the offset-independent reasons stay left out.
    const timer = setTimeout(() => { setAsked(offset); setLeftOut((current) => { const next = new Map(current); for (const [id, row] of current) if (OFFSET_DEPENDENT.has(row.reason)) next.delete(id); return next; }); }, GUEST_PASTE_PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [offset, asked]);

  // The guest's own notes on the source Version.
  useEffect(() => {
    if (source === undefined) return;
    const started = generation.current;
    let live = true;
    setOwn({ status: "loading" }); setAskedNotes(null); setView({ plan: null, status: "idle", error: null, key: null, ids: null }); setUnticked(new Set()); setLeftOut(new Map()); setNotice(null); setFailure(null);
    void api.notes(source.assetId).then((result) => {
      if (!live || generation.current !== started) return;
      if (result.kind === "gone") { onGone(); return; }
      if (result.kind !== "ok") { setOwn({ status: "failed" }); return; }
      const found = pastableNotes(result.value, markupAllowed);
      // One request carries at most GUEST_NOTE_PASTE_MAX notes: with more than that, the first ones are ticked and the rest wait for the guest.
      setUnticked(new Set(found.ids.slice(GUEST_NOTE_PASTE_MAX)));
      setOwn({ status: "ready", sourceId: source.assetId, ...found });
    });
    return () => { live = false; };
  }, [api, source?.assetId, ownAttempt, markupAllowed, generation, onGone]); // eslint-disable-line react-hooks/exhaustive-deps -- `source` is read through its id

  // Which notes the plan is for: all of them, or (with more than one request can carry) the ticked ones. More than the cap ticked is a state with no plan: Paste waits for the guest.
  const ids = own.status === "ready" && own.sourceId === source?.assetId ? own.ids : null;
  const overflow = ids !== null && ids.length > GUEST_NOTE_PASTE_MAX;
  const tickedIds = ids === null ? [] : overflow ? ids.filter((id) => !unticked.has(id) && !leftOut.has(id)) : ids;
  const overLimit = tickedIds.length > GUEST_NOTE_PASTE_MAX;
  const previewKey = ids === null || tickedIds.length === 0 || overLimit ? null : tickedIds.join(",");
  useEffect(() => {
    if (previewKey === null || source === undefined) return;
    if (askedNotes === null || askedNotes.sourceId !== source.assetId) { setAskedNotes({ sourceId: source.assetId, key: previewKey }); return; }
    if (askedNotes.key === previewKey) return;
    const timer = setTimeout(() => { setAskedNotes({ sourceId: source.assetId, key: previewKey }); }, GUEST_PASTE_PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [previewKey, askedNotes, source]);

  // The plan for those notes at the offset that has rested. Nothing is written.
  const askedKey = ids !== null && askedNotes !== null && askedNotes.sourceId === source?.assetId ? askedNotes.key : null;
  useEffect(() => {
    if (askedKey === null || source === undefined) return;
    const noteIds = askedKey.split(",");
    const started = generation.current;
    const key = `${source.assetId}|${target.assetId}`;
    const call = ++previewCalls.current;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setView((current) => ({ ...current, status: "loading", error: null }));
    void writer.run(`paste-preview:${target.assetId}:${opening}:${call}`, () => api.previewPaste(target.assetId, { sourceAssetId: source.assetId, noteIds, offsetFrames: asked }), () => live && generation.current === started).then((result) => {
      if (!live || generation.current !== started) return;
      if (result.kind === "stale") return;
      if (result.kind === "busy") {
        // Another request holds the key: ask again shortly rather than stay loading for ever.
        if (busyRetries.current < 3) { busyRetries.current += 1; retry = setTimeout(() => { setPreviewAttempt((n) => n + 1); }, GUEST_PASTE_PREVIEW_DEBOUNCE_MS); return; }
        busyRetries.current = 0; setView((current) => ({ ...current, status: "failed", error: "Couldn't load the preview. Try again." })); return;
      }
      busyRetries.current = 0;
      if (result.kind === "ok" || result.kind === "changed") { learn(result.kind === "ok" ? result.value.rows : result.preview.rows); setView({ plan: result.kind === "ok" ? result.value : result.preview, status: "ok", error: null, key, ids: result.kind === "ok" ? askedKey : result.preview.rows.map((row) => row.noteId).join(",") }); return; }
      const text = pasteFailureText(result, "preview");
      if (text === null) { onClose(); return; } // verification lost, link gone or archived: the page has already been told
      setView((current) => ({ ...current, status: "failed", error: text }));
    });
    // Whatever changes the question (notes, source, target, offset, a retry) or closes the flow makes this answer a stale one.
    return () => { live = false; clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the plan depends on which notes, from where, to where and the offset
  }, [askedKey, asked, source?.assetId, target.assetId, previewAttempt]);

  const plan = view.key === pairKey ? view.plan : null;
  const mapped = useMemo(() => (plan?.rows ?? []).filter((row): row is Mapped => row.status === "mapped"), [plan]);
  // The notes left out include those an earlier plan left out and the plan on show no longer asks about.
  const left = useMemo(() => {
    const inPlan = new Set((plan?.rows ?? []).map((row) => row.noteId));
    return [...(plan?.rows ?? []).filter((row): row is Skipped => row.status === "skipped"), ...(plan === null ? [] : [...leftOut.values()].filter((row) => !inPlan.has(row.noteId)))];
  }, [plan, leftOut]);
  const chosen = mapped.filter((row) => !unticked.has(row.noteId) && !leftOut.has(row.noteId));
  const settled = plan !== null && view.status === "ok" && plan.offsetFrames === offset && previewKey !== null && covered(view.ids, tickedIds, unticked);
  // The rows follow the guest's own order. Every own note that is not left out is a row, ticked or not and covered by the plan or not (one the plan does not cover has no target position yet), so it can always be unticked; one the plan left out is under "Left out".
  const rows = useMemo(() => {
    if (plan === null) return [] as Entry[];
    const byId = new Map(mapped.map((row) => [row.noteId, row]));
    const inPlan = new Set(plan.rows.map((row) => row.noteId));
    const items = own.status === "ready" ? own.items : [];
    const ordered = items.flatMap((note): Entry[] => { const row = byId.get(note.id); return row ? [{ id: note.id, mapped: row, note }] : !inPlan.has(note.id) && !leftOut.has(note.id) ? [{ id: note.id, mapped: null, note }] : []; });
    const known = new Set(items.map((note) => note.id));
    return [...ordered, ...mapped.filter((row) => !known.has(row.noteId)).map((row): Entry => ({ id: row.noteId, mapped: row, note: null }))];
  }, [plan, mapped, own, leftOut]);
  const sourceTc = useMemo(() => (source ? timecodeOf(source) : (frame: number) => String(frame)), [source]);
  const targetTc = useMemo(() => timecodeOf(target), [target]);
  const sourceLabel = source ? `v${source.version}` : "";

  async function submit() {
    if (plan === null || source === undefined || pending || overLimit || chosen.length === 0 || !settled) return;
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
      case "changed": learn(result.preview.rows); setView({ plan: result.preview, status: "ok", error: null, key: pairKey, ids: result.preview.rows.map((row) => row.noteId).join(",") }); setNotice("Some of your notes changed since you looked. Check the list, then paste again."); return;
      case "unverified": case "gone": case "archived": onClose(); return;
      case "unreachable": onPasted(null); setFailure(pasteFailureText(result, "commit")); return;
      default: setFailure(pasteFailureText(result, "commit"));
    }
  }

  const empty = own.status === "ready" && own.ids.length === 0;
  const loading = own.status === "loading" || view.status === "loading";
  return <>
    <DialogHeader>
      <DialogTitle className={DIALOG_TITLE}>{`Copy my notes onto v${target.version}`}</DialogTitle>
      <DialogDescription className="text-foreground-secondary">Your notes keep their text. Replies stay behind.</DialogDescription>
    </DialogHeader>

    <div className="flex flex-wrap items-start gap-[var(--space-3)]">
      <div className="flex min-w-0 flex-col gap-[var(--space-2)]">
        <Label htmlFor={SOURCE_SELECT_ID} className="text-foreground-secondary">Copy from</Label>
        <Select value={sourceId} onValueChange={(next) => { if (typeof next === "string") setSourceId(next); }} disabled={pending}>
          <SelectTrigger id={SOURCE_SELECT_ID} data-testid="guest-paste-source" className={cn(TOUCH, "min-w-32 data-[size=default]:h-[38px]")}>
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
      {overLimit && <p role="status" data-testid="guest-paste-limit" className="m-0 mt-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{`Copy up to ${GUEST_NOTE_PASTE_MAX} notes at a time. Untick some to continue.`}</p>}
      {plan !== null && rows.length > 0 && <ItemGroup aria-label="Notes to copy" className={cn("gap-[var(--space-2)]", !settled && "opacity-60")}>
        {rows.map(({ id, mapped: row, note }) => <Item key={id} variant="outline" size="xs" data-testid="guest-paste-row" data-note-id={id} className={cn(TOUCH, "flex-nowrap items-start")}>
          <Checkbox aria-label={`Copy note: ${row?.source.excerpt ?? note?.excerpt ?? ""}`} data-testid="guest-paste-tick" className="mt-0.5 pointer-coarse:after:-inset-[15px] max-[721px]:after:-inset-[15px] data-unchecked:border-[var(--control-off)]" checked={!unticked.has(id)} disabled={pending}
            onCheckedChange={(checked) => {
              // A tick on a note the plan on show never covered (a stale answer left it out) needs a plan of its own; past the cap the changed selection asks for it.
              if (checked && !overflow && !covered(view.ids, [id], new Set())) setPreviewAttempt((n) => n + 1);
              setUnticked((current) => { const next = new Set(current); if (checked) next.delete(id); else next.add(id); return next; }); }} />
          <ItemContent className={cn(unticked.has(id) && "text-foreground-secondary")}>
            <ItemTitle className="line-clamp-3 w-full [overflow-wrap:anywhere]">{row?.source.excerpt ?? note?.excerpt}</ItemTitle>
            <ItemDescription className="[font:var(--type-mono)] tabular-nums">{row ? `${sourceLabel} ${noteAnchorLabel(row.source.from as { startFrame: number; endFrame: number | null }, sourceTc)} → v${target.version} ${noteAnchorLabel(row.to, targetTc)}` : `${sourceLabel} ${noteAnchorLabel(note!, sourceTc)}`}</ItemDescription>
            {row?.shortened && <ItemDescription>Shortened to fit</ItemDescription>}
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
      <Button type="button" data-testid="guest-paste-submit" className={TOUCH} disabled={pending || overLimit || !settled || chosen.length === 0} onClick={() => { void submit(); }}>
        {pending ? "Pasting…" : chosen.length > 0 ? `Paste ${chosen.length} ${chosen.length === 1 ? "note" : "notes"}` : "Paste"}
      </Button>
    </DialogFooter>
  </>;
}
