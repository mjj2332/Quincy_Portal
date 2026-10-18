import type { RefObject } from "react";
import type { ArchivedLatch } from "./StatusCluster";

type Target = RefObject<HTMLElement | null> | null;

/** Per refusal source, the read-only group focus returns to: in Project info while it is open, in the header otherwise. */
export type LatchFocusTargets = Record<NonNullable<ArchivedLatch>, { info: Target; header: Target }>;

/**
 * #455 / #914: where focus goes when an archived refusal flips the header read-only and focus was inside the refused control. While
 * Project info is open (a modal over the header) focus stays inside it, on the row or section the refusal came from. `null` leaves
 * focus alone: the Team moves its own, and Social overlays lives only in Project info.
 */
export function latchFocusTarget(targets: LatchFocusTargets, source: NonNullable<ArchivedLatch>, infoOpen: boolean): HTMLElement | null {
  const target = targets[source];
  return (infoOpen ? target.info : target.header)?.current ?? null;
}
