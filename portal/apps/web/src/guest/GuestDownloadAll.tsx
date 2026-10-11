import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { GUEST_ZIP_MAX_BYTES, GUEST_ZIP_MAX_ENTRIES, type GuestDownloadManifest, type GuestSessionResponse } from "@quincy/shared";
import { Button } from "../components/reui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/reui/dialog";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../components/reui/item";
import type { GuestApi } from "./guest-api";
import { formatBytes } from "./guest-format";
import type { GuestVerify } from "./use-guest-verify";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const PROBLEM = "m-0 text-foreground-secondary [font:var(--type-body-sm)]";
const HEADING = "m-0 text-foreground [font:var(--type-label)]";
const LEFT_OUT_REASON = { not_released: "Not released yet", premium_locked: "Premium video, not unlocked yet" } as const;

type Loaded = { kind: "loading" } | { kind: "failed" } | { kind: "ok"; manifest: GuestDownloadManifest };

/**
 * Download all for a link with several Videos (#741 14-ui-guest). Opening it reads the manifest of 14b (`GET .../downloads`) fresh: the films the zip will hold and a "left out" list with the
 * reason for each, before anything is requested. Its action is a plain anchor to the zip route, so the browser streams the archive to disk; the page cannot see that request's status (a refusal
 * such as the zip rate limit is the browser's failed download), so what it CAN know is checked first: nothing to download, or over the cap (20 films, 8 GB), has no action at all, and the hint
 * under the action says what to do if the download does not start. Each read is bound to the opening it started in, so an answer that arrives after Close, or after a newer open, changes nothing.
 * The routes need a verified guest: an unverified guest's button opens the verify dialog first (through the page's one verify dialog, so a second action cannot open another), and lands on this dialog once verified.
 * A manifest 401 (verification lost) does the same, and is never the Unavailable page. A manifest 403 `download_disabled` (staff turned downloads off while the page was open) closes the dialog, sets
 * the session's `allow.download` false so every download control goes, and leaves a short notice where this button was; the review stays.
 */
