import { STAGE_KEYS, type StageKey } from "@quincy/shared";

/**
 * Which Stage columns a viewer has collapsed to a rail on the Dashboard Board (#432): a per-viewer
 * convenience, kept in `localStorage` under `quincy:dashboard:board:collapsed:<principalId>` as a JSON
 * array of CANONICAL Stage keys (never a presentation spelling, so an Editor's `editing` and an
 * Admin's `editing_autohdr` are the same entry). Storage is injected, in the shape
 * `initializeKanbanSortMode` takes, so this module stays pure.
 *
 * Reads are forgiving: anything that is not a JSON array of known keys reads as "all expanded". Writes
 * are best-effort: storage may be unavailable, and the in-memory choice stands either way.
 */
export type BoardCollapseStorage = {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
};

const KNOWN = new Set<string>(STAGE_KEYS);

export function boardCollapseKey(principalId: string): string {
  return `quincy:dashboard:board:collapsed:${principalId}`;
}

/** Keeps known canonical keys only, de-duplicated, in the canonical Stage order. */
export function normalizeCollapsedStages(value: unknown): StageKey[] {
  if (!Array.isArray(value)) return [];
  const present = new Set(value.filter((item): item is string => typeof item === "string" && KNOWN.has(item)));
  return STAGE_KEYS.filter((key) => present.has(key));
}

export function readCollapsedStages(principalId: string, storage: BoardCollapseStorage): StageKey[] {
  try {
    const stored = storage.read(boardCollapseKey(principalId));
    return stored === null ? [] : normalizeCollapsedStages(JSON.parse(stored));
  } catch {
    return [];
  }
}

export function writeCollapsedStages(principalId: string, keys: readonly StageKey[], storage: BoardCollapseStorage): void {
  try {
    storage.write(boardCollapseKey(principalId), JSON.stringify(normalizeCollapsedStages(keys)));
  } catch {
    // A per-viewer convenience; losing it is harmless.
  }
}

/** The browser's storage, behind the same try/catch: the accessor itself can throw (blocked site data). */
export const browserBoardCollapseStorage: BoardCollapseStorage = {
  read: (key) => window.localStorage.getItem(key),
  write: (key, value) => window.localStorage.setItem(key, value),
};
