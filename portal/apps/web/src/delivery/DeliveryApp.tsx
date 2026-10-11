import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeliveryPageDto } from "@quincy/shared";
import { EmptyState } from "../components/quincy/EmptyState";
import { Button } from "../components/reui/button";
import { Skeleton } from "../components/reui/skeleton";
import { UnreachableScreen } from "../guest/GuestScreens";
import { createDeliveryApi } from "./delivery-api";
import { useSecondsUntil } from "./delivery-hooks";
import type { UnlockState, UnlockStates } from "./delivery-model";
import { DeliveryPage } from "./DeliveryPage";
import { STUDIO_EMAIL } from "./studio";
import { StudioCredit } from "./StudioCredit";
import { TOUCH } from "./UnlockControl";

type Screen =
  | { name: "loading" }
  | { name: "ready"; dto: DeliveryPageDto }
  | { name: "gone" }
  | { name: "transient" }
  | { name: "rateLimited"; until: number }
  | { name: "outdated" };

const shell = "flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]";

function LoadingScreen() {
  return <main aria-busy="true" aria-label="Loading the delivery page" data-testid="delivery-loading" className="mx-auto grid w-full max-w-[var(--container-page)] gap-[var(--space-5)] px-[var(--space-4)] py-[var(--space-5)]">
    <Skeleton className="aspect-[16/9] w-full max-[721px]:aspect-[4/3]" />
    <Skeleton className="h-10 w-2/3" />
    <Skeleton className="h-5 w-1/3" />
    <div className="grid grid-cols-4 gap-[var(--space-3)] max-[721px]:grid-cols-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[3/2]" />)}</div>
  </main>;
}

function RateLimitedScreen({ until, onRetry }: { until: number; onRetry: () => void }) {
  const seconds = useSecondsUntil(until);
  return <main className={shell}>
    <EmptyState data-testid="delivery-limited" title={seconds > 0 ? "Too many requests." : "You can try again now."}>
      {seconds > 0 && <p className="m-0 mb-[var(--space-3)]" aria-live="polite">{`Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`}</p>}
      <Button type="button" className={TOUCH} disabled={seconds > 0} onClick={onRetry}>Try again</Button>
    </EmptyState>
  </main>;
}

/**
 * The public Client Delivery page (#787 slice 9), mounted by `mount-delivery.tsx` on `/d/<address>`. It reads `/d/api/pages/<slug>` through `delivery-api.ts` (no cookie, no staff API; `guest-boundary.guard.test.ts` keeps it that way)
 * and shows one of: a skeleton, the page, "This page isn't available." (unknown, switched off, unpublished and gate-shut are the same answer), a calm retry, a countdown, or "This page was updated." (the body no longer parses).
 * It owns the real unlock requests and their per-handle state, so a request survives a tab or lightbox change; a 409 `not_locked` re-reads the page quietly.
 */
export function DeliveryApp({ slug }: { slug: string }) {
  const api = useMemo(() => createDeliveryApi(slug), [slug]);
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [unlock, setUnlock] = useState<UnlockStates>({});
  const attempt = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  /** Bumped when the page turns out to be gone: an unlock answer that was started before it is stale and must not touch the screen or the unlock states. */
  const generation = useRef(0);
  const unlockRef = useRef<UnlockStates>({});
  unlockRef.current = unlock;

  /** Once gone, always gone: abort and retire any page read still out (a late 200 would resurrect stale content), and retire older unlock answers. */
  const gone = useCallback(() => {
    generation.current += 1; attempt.current += 1; controller.current?.abort();
    setScreen({ name: "gone" });
  }, []);
  /** `quiet` keeps the page on screen while it re-reads (after a 409): only a definite answer replaces it. */
  const load = useCallback(async (quiet: boolean) => {
    controller.current?.abort();
    const mine = new AbortController(); controller.current = mine;
    const id = attempt.current + 1; attempt.current = id;
    if (!quiet) setScreen({ name: "loading" });
    const read = await api.page(mine.signal);
    if (!alive.current || attempt.current !== id || mine.signal.aborted) return;
    switch (read.kind) {
      case "ok": setScreen({ name: "ready", dto: read.dto }); break;
      case "gone": gone(); break;
      case "outdated": setScreen({ name: "outdated" }); break;
      case "rateLimited": setScreen({ name: "rateLimited", until: Date.now() + read.retryAfterSeconds * 1000 }); break;
      case "transient": setScreen((current) => (quiet && current.name === "ready" ? current : { name: "transient" })); break;
    }
  }, [api, gone]);

  useEffect(() => {
    alive.current = true;
    void load(false);
    return () => { alive.current = false; controller.current?.abort(); };
  }, [load]);

  useEffect(() => { if (screen.name === "ready") document.title = screen.dto.property.street; }, [screen]);

  const setState = useCallback((handle: string, next: UnlockState) => { setUnlock((current) => ({ ...current, [handle]: next })); }, []);
  const requestUnlock = useCallback(async (handle: string) => {
    const current = unlockRef.current[handle];
    if (current && (current.kind === "sending" || current.kind === "requested" || (current.kind === "limited" && current.until > Date.now()))) return;
    setState(handle, { kind: "sending" });
    const started = generation.current;
    const result = await api.requestUnlock(handle);
    if (!alive.current || generation.current !== started) return;
    switch (result.kind) {
      case "requested": setState(handle, { kind: "requested" }); break;
      case "limited": setState(handle, { kind: "limited", until: Date.now() + result.retryAfterSeconds * 1000 }); break;
      case "failed": setState(handle, { kind: "failed" }); break;
      case "notLocked": setState(handle, { kind: "idle" }); void load(true); break;
      case "gone": gone(); break;
    }
  }, [api, load, setState, gone]);

  switch (screen.name) {
    case "loading": return <LoadingScreen />;
    case "gone": return <main className={shell}><div className="grid justify-items-center gap-[var(--space-3)]"><EmptyState data-testid="delivery-gone" title="This page isn't available." /><StudioCredit href={`mailto:${STUDIO_EMAIL}`} data-testid="delivery-gone-credit" className="text-center" /></div></main>;
    case "transient": return <UnreachableScreen onRetry={() => { void load(false); }} />;
    case "rateLimited": return <RateLimitedScreen until={screen.until} onRetry={() => { void load(false); }} />;
    case "outdated": return <main className={shell}>
      <EmptyState data-testid="delivery-outdated" title="This page was updated."><Button type="button" className={TOUCH} onClick={() => { window.location.reload(); }}>Reload</Button></EmptyState>
    </main>;
    case "ready": return <main><DeliveryPage dto={screen.dto} hrefs={api.hrefs} unlockState={unlock} onRequestUnlock={(handle) => { void requestUnlock(handle); }} /></main>;
  }
}