export function GuestDownloadAll({ api, verify, session, onSession, onUnavailable }: { api: GuestApi; verify: GuestVerify; session: GuestSessionResponse; onSession: (next: GuestSessionResponse) => void; onUnavailable: () => void }) {
  const [open, setOpen] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [turnedOff, setTurnedOff] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    setLoaded({ kind: "loading" });
    void api.downloads().then((result) => {
      if (generation.current !== mine) return;
      if (result.kind === "gone") { setOpen(false); onUnavailable(); }
      else if (result.kind === "verify") {
        setOpen(false);
        verify.request({ active: () => generation.current === mine, done: (verified) => { if (verified) openAndLoad.current(); } });
        onSession({ ...sessionRef.current, verified: false, email: null, name: null });
      }
      else if (result.kind === "disabled") {
        setOpen(false); setTurnedOff(true);
        const now = sessionRef.current;
        onSession({ ...now, link: { ...now.link, allow: { ...now.link.allow, download: false } } });
      }
      else if (result.kind === "transient") setLoaded({ kind: "failed" });
      else setLoaded({ kind: "ok", manifest: result.value });
    });
  }, [api, verify, onUnavailable, onSession]);
  const openAndLoad = useRef<() => void>(() => undefined);
  openAndLoad.current = () => { setOpen(true); load(); };
  useEffect(() => () => { generation.current += 1; }, []);
  const close = () => { generation.current += 1; setOpen(false); };
  if (!session.link.allow.download && !turnedOff) return null;
  if (!session.link.allow.download) return <p role="status" data-testid="guest-download-all-disabled" className="m-0 text-foreground-secondary [font:var(--type-label)]">Downloads are turned off for this review.</p>;
  return <>
    <Button type="button" variant="outline" data-testid="guest-download-all" className={TOUCH} onClick={() => { if (session.verified) { setOpen(true); load(); } else verify.request({ active: () => true, done: (verified) => { if (verified) openAndLoad.current(); } }); }}><DownloadIcon aria-hidden="true" />Download all</Button>
    <Dialog open={open} onOpenChange={(next) => { if (next) setOpen(true); else close(); }}>
      <DialogContent data-testid="guest-download-all-dialog" showCloseButton={false} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col sm:max-w-[520px]">
        <DialogHeader className="shrink-0">
          <DialogTitle>Download all</DialogTitle>
          {!(loaded.kind === "ok" && loaded.manifest.included.length === 0) && <DialogDescription>One zip with the released films below.</DialogDescription>}
        </DialogHeader>
        <div data-testid="guest-download-all-body" className="min-h-0 flex-1 overflow-y-auto"><DownloadAllBody loaded={loaded} onRetry={load} /></div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" data-testid="guest-download-all-close" className={TOUCH} onClick={close}>Close</Button>
          {loaded.kind === "ok" && loaded.manifest.included.length > 0 && !loaded.manifest.tooLarge
            && <Button nativeButton={false} data-testid="guest-download-all-start" className={TOUCH} render={<a href={api.downloadAllUrl} download />}><DownloadIcon aria-hidden="true" />Download zip</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function DownloadAllBody({ loaded, onRetry }: { loaded: Loaded; onRetry: () => void }) {
  if (loaded.kind === "loading") return <p role="status" className={PROBLEM}>Checking what's ready…</p>;
  if (loaded.kind === "failed") {
    return <div className="flex flex-col items-start gap-[var(--space-2)]">
      <p role="alert" data-testid="guest-download-all-problem" className={PROBLEM}>Couldn't check what's ready to download. Try again.</p>
      <Button type="button" variant="outline" data-testid="guest-download-all-retry" className={TOUCH} onClick={onRetry}>Try again</Button>
    </div>;
  }
  const { included, leftOut, totalBytes, tooLarge } = loaded.manifest;
  return <div className="flex flex-col gap-[var(--space-4)]">
    {included.length === 0 && <p role="status" data-testid="guest-download-all-problem" className={PROBLEM}>Nothing is ready to download yet.</p>}
    {tooLarge && <p role="alert" data-testid="guest-download-all-problem" className={PROBLEM}>{`This is more than one zip can hold (${GUEST_ZIP_MAX_ENTRIES} films or ${formatBytes(GUEST_ZIP_MAX_BYTES)}). Download the films one at a time instead.`}</p>}
    {included.length > 0 && <section aria-label="In the zip" className="flex flex-col gap-[var(--space-2)]">
      <h3 className={HEADING}>{`In the zip (${formatBytes(totalBytes)})`}</h3>
      <ItemGroup className="gap-[var(--space-2)]">
        {included.map((entry) => <Item key={entry.videoId} variant="outline" size="sm" data-testid="guest-download-item">
          <ItemContent><ItemTitle>{entry.title}</ItemTitle><ItemDescription>{`Version ${entry.version} · ${formatBytes(entry.bytes)}`}</ItemDescription></ItemContent>
        </Item>)}
      </ItemGroup>
    </section>}
    {leftOut.length > 0 && <section aria-label="Left out" className="flex flex-col gap-[var(--space-2)]">
      <h3 className={HEADING}>Left out</h3>
      <ItemGroup className="gap-[var(--space-2)]">
        {leftOut.map((entry, index) => <Item key={`${entry.title}:${index}`} variant="outline" size="sm" data-testid="guest-download-leftout-item">
          <ItemContent><ItemTitle>{entry.title}</ItemTitle><ItemDescription>{LEFT_OUT_REASON[entry.reason]}</ItemDescription></ItemContent>
        </Item>)}
      </ItemGroup>
    </section>}
    {included.length > 0 && !tooLarge && <p className={PROBLEM}>The zip starts in your browser. If nothing downloads, wait a minute and try again.</p>}
  </div>;
}
