import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_CONCURRENT = 4;

// The semaphore protects the browser/network from a large grid stampede, and the watchdog
// returns permits for hung fetches. Each attempt preloads through its own detached Image,
// so a late event belongs only to an already-detached handler and cannot release a newer
// attempt's permit as it could when retries reused the rendered DOM node.
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

type Status = "idle" | "loaded" | "failed";

export function LazyImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [status, setStatus] = useState<Status>("idle");
  // Which src actually finished preloading — guards against rendering a not-yet-gated <img>
  // for one frame when a mounted instance's src changes before the effect resets status.
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRef = useRef(false);

  const setObservedElement = useCallback((element: HTMLElement | null) => {
    const observer = observerRef.current;
    if (elementRef.current && observer) observer.unobserve(elementRef.current);
    elementRef.current = element;
    if (element && observer) observer.observe(element);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    let observer: IntersectionObserver | undefined;
    let heldRelease: (() => void) | null = null;
    let cancelCurrentAttempt: (() => void) | null = null;
    let completed = false;
    let terminalFailure = false;
    let requested = false;

    visibleRef.current = typeof IntersectionObserver === "undefined";
    setStatus("idle");

    const releaseHeld = () => {
      heldRelease?.();
      heldRelease = null;
    };

    const request = async () => {
      if (
        cancelled || completed || terminalFailure || requested || retryTimer !== undefined
      ) return;

      requested = true;
      const release = await acquire();
      if (cancelled || !visibleRef.current) {
        release();
        requested = false;
        return;
      }

      heldRelease = release;
      const img = new Image();
      let finished = false;
      let watchdogTimer: number | undefined;

      const clearWatchdog = () => {
        if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      };
      const releaseAttempt = () => {
        if (heldRelease === release) heldRelease = null;
        release();
      };
      const abandon = () => {
        if (finished) return;
        finished = true;
        clearWatchdog();
        img.onload = null;
        img.onerror = null;
        img.src = "";
        if (cancelCurrentAttempt === abandon) cancelCurrentAttempt = null;
        releaseAttempt();
      };
      const finish = (ok: boolean, timedOut = false) => {
        if (finished) return;
        finished = true;
        clearWatchdog();
        img.onload = null;
        img.onerror = null;
        if (timedOut) img.src = "";
        if (cancelCurrentAttempt === abandon) cancelCurrentAttempt = null;
        releaseAttempt();
        requested = false;

        if (cancelled) return;
        if (ok) {
          completed = true;
          setLoadedSrc(src);
          setStatus("loaded");
          return;
        }

        if (attempts < 2) {
          const retryNumber = attempts;
          attempts += 1;
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            void request();
          }, 300 * 2 ** retryNumber + Math.random() * 100);
          return;
        }

        terminalFailure = true;
        setStatus("failed");
      };

      cancelCurrentAttempt = abandon;
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      watchdogTimer = window.setTimeout(() => finish(false, true), LOAD_TIMEOUT_MS);
      img.src = src;
    };

    if (typeof IntersectionObserver === "undefined") {
      void request();
    } else {
      observer = new IntersectionObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === elementRef.current);
        if (!entry) return;
        visibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) void request();
      }, { rootMargin: "600px" });
      observerRef.current = observer;
      if (elementRef.current) observer.observe(elementRef.current);
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      cancelCurrentAttempt?.();
      releaseHeld();
    };
  }, [src]);

  const placeholderClassName = `project-cover-placeholder lazy-image-placeholder ${className ?? ""}`;
  if (status === "loaded" && loadedSrc === src) return <img ref={setObservedElement} src={src} alt={alt} className={className} />;
  return <div ref={setObservedElement} className={placeholderClassName} aria-hidden="true" />;
}
