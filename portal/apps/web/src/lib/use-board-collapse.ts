import { useCallback, useRef, useState } from "react";
import type { StageKey } from "@quincy/shared";
import { browserBoardCollapseStorage, readCollapsedStages, writeCollapsedStages, type BoardCollapseStorage } from "./board-collapse-store";

type Held = { principalId: string; collapsed: readonly StageKey[] };

/**
 * The Board's collapsed Stage columns, per viewer (#432). Same shape as `useDashboardTablePrefs`: an
 * identity switch re-reads for the NEW viewer during the same render (no flash of the previous
 * viewer's collapse), and a toggle captured for the previous viewer is inert, so one viewer's choice
 * can never land under another's key.
 */
export function useBoardCollapse(principalId: string, storage: BoardCollapseStorage = browserBoardCollapseStorage) {
  const [held, setHeld] = useState<Held>(() => ({ principalId, collapsed: readCollapsedStages(principalId, storage) }));
  const heldRef = useRef(held);
  let current = held;
  if (held.principalId !== principalId) {
    current = { principalId, collapsed: readCollapsedStages(principalId, storage) };
    setHeld(current);
  }
  heldRef.current = current;

  const toggle = useCallback((stageKey: StageKey) => {
    const base = heldRef.current;
    if (base.principalId !== principalId) return;
    const collapsed = base.collapsed.includes(stageKey) ? base.collapsed.filter((key) => key !== stageKey) : [...base.collapsed, stageKey];
    writeCollapsedStages(principalId, collapsed, storage);
    const next = { principalId, collapsed };
    heldRef.current = next;
    setHeld(next);
  }, [principalId, storage]);

  return { collapsedStageKeys: current.collapsed, toggleStageCollapsed: toggle };
}
