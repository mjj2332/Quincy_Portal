/**
 * #291 — the Undo toast, shared by every scheduling surface (the Gantt since #221, the event
 * calendar since #291). Wraps `useSchedulingController` so the controller itself stays toast-free:
 * each successful NON-noop save (`onCommitted`) raises one live Undo toast carrying a compensating
 * ticket (`scheduling-undo`), and the toast's Undo runs it through the controller's `runUndo` —
 * the same command lock, accept gate and token fence as a forward edit.
 *
 * A surface's own `onCommitted` runs first (the Gantt patches continuation-page rows there);
 * `onUndone` passes straight through.
 */
import { useCallback, useEffect, useRef } from "react";
import { buildChecklistUndoTicket, buildDeadlineUndoTicket, type UndoTicket } from "./scheduling-undo";
import { dismissToast, pushToast, type ToastTone } from "./toast-store";
import { useSchedulingController, type RunUndoOutcome, type SchedulingCommittedInfo, type SchedulingController, type SchedulingControllerInput } from "./use-scheduling-commands";

/** #221: how long the Undo toast stays up (paused while hovered/focused — `toast-store`). */
export const UNDO_TOAST_TTL_MS = 10_000;

export function useSchedulingControllerWithUndoToast<TBaseline>(input: SchedulingControllerInput<TBaseline>): SchedulingController<TBaseline> {
  const undoToastIdRef = useRef<number | null>(null);
  // Bumped by every dismiss (and so every push): an Undo in flight re-offers its toast only while
  // nothing has dismissed or replaced it since.
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const accessLostRef = useRef(false);
  // The controller is created below with `onCommitted`, which needs the controller's own `runUndo`:
  // it reaches the toast through this ref, refreshed every render.
  const runUndoRef = useRef<((ticket: UndoTicket) => Promise<RunUndoOutcome>) | null>(null);
  const onCommittedRef = useRef(input.onCommitted);
  onCommittedRef.current = input.onCommitted;

  const dismissUndoToast = useCallback(() => {
    // Unconditional: the Undo action nulls the id before `runUndo`, and a dismiss while that Undo
    // is in flight must still fence its re-offer.
    generationRef.current += 1;
    if (undoToastIdRef.current !== null) dismissToast(undoToastIdRef.current);
    undoToastIdRef.current = null;
  }, []);

  const pushUndoToast = useCallback((message: string, tone: ToastTone, ticket: UndoTicket | null) => {
    dismissUndoToast();
    const generation = generationRef.current;
    undoToastIdRef.current = pushToast(message, tone, {
      ttlMs: UNDO_TOAST_TTL_MS,
      announcedElsewhere: true,
      ...(ticket
        ? {
            action: {
              label: "Undo",
              onAction: () => {
                undoToastIdRef.current = null;
                void runUndoRef.current?.(ticket).then((outcome) => {
                  // The viewport already dismissed the toast. "busy" (the post-save refetch has
                  // not settled yet, or another command is open) ran nothing — offer it again
                  // rather than silently dropping the Undo, unless the surface unmounted, reset or
                  // lost access, or a newer toast took its place since (#291).
                  if (outcome.ok || outcome.reason !== "busy") return;
                  if (!mountedRef.current || accessLostRef.current || generationRef.current !== generation || undoToastIdRef.current !== null) return;
                  pushUndoToast(message, tone, ticket);
                });
              },
            },
          }
        : {}),
    });
  }, [dismissUndoToast]);

  const handleCommitted = useCallback((info: SchedulingCommittedInfo) => {
    onCommittedRef.current?.(info);
    if (info.kind === "deadline") {
      pushUndoToast("Deadline saved.", "success", buildDeadlineUndoTicket(info.before, info.deadlineResult.current));
      return;
    }
    // `warningText` is the shared rule's text over the saved schedule (the controller runs
    // `scheduleWindowWarnings` with the port's `boundsFor`, #288) — the exact text its live
    // announcement carries (this toast is `announcedElsewhere`).
    const { warningText } = info;
    pushUndoToast(warningText ? `Schedule saved. ${warningText}` : "Schedule saved.", warningText ? "caution" : "success", buildChecklistUndoTicket(info.before, info.checklistResult));
  }, [pushUndoToast]);

  const commands = useSchedulingController({ ...input, onCommitted: handleCommitted });
  runUndoRef.current = commands.runUndo;
  accessLostRef.current = commands.accessLost;

  // One live Undo: gone on unmount, on every controller reset (the same deps as the controller's
  // own reset in `use-scheduling-commands` — the surface's `resetKey` plus identity, which the
  // Calendar's `calendarResetKey` alone lacks), and on access loss.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dismissUndoToast();
    };
  }, [dismissUndoToast]);
  const { resetKey, identity } = input;
  useEffect(() => {
    dismissUndoToast();
  }, [resetKey, identity.principalId, identity.role, identity.authorizationEpoch, dismissUndoToast]);
  useEffect(() => {
    if (commands.accessLost) dismissUndoToast();
  }, [commands.accessLost, dismissUndoToast]);
  return commands;
}
