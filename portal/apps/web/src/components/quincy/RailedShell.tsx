import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";

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
  type RailShortcutTarget,
} from "../../lib/shell-rail";
import { activateProjectSearch, isSearchShortcut } from "../../lib/shell-search";
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
 *
 * `handleSearch` (#122 P3) is the one activation path for both the rail's own search control and
 * the ⌘K window listener below it: navigate to the Dashboard when elsewhere, then latch
 * `lib/shell-search.ts`'s focus request. The ⌘K effect installs nothing while `mode === "sheet"` —
 * the same inertness `isRailShortcut`'s own effect gives ⌘B while narrow (`reui/sidebar.tsx`
 * patch 3) — and closes the Sheet first when it fires from inside one, via
 * `suppressSheetFinalFocusRef`: without it, the Sheet's own close-restores-focus-to-trigger
 * behaviour would steal focus back from the Dashboard input a moment after `RailSheet`'s
 * `finalFocus` lets this component suppress it for exactly that one close.
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

  // The model's own Dashboard item, not a hard-coded "/" — falls back to it only if the model ever
  // omitted the item entirely (it never does today; every capability set includes Dashboard).
  const dashboardHref = navigation.groups.flatMap((group) => group.items).find((item) => item.id === "dashboard")?.href ?? "/";

  // Set for exactly one Sheet close: a ⌘K/search-control tap inside the Sheet closes it before
  // navigating, and the Sheet's own `finalFocus` (below) reads and clears this to skip restoring
  // focus to the (about to vanish) sheet trigger for that one close only — Escape and an ordinary
  // link click keep the default restoration.
  const suppressSheetFinalFocusRef = useRef(false);

  function handleSearch() {
    if (mode === "sheet") {
      suppressSheetFinalFocusRef.current = true;
      setSheetOpen(false);
    }
    activateProjectSearch(dashboardHref);
  }

  // ⌘K, mirroring `reui/sidebar.tsx`'s own ⌘B effect (patch 3) — inert while `mode === "sheet"`,
  // where there is no Dashboard search control to focus behind the Sheet in the first place.
  useEffect(() => {
    if (mode === "sheet") return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (
        !isSearchShortcut({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          defaultPrevented: event.defaultPrevented,
          target: event.target as RailShortcutTarget | null,
        })
      ) {
        return;
      }
      event.preventDefault();
      handleSearch();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, dashboardHref]);

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

  // `FloatingFocusManager`'s return-focus cleanup — the thing that actually reads `finalFocus` —
  // only runs once the popup finishes unmounting after its exit transition. Reopening the Sheet
  // before that transition completes would otherwise leave `suppressSheetFinalFocusRef` latched
  // `true` from a previous search-triggered close, so the NEXT Escape/link close would also skip
  // focus restoration. Clearing it on every open, not only inside `finalFocus` itself, is what
  // keeps the suppression scoped to the one close it was set for.
  function handleSheetOpenChange(open: boolean) {
    if (open) suppressSheetFinalFocusRef.current = false;
    setSheetOpen(open);
  }

  const railSlot = (
    <>
      <RailSheet
        // `false` suppresses restore for exactly the one close `handleSearch` set the ref for;
        // every other close must resolve to `true`, not `undefined` — floating-ui-react's own
        // `getReturnElement` (`FloatingFocusManager.mjs`) treats an `undefined` return from this
        // callback identically to `false` (both hit its early `return null`), so `undefined` here
        // would silently disable Escape/link-close focus restoration for every close, not just the
        // suppressed one.
        finalFocus={() => {
          const suppress = suppressSheetFinalFocusRef.current;
          suppressSheetFinalFocusRef.current = false;
          return suppress ? false : true;
        }}
      >
        <div className="contents" onClick={closeSheetOnLinkClick}>
          <NavigationRail navigation={navigation} user={user} variant="sheet" showBell={false} onSearch={handleSearch} />
        </div>
      </RailSheet>
      {mode !== "sheet" && <NavigationRail navigation={navigation} user={user} variant={mode} onSearch={handleSearch} />}
    </>
  );

  return (
    <SidebarProvider
      open={mode !== "sheet" && preference === "expanded"}
      onOpenChange={handleOpenChange}
      className="app__shell min-w-0"
      style={{ "--quincy-rail-width": "260px" } as CSSProperties}
    >
      <Sheet open={mode === "sheet" && sheetOpen} onOpenChange={handleSheetOpenChange}>
        {railSlot}
        {contentColumn}
      </Sheet>
    </SidebarProvider>
  );
}
