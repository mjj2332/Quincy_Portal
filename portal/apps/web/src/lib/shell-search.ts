/**
 * The rail's search shortcut predicate — #217. Everything else this module used to carry (the
 * one-shot latched focus request `requestProjectSearchFocus`/`subscribeProjectSearchFocus`/
 * `getProjectSearchFocusToken`/`consumeProjectSearchFocus`, and `activateProjectSearch`) is
 * deleted: the rail now owns a real search input (`quincy/ShellSearch.tsx`, backed by
 * `lib/dashboard-search-store.ts`), so there is nothing left to latch a request for. ⌘K now
 * focuses that input directly via a ref, rather than navigating and waiting for the Dashboard to
 * mount and consume a pending request.
 */
import { isShellShortcut, type RailShortcutEvent } from "./shell-rail";

/** ⌘K (Meta+K) or Ctrl+K, the search shortcut — `isRailShortcut`'s own predicate, keyed on K. */
export function isSearchShortcut(event: RailShortcutEvent): boolean {
  return isShellShortcut(event, "k");
}
