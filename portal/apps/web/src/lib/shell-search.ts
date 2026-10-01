/**
 * The search shortcut predicate — #217, kept by #427. The search input itself lives in the
 * Dashboard toolbar (`quincy/DashboardSearch.tsx`); ⌘K asks `ShellRoute` (`lib/app-router.tsx`) to
 * focus it, navigating to the Dashboard first when pressed elsewhere.
 */
import { isShellShortcut, type RailShortcutEvent } from "./shell-rail";

/** ⌘K (Meta+K) or Ctrl+K, the search shortcut — the shell's shared predicate, keyed on K. */
export function isSearchShortcut(event: RailShortcutEvent): boolean {
  return isShellShortcut(event, "k");
}
