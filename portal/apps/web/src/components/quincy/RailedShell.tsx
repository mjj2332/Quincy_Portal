import { useEffect, useEffectEvent, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

import { Sheet } from "@/components/reui/sheet";
import { locationStore } from "../../lib/router";
import { useMediaQuery } from "../../lib/use-media-query";
import {
  SHELL_NARROW_QUERY,
  isRailShortcut,
  railMode,
  readRailPreference,
  writeRailPreference,
  type RailPreference,
  type RailShortcutTarget,
} from "../../lib/shell-rail";
import type { StaffNavigation } from "../../lib/staff-navigation";
import { NavigationRail } from "./NavigationRail";
import { RailSheet } from "./RailSheet";
import { ShellHeader } from "./ShellHeader";

/**
 * Owns the rail's collapse preference, narrow/wide mode, the Sheet's open state and the ⌘B
 * listener — issue #112. Renders in place of the bare #111 `NavigationRail` when the flag is on.
 *
 * `safeLocalStorage` guards the `window.localStorage` accessor itself, which can throw under some
 * privacy settings before `readRailPreference`/`writeRailPreference`'s own try/catch is reached.
 *
 * `toggleRail` computes the next preference, calls `setPreference`, then writes storage as three
 * separate steps — not inside `setPreference`'s updater, which React 19 `StrictMode` double-
 * invokes and would double-write storage for one toggle. Its `mode === "sheet"` guard is redundant
 * with today's two call sites (the ⌘B listener, the header toggle) but stays as the one-line
 * invariant that keeps a future third caller from reopening the same defect.
 *
 * `sheetOpen` closes on a location change, on `mode` leaving `"sheet"`, and — a #112 review
 * finding — on a click on the link for the route already showing, which publishes the SAME
 * location and so never fires the location-change effect; the rail slot's click handler covers
 * that case directly.
 *
 * One `Sheet` Root (`reui/sheet.tsx`) wraps the rail slot and the content column in every mode —
 * it renders no DOM of its own, so this costs nothing while narrow, and it is what lets
 * `ShellHeader`'s trigger and `RailSheet`'s popup share a Root and use a real `Dialog.Trigger`.
 */

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Privacy settings can make even the `localStorage` accessor itself throw, before either
    // `readRailPreference`/`writeRailPreference`'s own try/catch around a method call is reached.
    return null;
  }
}

export type RailedShellProps = {
  navigation: StaffNavigation;
  user: { name?: string | null; email?: string | null };
  children: ReactNode;
};

export function RailedShell({ navigation, user, children }: RailedShellProps) {
  const [preference, setPreference] = useState<RailPreference>(() => {
    const storage = safeLocalStorage();
    return storage ? readRailPreference(storage) : "expanded";
  });
  const narrow = useMediaQuery(SHELL_NARROW_QUERY);
  const mode = railMode(narrow, preference);

  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => setSheetOpen(false), [location]);
  useEffect(() => {
    if (mode !== "sheet") setSheetOpen(false);
  }, [mode]);

  function toggleRail() {
    if (mode === "sheet") return; // Below 772px the preference is never written — see the header comment.
    const next: RailPreference = preference === "collapsed" ? "expanded" : "collapsed";
    setPreference(next);
    const storage = safeLocalStorage();
    if (storage) writeRailPreference(storage, next);
  }

  // `useEffectEvent` reads `mode`/`toggleRail` fresh on every call without being a reactive
  // dependency itself, so the effect below only needs to resubscribe when the sheet boundary is
  // crossed, not on every preference toggle in between.
  const onRailShortcut = useEffectEvent((event: KeyboardEvent) => {
    // `isRailShortcut` is duck-typed (`lib/router.ts`'s `LinkClick` shape) so a node test can pass
    // a plain object; a real `KeyboardEvent`'s `target` is `EventTarget | null`, which TypeScript's
    // weak-type check rejects passing directly, so the fields are read out explicitly.
    const shortcutEvent = {
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.isComposing,
      defaultPrevented: event.defaultPrevented,
      target: event.target as RailShortcutTarget | null,
    };
    if (!isRailShortcut(shortcutEvent)) return;
    event.preventDefault();
    toggleRail();
  });

  // An effect event is never a reactive value — React guarantees `onRailShortcut` always sees the
  // latest render's `mode`/`toggleRail` without needing to be a dependency, so `isSheetMode` alone
  // decides when to (re)subscribe.
  const isSheetMode = mode === "sheet";
  useEffect(() => {
    if (isSheetMode) return undefined;
    window.addEventListener("keydown", onRailShortcut);
    return () => window.removeEventListener("keydown", onRailShortcut);
  }, [isSheetMode]);

  const contentColumn = (
    <div className="flex min-w-0 flex-1 flex-col" data-rail-mode={mode}>
      <ShellHeader mode={mode} navigation={navigation} onToggleRail={toggleRail} />
      {children}
    </div>
  );

  // `RailSheet` stays mounted in every mode (its popup renders nothing while closed), so a Sheet
  // that is open when the window widens finishes its own close instead of being torn out mid-exit.
  // `className="contents"` so this wrapper costs nothing in `NavigationRail`'s own root sizing —
  // it takes part in neither layout nor the box model, only in the click's bubble path.
  function closeSheetOnLinkClick(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("a[href]")) setSheetOpen(false);
  }

  const railSlot = (
    <>
      <RailSheet>
        <div className="contents" onClick={closeSheetOnLinkClick}>
          <NavigationRail navigation={navigation} user={user} variant="sheet" showBell={false} />
        </div>
      </RailSheet>
      {mode !== "sheet" && <NavigationRail navigation={navigation} user={user} variant={mode} />}
    </>
  );

  return (
    <Sheet open={mode === "sheet" && sheetOpen} onOpenChange={setSheetOpen}>
      {railSlot}
      {contentColumn}
    </Sheet>
  );
}
