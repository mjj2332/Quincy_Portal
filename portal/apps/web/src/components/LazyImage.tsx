import { useCallback, useEffect, useRef, useState } from "react";
import { attachLazyImageObserver } from "../lib/lazy-image-observer";

export const MAX_CONCURRENT = 4;
const LOAD_TIMEOUT_MS = 25_000;

let activeRequests = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      activeRequests += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeRequests -= 1;
        waiting.shift()?.();
      });
    };
    if (activeRequests < MAX_CONCURRENT) grant(); else waiting.push(grant);
  });
}

function retryUrl(src: string, attempt: number, retryToken: number): string {
  if (attempt === 0 && retryToken === 0) return src;
  const url = new URL(src, window.location.href);
  url.searchParams.set("__lazy_retry", `${retryToken}-${attempt}`);
  return /^[a-z][a-z\d+.-]*:/i.test(src) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

type Status = "idle" | "loading" | "failed";
type RenderedAttempt = { id: number; url: string };

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  /** Incremented by an interactive host to retry a terminal failure without nesting controls. */
  retryToken?: number;
  onFailedChange?: (failed: boolean) => void;
}

/**
 * The semaphore deliberately owns the rendered <img>, not a detached preload. A permit is
 * released exactly once by its load/error/watchdog/source-cleanup lifecycle.
 */
export function LazyImage({ src, alt, className, retryToken = 0, onFailedChange }: LazyImageProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [rendered, setRendered] = useState<RenderedAttempt | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRef = useRef(false);
  // A visible failed placeholder can immediately produce another observer callback. This
  // terminal ref is intentionally independent of render state and resets only on src/retry.
  const terminalRef = useRef(false);
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
        retryTimer = window.setTimeout(() => { retryTimer = undefined; void start(); }, 300 * 2 ** retryNumber + Math.random() * 100);
        return;
      }
      terminalRef.current = true;
      setStatus("failed");
      onFailedChangeRef.current?.(true);
    };
    const succeed = (id: number) => {
      if (!releaseActive(id) || cancelled) return;
      setStatus("idle");
      onFailedChangeRef.current?.(false);
    };
    const start = async () => {
      if (cancelled || terminalRef.current || !visibleRef.current || active || retryTimer !== undefined) return;
      const release = await acquire();
      if (cancelled || !visibleRef.current || active) { release(); return; }
      const id = ++attemptGenerationRef.current;
      active = { id, release, watchdog: undefined, released: false };
      setStatus("loading");
      setRendered({ id, url: retryUrl(src, attempts, retryToken) });
      active.watchdog = window.setTimeout(() => fail(id), LOAD_TIMEOUT_MS);
    };

    const handlers = { succeed, fail };
    eventHandlersRef.current = handlers;
    visibleRef.current = typeof IntersectionObserver === "undefined";
    terminalRef.current = false;
    setStatus("idle"); setRendered(null); onFailedChangeRef.current?.(false);
    if (typeof IntersectionObserver === "undefined") {
      void start();
    } else {
      observer = attachLazyImageObserver(() => elementRef.current, (isIntersecting) => {
        visibleRef.current = isIntersecting;
        if (isIntersecting) void start();
      });
      observerRef.current = observer;
      if (elementRef.current) observer.observe(elementRef.current);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      releaseActive();
      if (eventHandlersRef.current === handlers) eventHandlersRef.current = null;
    };
  }, [src, retryToken]);

  const placeholderClassName = `project-cover-placeholder lazy-image-placeholder ${className ?? ""}`;
  if (rendered) {
    return <img key={rendered.id} ref={setObservedElement} src={rendered.url} alt={alt} className={className} onLoad={() => eventHandlersRef.current?.succeed(rendered.id)} onError={() => eventHandlersRef.current?.fail(rendered.id)} />;
  }
  if (status === "failed") return <div ref={setObservedElement} className={`${placeholderClassName} lazy-image-placeholder--failed`} role="status" aria-label={`Image failed to load: ${alt}. Activate its containing preview to retry.`}><span aria-hidden="true">Image unavailable</span></div>;
  return <div ref={setObservedElement} className={placeholderClassName} role="status" aria-label={`Loading ${alt}`} />;
}
