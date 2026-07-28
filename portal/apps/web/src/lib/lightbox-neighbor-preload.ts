import { useEffect, useRef } from "react";
import type { WorkspaceAsset } from "../components/PhotoGrid";

export interface NeighborPendingRequest {
  promise: Promise<() => void>;
  cancel(): void;
}

export interface NeighborScheduler {
  acquire(): NeighborPendingRequest;
}

export function createNeighborScheduler(maxConcurrent: number): NeighborScheduler {
  let active = 0;
  const waiting: Array<{ grant: () => void }> = [];

  function drain(): void {
    if (active >= maxConcurrent || waiting.length === 0) return;
    const [waitingEntry] = waiting.splice(0, 1);
    waitingEntry!.grant();
  }

  function acquire(): NeighborPendingRequest {
    let entry: { grant: () => void } | null = null;
    const promise = new Promise<() => void>((resolve) => {
      const grant = () => {
        active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active -= 1;
          drain();
        });
      };
      if (active < maxConcurrent) grant();
      else {
        entry = { grant };
        waiting.push(entry);
      }
    });
    return {
      promise,
      cancel() {
        if (!entry) return;
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
      },
    };
  }

  return { acquire };
}

export const lightboxPreloadScheduler = createNeighborScheduler(2);

export function normalizeIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

export function neighborIndices(index: number, count: number, radius = 1): number[] {
  const indices = new Set<number>();
  for (let delta = 1; delta <= radius; delta += 1) {
    const next = normalizeIndex(index + delta, count);
    const previous = normalizeIndex(index - delta, count);
    if (next !== index) indices.add(next);
    if (previous !== index) indices.add(previous);
  }
  return [...indices];
}

export type NeighborState =
  | { kind: "queued"; pending: NeighborPendingRequest }
  | { kind: "active"; img: HTMLImageElement; release: () => void; watchdog: number };

export function startNeighborPreload(neighbors: Map<string, NeighborState>, scheduler: NeighborScheduler, assetId: string): void {
  const pending = scheduler.acquire();
  const queuedEntry: NeighborState = { kind: "queued", pending };
  neighbors.set(assetId, queuedEntry);
  void pending.promise.then((release) => {
    if (neighbors.get(assetId) !== queuedEntry) {
      release();
      return;
    }
    const img = new Image();
    // fetchPriority hints the browser to favor the hero image the user is actually looking at
    // over this speculative prefetch, when both are competing for bandwidth/connections.
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
    const activeEntry: NeighborState = { kind: "active", img, release, watchdog: 0 };
    // "Release exactly once" and "still own this map slot" are two different questions — a
    // one-shot `done` flag answers the first unconditionally; map identity (used only to decide
    // whether to `delete`) answers the second. Conflating them (gating the release call itself
    // behind the identity check) would let a superseded entry's permit leak permanently if the
    // map had already moved on to a different entry for the same asset ID before this fired —
    // not reachable via `reconcile` today, but both this function and `finish`'s logic are
    // exported, so a future caller violating that invariant shouldn't be able to wedge the
    // 2-slot budget. Same bug shape as the succeed()/fail() asymmetry fixed in the grid preload
    // plan; closed here the same way, before it could ever ship.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(activeEntry.watchdog);
      release();
      if (neighbors.get(assetId) === activeEntry) neighbors.delete(assetId);
    };
    activeEntry.watchdog = window.setTimeout(finish, 25_000);
    neighbors.set(assetId, activeEntry);
    img.onload = finish;
    img.onerror = finish;
    img.src = `/media/asset/${encodeURIComponent(assetId)}/web`;
  });
}

export function reconcile(neighbors: Map<string, NeighborState>, scheduler: NeighborScheduler, desired: string[]): void {
  const desiredSet = new Set(desired);
  for (const [assetId, entry] of neighbors) {
    if (desiredSet.has(assetId)) continue;
    if (entry.kind === "queued") {
      entry.pending.cancel(); // never granted a permit — clean, immediate removal
      neighbors.delete(assetId);
    }
    // An "active" entry that's no longer desired is left alone: it can't be cleanly aborted
    // (no reliable network abort — see the module doc), so it stays tracked until its own
    // `finish` fires, which releases its permit either way. There's no result to act on either
    // way (no retry, no cache to populate beyond the browser's own), so nothing else to do here.
  }
  for (const assetId of desiredSet) {
    if (neighbors.has(assetId)) continue; // already tracked (queued or active) — no duplicate fetch
    startNeighborPreload(neighbors, scheduler, assetId);
  }
}

function saveDataEnabled(): boolean {
  return typeof navigator !== "undefined" && (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

export function useLightboxNeighborPreload(
  assets: WorkspaceAsset[],
  index: number,
  scheduler: NeighborScheduler = lightboxPreloadScheduler,
): void {
  const neighborsRef = useRef(new Map<string, NeighborState>());

  useEffect(() => {
    const neighbors = neighborsRef.current;
    const desired = saveDataEnabled() || assets.length === 0
      ? []
      : neighborIndices(index, assets.length, 1).map((neighborIndex) => assets[neighborIndex]!.id);
    reconcile(neighbors, scheduler, desired);
  }, [assets, index, scheduler]);

  useEffect(() => {
    const neighbors = neighborsRef.current;
    return () => {
      for (const [assetId, entry] of neighbors) {
        if (entry.kind === "queued") {
          entry.pending.cancel();
          neighbors.delete(assetId);
        }
        // Active entries are left to finish on their own — see reconcile()'s comment above.
      }
    };
  }, []);
}
