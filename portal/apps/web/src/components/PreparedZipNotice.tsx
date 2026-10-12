import { useEffect, useRef } from "react";
import { Notice } from "@/components/quincy/Notice";
import { Button } from "@/components/reui/button";
import { Spinner } from "@/components/reui/spinner";
import { NOTICE_SPINNER, PREPARE_TIMEOUT_COPY, READY_HINT_COPY, usePreparedDownload, type PrepareOutcome } from "../lib/use-prepared-download";

/**
 * The staff "this zip is being prepared" notice (#802). It opens when the server said `download_preparing` (or a prepare said `preparing`), polls every 30 s for five minutes while it is mounted
 * and the page is visible (the hook owns the timing), and offers the download button once the answer is `ready`. It never downloads by itself, and closing or unmounting it stops the polling.
 * `ask` is one request to the server about this archive; `first` is the answer the opening click already got, used once so the notice does not repeat that request.
 */
export const PREPARING_COPY = "Preparing this download. This may take a few minutes.";
export const PREPARE_FAILED_COPY = "Couldn't prepare this zip. Try again or download the files one at a time.";
export const PREPARE_TOO_BIG_COPY = "This is too big to download as one zip. Download the files one at a time instead.";

export function PreparedZipNotice({ ask, onDownload, onClose, onError, label = "Download zip" }: { ask: () => Promise<PrepareOutcome>; onDownload: () => void; onClose: () => void; onError?: (reason: unknown) => void; label?: string }) {
  const first = useRef(true);
  const prepared = usePreparedDownload({
    active: true,
    ...(onError ? { onError } : {}),
    check: async (reason) => {
      if (reason === "start" && first.current) { first.current = false; return { state: "preparing" }; }
      return ask();
    },
  });
  const { start } = prepared;
  useEffect(() => { void start(); }, [start]);
  const status = prepared.status;
  const failed = status === "unavailable" || status === "failed" || status === "too_large";
  const tone = failed ? "critical" : status === "ready" ? "positive" : "caution";
  // One stable row of actions outside the announcement region, so a poll that turns the message from status to alert never remounts Close (it may hold focus). Only the message element changes: a
  // failure is announced as an alert (a distinct element, so the role change is announced), preparing, timeout and ready share one status.
  return (
    <Notice tone={tone} data-tone={tone} data-testid="prepared-zip-notice" className="flex flex-wrap items-start gap-[var(--space-2)]">
      {failed
        ? <span key="alert" role="alert" data-testid="prepared-zip-message" className="min-w-0 flex-1">{status === "too_large" ? PREPARE_TOO_BIG_COPY : PREPARE_FAILED_COPY}</span>
        : <span key="status" role="status" data-testid="prepared-zip-message" className="flex min-w-0 flex-1 items-start gap-[var(--space-2)]">
          {(status === "idle" || status === "checking" || status === "preparing") && <Spinner aria-hidden="true" role="presentation" className={NOTICE_SPINNER} />}
          {status === "ready" ? READY_HINT_COPY : status === "timeout" ? PREPARE_TIMEOUT_COPY : PREPARING_COPY}
        </span>}
      {(status === "timeout" || status === "unavailable" || status === "failed") && <Button type="button" variant="outline" data-testid="prepared-zip-check-again" onClick={() => void start()}>Check again</Button>}
      {status === "ready" && <Button type="button" variant="outline" data-testid="prepared-zip-download" onClick={onDownload}>{label}</Button>}
      <Button type="button" variant="ghost" data-testid="prepared-zip-close" className="ml-auto" onClick={onClose}>Close</Button>
    </Notice>
  );
}
