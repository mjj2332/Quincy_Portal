import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { DELIVERY_ZIP_MAX_BYTES, DELIVERY_ZIP_MAX_PHOTOS, type DeliveryZipManifest, type DeliveryZipSize } from "@quincy/shared";
import { Notice } from "../components/quincy/Notice";
import { PREPARE_FAILED_COPY, PREPARING_COPY } from "../components/PreparedZipNotice";
import { Button } from "../components/reui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/reui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "../components/reui/field";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../components/reui/item";
import { RadioGroup, RadioGroupItem } from "../components/reui/radio-group";
import { Spinner } from "../components/reui/spinner";
import { formatBytes } from "../guest/guest-format";
import { ZipListScroll } from "../guest/ZipListScroll";
import { NOTICE_SPINNER, PREPARE_TIMEOUT_COPY, READY_HINT_COPY, usePreparedDownload, type PrepareOutcome } from "../lib/use-prepared-download";
import type { DeliveryApi } from "./delivery-api";
import { TOUCH } from "./UnlockControl";

const PROBLEM = "m-0 text-foreground-secondary [font:var(--type-body-sm)]";
const HEADING = "m-0 text-foreground [font:var(--type-label)]";
const SIZES: ReadonlyArray<{ size: DeliveryZipSize; title: string; hint: string }> = [
  { size: "web", title: "Web-size", hint: "Smaller JPEGs for websites and social media" },
  { size: "full", title: "Full-res", hint: "Original files for print" },
];
const TOO_BIG_COPY = `This is more than one zip can hold (${DELIVERY_ZIP_MAX_PHOTOS} photos or ${formatBytes(DELIVERY_ZIP_MAX_BYTES)}). Download the photos one at a time instead.`;
const waitCopy = (seconds: number) => `Too many requests. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;

type Loaded = { kind: "loading" } | { kind: "failed" } | { kind: "limited"; seconds: number } | { kind: "ok"; manifest: DeliveryZipManifest };

/**
 * Download all photos on the public Client Delivery page (#787 slice 7). Opening the dialog reads the manifest for the chosen size (Web-size to start) so the person sees what the zip holds and what is left out
 * (locked premium photos, by public label) before anything is requested. Its action is a plain anchor to the zip route, so the browser streams the archive to disk; it never downloads by itself.
 * A large archive may still be preparing: the dialog then asks the server to prepare it (one POST), polls the manifest while it is open and the page visible, and offers "Download zip" once ready (`usePreparedDownload`).
 * Every answer is bound to the dialog's opening AND the size it was asked for: the panel below is keyed by both, so an answer that lands after Close, a reopening or a size switch belongs to a panel that no longer exists
 * and changes nothing (lesson "Form lifetime is not component lifetime"). A 404 means the page is gone (`onGone`).
 */
export function DeliveryDownloadAll({ api, onGone }: { api: Pick<DeliveryApi, "zipManifest" | "prepareZip" | "zipUrl">; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<DeliveryZipSize>("web");
  const [opening, setOpening] = useState(0);
  const close = useCallback(() => { setOpen(false); }, []);
  const gone = useCallback(() => { setOpen(false); onGone(); }, [onGone]);
  return <>
    <Button type="button" variant="default" size="lg" data-testid="delivery-download-all" className={TOUCH} onClick={() => { setSize("web"); setOpening((n) => n + 1); setOpen(true); }}><DownloadIcon aria-hidden="true" />Download all</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      {/* #907: below 520px of height (the same threshold as `POPUP_SHORT_QUERY`) the pinned header, radios and footer left the zip body ~3px. There the dialog itself is the one scroller and the
          body stops scrolling (`flex-none`), never a scroller nested in a shrinking window (lesson "A nested scroller taller than its host's window traps the wheel (#686)").
          Its native scrollbar is hidden: it would run through the sticky footer and the rounded corner (#882 keeps the bar inset), and the content cut at the footer already shows there is more. The footer stays pinned by `sticky`, opaque: `bg-muted/50` composited over `bg-popover`. Its `bottom` is minus the dialog's padding (`p-4`, `--space-4`): the sticky
          rectangle is the scroller less its padding, so `bottom-0` left a 16px band of scrolling content under the footer. At 520px and taller nothing changes. */}
      <DialogContent data-testid="delivery-download-all-dialog" showCloseButton={false} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col sm:max-w-[520px] [@media(height<520px)]:overflow-y-auto [@media(height<520px)]:overscroll-contain [@media(height<520px)]:[scrollbar-width:none]">
        <DialogHeader data-testid="delivery-zip-header" className="shrink-0">
          <DialogTitle>Download all photos</DialogTitle>
          <DialogDescription>One zip with every photo on this page that is unlocked.</DialogDescription>
        </DialogHeader>
        <RadioGroup value={size} onValueChange={(next) => { if (next === "web" || next === "full") setSize(next); }} aria-label="Photo size" data-testid="delivery-zip-sizes" className="shrink-0">
          {SIZES.map((choice) => <FieldLabel key={choice.size} htmlFor={`delivery-zip-size-${choice.size}`} className={`${TOUCH} has-data-checked:bg-[var(--bg-raised)]!`}>
            <Field orientation="horizontal">
              <FieldContent><FieldTitle className="text-foreground">{choice.title}</FieldTitle><FieldDescription className="normal-case tracking-[var(--tracking-normal)] [font:var(--type-body-sm)] text-foreground-secondary">{choice.hint}</FieldDescription></FieldContent>
              <RadioGroupItem value={choice.size} id={`delivery-zip-size-${choice.size}`} data-testid={`delivery-zip-size-${choice.size}`} />
            </Field>
          </FieldLabel>)}
        </RadioGroup>
        {open && <ZipPanel key={`${opening}:${size}`} api={api} size={size} onClose={close} onGone={gone} />}
      </DialogContent>
    </Dialog>
  </>;
}

/** One size's reading of one opening: the manifest, the preparing wait, the list and the footer. It is remounted for every opening and size, so nothing it started can land on another. */
function ZipPanel({ api, size, onClose, onGone }: { api: Pick<DeliveryApi, "zipManifest" | "prepareZip" | "zipUrl">; size: DeliveryZipSize; onClose: () => void; onGone: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [prepareWait, setPrepareWait] = useState<number | null>(null);
  // A polled manifest that answered 429: the cooldown is shown and no poll asks again until Retry-After has passed.
  const [pollWait, setPollWait] = useState<number | null>(null);
  const cooldownUntil = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const goneRef = useRef(onGone); goneRef.current = onGone;
  const check = useCallback(async (reason: "start" | "poll"): Promise<PrepareOutcome> => {
    if (reason === "start") {
      setPrepareWait(null);
      const result = await api.prepareZip(size);
      if (!alive.current) return { state: "failed" };
      if (result.kind === "ok") return { state: result.value.state };
      if (result.kind === "tooLarge") return { state: "too_large" };
      if (result.kind === "gone") goneRef.current();
      if (result.kind === "limited") setPrepareWait(result.retryAfterSeconds);
      return { state: "failed" };
    }
    if (Date.now() < cooldownUntil.current) return { state: "preparing" };
    const result = await api.zipManifest(size);
    if (!alive.current) return { state: "failed" };
    if (result.kind === "limited") { cooldownUntil.current = Date.now() + result.retryAfterSeconds * 1000; setPollWait(result.retryAfterSeconds); return { state: "preparing" }; }
    if (result.kind === "ok") { cooldownUntil.current = 0; setPollWait(null); setLoaded({ kind: "ok", manifest: result.manifest }); return { state: result.manifest.archive.state }; }
    if (result.kind === "gone") goneRef.current();
    return { state: "failed" };
  }, [api, size]);
  const prepared = usePreparedDownload({ check, active: true });
  const startPrepared = prepared.start;
  const load = useCallback(() => {
    setLoaded({ kind: "loading" });
    void api.zipManifest(size).then((result) => {
      if (!alive.current) return;
      if (result.kind === "gone") goneRef.current();
      else if (result.kind === "limited") setLoaded({ kind: "limited", seconds: result.retryAfterSeconds });
      else if (result.kind === "ok") setLoaded({ kind: "ok", manifest: result.manifest });
      else setLoaded({ kind: "failed" });
    });
  }, [api, size]);
  useEffect(() => { load(); }, [load]);
  // A manifest that says the archive is still being prepared starts the preparing request once.
  const manifest = loaded.kind === "ok" ? loaded.manifest : null;
  const asked = useRef(false);
  useEffect(() => {
    if (manifest === null || asked.current) return;
    if (manifest.archive.state === "preparing" && manifest.photos > 0 && !manifest.tooLarge) { asked.current = true; void startPrepared(); }
  }, [manifest, startPrepared]);
  // What the archive is, now: what the preparing request or the last poll said, else what the manifest said.
  const archive = prepared.status === "idle" || prepared.status === "checking" ? (manifest?.archive.state ?? "ready") : prepared.status;
  const canDownload = manifest !== null && manifest.photos > 0 && !manifest.tooLarge && archive === "ready";
  return <>
    <ZipListScroll testId="delivery-zip-body" className="[@media(height<520px)]:flex-none"><ZipBody loaded={loaded} archive={archive} prepareWait={prepareWait} pollWait={pollWait} onRetry={load} onCheckAgain={() => void startPrepared()} /></ZipListScroll>
    <DialogFooter data-testid="delivery-zip-footer" className="shrink-0 [@media(height<520px)]:sticky [@media(height<520px)]:-bottom-[var(--space-4)] [@media(height<520px)]:bg-[color-mix(in_srgb,var(--color-muted)_50%,var(--color-popover))]">
      <Button type="button" variant="outline" data-testid="delivery-zip-close" className={TOUCH} onClick={onClose}>Close</Button>
      {!canDownload && manifest !== null && manifest.photos > 0 && !manifest.tooLarge && archive === "preparing" && <Button type="button" disabled data-testid="delivery-zip-start-pending" className={TOUCH}><Spinner aria-hidden="true" role="presentation" />Download zip</Button>}
      {canDownload && <Button nativeButton={false} data-testid="delivery-zip-start" className={TOUCH} render={<a href={api.zipUrl(size)} download />}><DownloadIcon aria-hidden="true" />Download zip</Button>}
    </DialogFooter>
  </>;
}

function ZipBody({ loaded, archive, prepareWait, pollWait, onRetry, onCheckAgain }: { loaded: Loaded; archive: string; prepareWait: number | null; pollWait: number | null; onRetry: () => void; onCheckAgain: () => void }) {
  if (loaded.kind === "loading") return <p role="status" className={PROBLEM}>Checking what's ready…</p>;
  if (loaded.kind === "failed" || loaded.kind === "limited") {
    return <div className="flex flex-col items-start gap-[var(--space-2)]">
      <p role="alert" data-testid="delivery-zip-problem" className={PROBLEM}>{loaded.kind === "limited" ? waitCopy(loaded.seconds) : "Couldn't check what's ready to download. Try again."}</p>
      <Button type="button" variant="outline" data-testid="delivery-zip-retry" className={TOUCH} onClick={onRetry}>Try again</Button>
    </div>;
  }
  const { photos, totalBytes, tooLarge, leftOut } = loaded.manifest;
  const usable = photos > 0 && !tooLarge;
  const waiting = archive === "preparing" || archive === "checking" || archive === "timeout" || archive === "ready";
  return <div className="flex flex-col gap-[var(--space-4)]">
    {photos === 0 && <p role="status" data-testid="delivery-zip-problem" className={PROBLEM}>There are no photos to download yet.</p>}
    {tooLarge && <p role="alert" data-testid="delivery-zip-problem" className={PROBLEM}>{TOO_BIG_COPY}</p>}
    {usable && waiting && <div className="flex flex-col items-start gap-[var(--space-2)]">
      {/* One status region for the whole wait: it stays mounted from preparing to ready, so a screen reader hears the text change. */}
      <Notice tone={archive === "ready" ? "positive" : "caution"} role="status" data-testid="delivery-zip-status" className="flex w-full items-start gap-[var(--space-2)]">
        {(archive === "preparing" || archive === "checking") && <Spinner aria-hidden="true" role="presentation" className={NOTICE_SPINNER} />}
        {archive === "ready" ? READY_HINT_COPY : archive === "timeout" ? PREPARE_TIMEOUT_COPY : pollWait !== null ? waitCopy(pollWait) : PREPARING_COPY}
      </Notice>
      {archive === "timeout" && <Button type="button" variant="outline" data-testid="delivery-zip-check-again" className={TOUCH} onClick={onCheckAgain}>Check again</Button>}
    </div>}
    {usable && (archive === "unavailable" || archive === "failed") && <div className="flex flex-col items-start gap-[var(--space-2)]">
      <p role="alert" data-testid="delivery-zip-problem" className={PROBLEM}>{prepareWait !== null ? waitCopy(prepareWait) : PREPARE_FAILED_COPY}</p>
      <Button type="button" variant="outline" data-testid="delivery-zip-check-again" className={TOUCH} onClick={onCheckAgain}>Check again</Button>
    </div>}
    {usable && archive === "too_large" && <p role="alert" data-testid="delivery-zip-problem" className={PROBLEM}>{TOO_BIG_COPY}</p>}
    {photos > 0 && <h3 data-testid="delivery-zip-summary" className={HEADING}>{`In the zip: ${photos} ${photos === 1 ? "photo" : "photos"} · ${formatBytes(totalBytes)}`}</h3>}
    {leftOut.length > 0 && <section aria-label="Not included" className="flex flex-col gap-[var(--space-2)]">
      <h3 className={HEADING}>Not included</h3>
      <ItemGroup className="gap-[var(--space-2)]">
        {leftOut.map((entry, index) => <Item key={`${entry.label}:${index}`} variant="outline" size="sm" data-testid="delivery-zip-leftout-item">
          <ItemContent><ItemTitle>{entry.label}</ItemTitle><ItemDescription>Ask the studio to unlock it.</ItemDescription></ItemContent>
        </Item>)}
      </ItemGroup>
    </section>}
  </div>;
}
