import { useCallback, useEffect, useRef, useState } from "react";
import { attachLazyImageObserver } from "../lib/lazy-image-observer";
import { gridImageScheduler, type PendingRequest, type Priority, type Scheduler } from "../lib/image-preload-scheduler";

const LOAD_TIMEOUT_MS = 25_000;

type LazyImageBaseProps = {
  alt: string;
  className?: string;
  /** Incremented by an interactive host to retry a terminal failure without nesting controls. */
  retryToken?: number;
  onFailedChange?: (failed: boolean) => void;
  scheduler?: Scheduler;
};

export type LazyImageProps =
  | (LazyImageBaseProps & { preload?: "visible-only"; src: string })
  | (LazyImageBaseProps & { preload: "background"; assetId: string });

type Status = "idle" | "loading" | "failed";
type RenderedAttempt = { id: number; url: string };

function retryUrl(src: string, attempt: number, retryToken: number): string {
  if (attempt === 0 && retryToken === 0) return src;
  const url = new URL(src, window.location.href);
  url.searchParams.set("__lazy_retry", `${retryToken}-${attempt}`);
  return /^[a-z][a-z\d+.-]*:/i.test(src) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

function saveDataEnabled() {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/**
 * The scheduler deliberately owns the rendered <img>, not a detached preload. A permit is
 * released exactly once by its load/error/watchdog/source-cleanup lifecycle.
 */
export function LazyImage(props: LazyImageProps) {
  const { alt, className, retryToken = 0, onFailedChange } = props;
  const effectiveIdentity = props.preload === "background" ? props.assetId : props.src;
  const effectiveSrc = props.preload === "background" ? `/media/asset/${encodeURIComponent(props.assetId)}/thumb` : props.src;
  const [status, setStatus] = useState<Status>("idle");
  const [rendered, setRendered] = useState<RenderedAttempt | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRef = useRef(false);
  // A visible failed placeholder can immediately produce another observer callback. This
  // terminal ref is intentionally independent of render state and resets only on identity/retry.
  const terminalRef = useRef(false);
  const succeededRef = useRef(false);
  const pendingRef = useRef<PendingRequest | null>(null);
  const priorityRef = useRef<Priority>("visible");
  const attemptGenerationRef = useRef(0);
  const onFailedChangeRef = useRef(onFailedChange);
  const eventHandlersRef = useRef<{ succeed: (id: number) => void; fail: (id: number) => void } | null>(null);

  useEffect(() => { onFailedChangeRef.current = onFailedChange; }, [onFailedChange]);

  const setObservedElement = useCallback((element: HTMLElement | null) => {
    if (elementRef.current && observerRef.current) observerRef.current.unobserve(elementRef.current);
    elementRef.current = element;
    if (element && observerRef.current) observerRef.current.observe(element);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    let idleHandle: number | undefined;
    let idleFallbackTimer: number | undefined;
    let observer: IntersectionObserver | undefined;
    let active: { id: number; release: () => void; watchdog: number | undefined; released: boolean } | null = null;

    const releaseActive = (id?: number) => {
      if (!active || (id !== undefined && active.id !== id)) return false;
      const current = active;
      active = null;
      if (current.watchdog !== undefined) window.clearTimeout(current.watchdog);
      if (!current.released) { current.released = true; current.release(); }
      return true;
    };
    const fail = (id: number) => {
      if (!releaseActive(id)) return;
      setRendered((current) => current?.id === id ? null : current);
      if (cancelled) return;
      if (attempts < 2) {
        const retryNumber = attempts++;
        const retryPriority = priorityRef.current;
        retryTimer = window.setTimeout(() => { retryTimer = undefined; void start(retryPriority); }, 300 * 2 ** retryNumber + Math.random() * 100);
        return;
      }
      terminalRef.current = true;
      setStatus("failed");
      onFailedChangeRef.current?.(true);
    };
    const succeed = (id: number) => {
      // Mirror fail()'s ownership check: a stale load event for an attempt that's already been
      // superseded (e.g. the watchdog already failed it and a retry is pending or has started)
      // must not poison succeededRef for the wrong attempt — that would permanently block start()
      // from ever running again, wedging the tile on its loading placeholder with no retry.
      if (!releaseActive(id)) return;
      succeededRef.current = true;
      if (cancelled) return;
      setStatus("idle");
      onFailedChangeRef.current?.(false);
    };
    const start = async (priority: Priority) => {
      if (cancelled || terminalRef.current || active || retryTimer !== undefined || succeededRef.current) return;
      if (pendingRef.current) {
        if (priority === "visible") { pendingRef.current.promote(); priorityRef.current = "visible"; }
        return;
      }
      if (priority === "visible" && !visibleRef.current) return;
      priorityRef.current = priority;
      const pending = (props.scheduler ?? gridImageScheduler).acquire(priority);
      pendingRef.current = pending;
      const release = await pending.promise;
      // An older continuation must not clear a newer request installed by an effect rerun.
      if (pendingRef.current === pending) pendingRef.current = null;
      if (cancelled || active) { release(); return; }
      const id = ++attemptGenerationRef.current;
      active = { id, release, watchdog: undefined, released: false };
      setStatus("loading");
      setRendered({ id, url: retryUrl(effectiveSrc, attempts, retryToken) });
      active.watchdog = window.setTimeout(() => fail(id), LOAD_TIMEOUT_MS);
    };

    const scheduleBackground = () => {
      if (props.preload !== "background" || visibleRef.current || saveDataEnabled()) return;
      const trigger = () => {
        idleHandle = undefined;
        idleFallbackTimer = undefined;
        if (!cancelled && props.preload === "background" && !visibleRef.current && !saveDataEnabled()) void start("background");
      };
      if (typeof window.requestIdleCallback === "function") idleHandle = window.requestIdleCallback(trigger);
      else idleFallbackTimer = window.setTimeout(trigger, 200);
    };

    const handlers = { succeed, fail };
    eventHandlersRef.current = handlers;
    visibleRef.current = typeof IntersectionObserver === "undefined";
    terminalRef.current = false;
    succeededRef.current = false;
    priorityRef.current = "visible";
    setStatus("idle"); setRendered(null); onFailedChangeRef.current?.(false);
    if (typeof IntersectionObserver === "undefined") {
      void start("visible");
    } else {
      observer = attachLazyImageObserver(() => elementRef.current, (isIntersecting) => {
        visibleRef.current = isIntersecting;
        if (isIntersecting) void start("visible");
      });
      observerRef.current = observer;
      if (elementRef.current) observer.observe(elementRef.current);
      scheduleBackground();
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      if (idleFallbackTimer !== undefined) window.clearTimeout(idleFallbackTimer);
      pendingRef.current?.cancel();
      pendingRef.current = null;
      releaseActive();
      if (eventHandlersRef.current === handlers) eventHandlersRef.current = null;
    };
  }, [effectiveIdentity, retryToken]);

  const placeholderClassName = `project-cover-placeholder lazy-image-placeholder ${className ?? ""}`;
  if (rendered) {
    return <img key={rendered.id} ref={setObservedElement} src={rendered.url} alt={alt} className={className} onLoad={() => eventHandlersRef.current?.succeed(rendered.id)} onError={() => eventHandlersRef.current?.fail(rendered.id)} />;
  }
  if (status === "failed") return <div ref={setObservedElement} className={`${placeholderClassName} lazy-image-placeholder--failed`} role="status" aria-label={`Image failed to load: ${alt}. Activate its containing preview to retry.`}><span aria-hidden="true">Image unavailable</span></div>;
  return <div ref={setObservedElement} className={placeholderClassName} role="status" aria-label={`Loading ${alt}`} />;
}
