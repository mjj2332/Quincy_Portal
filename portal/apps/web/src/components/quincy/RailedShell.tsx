import { useEffect, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { Sheet } from "@/components/reui/sheet";
import { SidebarProvider } from "@/components/reui/sidebar";
import { cn } from "../../lib/utils";
import { locationStore } from "../../lib/router";
import { useMediaQuery } from "../../lib/use-media-query";
import {
  SHELL_NARROW_QUERY,
  railMode,
  readRailPreference,
  writeRailPreference,
  type RailPreference,
} from "../../lib/shell-rail";
import type { StaffNavigation } from "../../lib/staff-navigation";
import { NavigationRail } from "./NavigationRail";
import { RailSheet } from "./RailSheet";
import { ShellHeader } from "./ShellHeader";

/**
 * Owns the rail's collapse preference, narrow/wide mode and the Sheet's open state — issue #112,
 * re-platformed onto base-nova's `SidebarProvider` in #122 (ADR 0005).
 *
 * `SidebarProvider` now owns the ⌘B listener itself (`reui/sidebar.tsx`'s patch 3, `isRailShortcut`)
 * — the ⌘B effect #112 built here is DELETED, not duplicated. This component instead controls the
 * provider (`open`/`onOpenChange`) and is what persists the resulting preference to `localStorage`.
 *
 * `safeLocalStorage` guards the `window.localStorage` accessor itself, which can throw under some
 * privacy settings before `readRailPreference`/`writeRailPreference`'s own try/catch is reached.
 *
 * `sheetOpen` closes on a location change, on `mode` leaving `"sheet"`, and — a #112 review
 * finding — on a click on the link for the route already showing, which publishes the SAME
 * location and so never fires the location-change effect; the rail slot's click handler covers
 * that case directly.
 *
 * One `Sheet` Root (`reui/sheet.tsx`) wraps the rail slot and the content column in every mode —
 * it renders no DOM of its own, so this costs nothing while narrow, and it is what lets
 * `ShellHeader`'s trigger and `RailSheet`'s popup share a Root and use a real `Dialog.Trigger`.
 *
 * `SidebarProvider` wraps that `Sheet` Root in turn. Its own `data-slot="sidebar-wrapper"` div is
 * `.app--railed`'s ONE in-flow child now (`styles/app.css`) — the Sheet root and `RailSheet`'s
 * popup render no in-flow DOM of their own — so `className="min-w-0"` here is what stops a wide
 * table inside a page from pushing it past the viewport, the job
 * `.app--railed > :not(.app__rail) { min-width: 0 }` used to do before the rail owned its own
 * fixed/full-height positioning (#122). `app__shell` is the Sol-review fix for the wrapper's own
 * `min-h-svh`: `.app--impersonating`'s `padding-top: 42px` adds to that minimum rather than sharing
 * it, so a short impersonated page renders 42px taller than the viewport — `.app--impersonating
 * .app__shell { min-height: calc(100svh - 42px) }` (`styles/app.css`, unlayered, beside the
 * `.app__rail` rule) claws it back. The content column carries its own `min-w-0 flex-1`
 * directly, for the same reason: it is the provider wrapper's flex child now, not
 * `.app--railed`'s.
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

  // `SidebarProvider`'s own `toggleSidebar` (⌘B, or the rail's `SidebarTrigger`) calls this with
  // the next open value — persistence is this component's job, not the vendored primitive's
  // (`reui/sidebar.tsx`'s patch 1: no cookie, ever).
  function handleOpenChange(open: boolean) {
    const next: RailPreference = open ? "expanded" : "collapsed";
    setPreference(next);
    const storage = safeLocalStorage();
    if (storage) writeRailPreference(storage, next);
  }

  const contentColumn = (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col",
        "peer-data-[variant=inset]:m-[var(--space-2)] peer-data-[variant=inset]:ml-0",
        "peer-data-[variant=inset]:rounded-[var(--radius-card)]",
        "peer-data-[variant=inset]:bg-[color:var(--bg-surface)] peer-data-[variant=inset]:shadow-[var(--shadow-sm)]",
        "peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-[var(--space-2)]",
      )}
      data-rail-mode={mode}
    >
      <ShellHeader mode={mode} navigation={navigation} />
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
    <SidebarProvider
      open={mode !== "sheet" && preference === "expanded"}
      onOpenChange={handleOpenChange}
      className="app__shell min-w-0"
      style={{ "--quincy-rail-width": "260px" } as CSSProperties}
    >
      <Sheet open={mode === "sheet" && sheetOpen} onOpenChange={setSheetOpen}>
        {railSlot}
        {contentColumn}
      </Sheet>
    </SidebarProvider>
  );
}
