/**
 * The Dashboard's location lens (#366).
 *
 * The Project sheet floats over a LIVE Dashboard: at `/projects/:id` the Dashboard stays mounted
 * underneath, showing the view the sheet was opened from. But `Dashboard` parses the raw URL and
 * reconciles it — at a Project URL its effects would fall back to a default view, canonicalise the
 * Calendar, and rewrite the search, each overwriting the Project URL and closing the sheet. So the
 * Dashboard reads and writes through a `DashboardLocationSource` instead of `locationStore()`:
 *
 * - The default source (no provider — every standalone Dashboard test) is the live store, unchanged.
 * - Inside the dashboard layer, `createDashboardBackdropSource` reports the REMEMBERED Dashboard
 *   location while a sheet is the real location, and keeps the Dashboard's own Dashboard-shaped
 *   writes in memory (they must not reach the URL, which belongs to the sheet). Anything else — the
 *   Dashboard opening a project — still goes to the adapter for real.
 */
import { createContext, use } from "react";
import { locationStore, isSheetLocation, parseStaffLocation, readSheetEntryState } from "./router";

export type DashboardLocationSource = {
  getLocation(): string;
  subscribe(listener: () => void): () => void;
  push(location: string): void;
  replace(location: string): void;
  /** True while a sheet is the real location, i.e. this Dashboard is a backdrop. */
  isBackdrop(): boolean;
};

export type DashboardBackdropSource = DashboardLocationSource & {
  /** The Dashboard location the sheet floats over (what closing returns to). */
  backdrop(): string;
  /** True once the Dashboard rewrote its own location in memory while backdrop. */
  backdropRewritten(): boolean;
  resetRewritten(): void;
};

type AdapterLike = Pick<ReturnType<typeof locationStore>, "getLocation" | "subscribe" | "push" | "replace">;

export const DashboardLocationContext = createContext<DashboardLocationSource | null>(null);

let liveSource: DashboardLocationSource | null = null;
function liveDashboardSource(): DashboardLocationSource {
  if (!liveSource) {
    const adapter = locationStore();
    liveSource = {
      // Delegating, not captured: a test (or anything else) that spies on the store's methods after
      // this object exists must still be the thing the Dashboard calls.
      getLocation: () => adapter.getLocation(),
      subscribe: (listener) => adapter.subscribe(listener),
      push: (location) => adapter.push(location),
      replace: (location) => adapter.replace(location),
      isBackdrop: () => false,
    };
  }
  return liveSource;
}

export function useDashboardLocationSource(): DashboardLocationSource {
  return use(DashboardLocationContext) ?? liveDashboardSource();
}

const isDashboardLocation = (location: string) => parseStaffLocation(location).kind === "dashboard";

export function createDashboardBackdropSource(adapter: AdapterLike, readState: () => unknown): DashboardBackdropSource {
  const listeners = new Set<() => void>();
  const stateBackdrop = () => readSheetEntryState(readState())?.backdrop ?? null;

  const initial = adapter.getLocation();
  let seenStateBackdrop: string | null = null;
  let remembered = "/";
  if (isDashboardLocation(initial)) remembered = initial;
  else if (isSheetLocation(initial)) {
    seenStateBackdrop = stateBackdrop();
    remembered = seenStateBackdrop ?? "/";
  }
  let rewritten = false;
  const emit = () => listeners.forEach((listener) => listener());

  // Runs on every adapter notification. `getLocation` stays a pure read (it is a
  // `useSyncExternalStore` snapshot); all remembering happens here.
  const onAdapterChange = () => {
    const location = adapter.getLocation();
    if (isDashboardLocation(location)) {
      remembered = location;
      seenStateBackdrop = null;
      rewritten = false;
    } else if (isSheetLocation(location)) {
      // Landing on a sheet entry (a push from a view, or Back/Forward into one, e.g. from /admin):
      // adopt that entry's own backdrop — but only when it is a different entry's state than the
      // one already seen, so a same-entry write (the Workspace's tab `replace`) cannot clobber an
      // in-memory rewrite.
      const next = stateBackdrop();
      if (next !== null && next !== seenStateBackdrop) {
        remembered = next;
        rewritten = false;
      }
      seenStateBackdrop = next;
    }
    emit();
  };
  let unsubscribeAdapter: (() => void) | null = null;

  const isBackdrop = () => isSheetLocation(adapter.getLocation());

  function write(kind: "push" | "replace", location: string) {
    if (isBackdrop() && isDashboardLocation(location)) {
      remembered = location;
      rewritten = true;
      emit();
      return;
    }
    adapter[kind](location);
  }

  return {
    getLocation: () => (isBackdrop() ? remembered : adapter.getLocation()),
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) unsubscribeAdapter = adapter.subscribe(onAdapterChange);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { unsubscribeAdapter?.(); unsubscribeAdapter = null; }
      };
    },
    push: (location) => write("push", location),
    replace: (location) => write("replace", location),
    isBackdrop,
    backdrop: () => remembered,
    backdropRewritten: () => rewritten,
    resetRewritten: () => { rewritten = false; },
  };
}
