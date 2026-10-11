import { useEffect, useRef } from "react";
import { Notice } from "@/components/quincy/Notice";
import { Button } from "@/components/reui/button";
import { Spinner } from "@/components/reui/spinner";
import { usePreparedDownload, type PrepareOutcome } from "../lib/use-prepared-download";

/**
 * The staff "this zip is being prepared" notice (#802). It opens when the server said `download_preparing` (or a prepare said `preparing`), polls every 30 s for five minutes while it is mounted
 * and the page is visible (the hook owns the timing), and offers the download button once the answer is `ready`. It never downloads by itself, and closing or unmounting it stops the polling.
 * `ask` is one request to the server about this archive; `first` is the answer the opening click already got, used once so the notice does not repeat that request.
 */
export const PREPARING_COPY = "Preparing this download. This may take a few minutes.";
export const PREPARE_FAILED_COPY = "Couldn't prepare this zip. Try again or download the files one at a time.";
export const PREPARE_TOO_BIG_COPY = "This is too big to download as one zip. Download the files one at a time instead.";

export function PreparedZipNotice({ ask, onDownload, onClose, label = "Download zip" }: { ask: () => Promise<PrepareOutcome>; onDownload: () => void; onClose: () => void; label?: string }) {
  const first = useRef(true);
  const prepared = usePreparedDownload({
    active: true,
    check: async (reason) => {
      if (reason === "start" && first.current) { first.current = false; return { state: "preparing" }; }
      return ask();
    },
  });
  const { start } = prepared;
  useEffect(() => { void start(); }, [start]);
  const status = prepared.status;
  return (
    <Notice tone={status === "unavailable" || status === "failed" || status === "too_large" ? "critical" : "caution"} role="status" data-testid="prepared-zip-notice" className="flex flex-wrap items-center gap-[var(--space-2)]">
      {(status === "idle" || status === "checking" || status === "preparing") && <><Spinner aria-hidden="true" role="presentation" /><span>{PREPARING_COPY}</span></>}
      {status === "timeout" && <><span>{PREPARING_COPY}</span><Button type="button" variant="outline" data-testid="prepared-zip-check-again" onClick={() => void start()}>Check again</Button></>}
      {status === "ready" && <Button type="button" data-testid="prepared-zip-download" onClick={onDownload}>{label}</Button>}
      {(status === "unavailable" || status === "failed") && <><span>{PREPARE_FAILED_COPY}</span><Button type="button" variant="outline" data-testid="prepared-zip-check-again" onClick={() => void start()}>Check again</Button></>}
      {status === "too_large" && <span>{PREPARE_TOO_BIG_COPY}</span>}
      <Button type="button" variant="ghost" data-testid="prepared-zip-close" className="ml-auto" onClick={onClose}>Close</Button>
    </Notice>
  );
}
