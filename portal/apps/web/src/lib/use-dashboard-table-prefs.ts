import { useCallback, useRef, useState } from "react";
import { normalizeTablePrefs, readTablePrefs, writeTablePrefs, type TablePrefs } from "./dashboard-table-model";

type Held = { principalId: string; prefs: TablePrefs };

/**
 * The Dashboard Table's per-viewer Display preferences (#431): Group by and the hidden columns,
 * kept in `localStorage` under `quincy:dashboard:table:<principalId>` (`lib/dashboard-table-model.ts`).
 *
 * An identity switch re-reads for the NEW viewer during the same render, and a setter captured for
 * the previous viewer is inert: it writes nothing, so one viewer's choice can never land under
 * another's key. Reads and writes are best-effort (storage may be unavailable); the in-memory
 * value is what the Table renders either way.
 */
export function useDashboardTablePrefs(principalId: string): { prefs: TablePrefs; update: (patch: Partial<TablePrefs>) => void } {
  const [held, setHeld] = useState<Held>(() => ({ principalId, prefs: readTablePrefs(principalId) }));
  const heldRef = useRef(held);
  let current = held;
  if (held.principalId !== principalId) {
    current = { principalId, prefs: readTablePrefs(principalId) };
    setHeld(current);
  }
  heldRef.current = current;

  const update = useCallback((patch: Partial<TablePrefs>) => {
    const base = heldRef.current;
    if (base.principalId !== principalId) return;
    const prefs = normalizeTablePrefs({ ...base.prefs, ...patch });
    writeTablePrefs(principalId, prefs);
    const next = { principalId, prefs };
    heldRef.current = next;
    setHeld(next);
  }, [principalId]);

  return { prefs: current.prefs, update };
}
