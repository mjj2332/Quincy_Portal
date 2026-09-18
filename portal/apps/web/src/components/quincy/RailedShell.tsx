import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { Sheet } from "@/components/reui/sheet";
import { SidebarProvider } from "@/components/reui/sidebar";
import { cn } from "../../lib/utils";
import { locationStore, parseStaffLocation } from "../../lib/router";
import { useMediaQuery } from "../../lib/use-media-query";
import {
  SHELL_NARROW_QUERY,
  railMode,
  readRailPreference,
  writeRailPreference,
  type RailPreference,
  type RailShortcutTarget,
} from "../../lib/shell-rail";
import { isSearchShortcut } from "../../lib/shell-search";
import type { StaffNavigation } from "../../lib/staff-navigation";
import { NavigationRail } from "./NavigationRail";
import type { ShellSearchHandle } from "./ShellSearch";
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
 * The ⌘K window listener (#217, replacing #122 P3's `activateProjectSearch`) focuses
 * `NavigationRail`'s own `ShellSearch` input through `searchRef` — it never navigates. Unlike ⌘B
 * (`isRailShortcut`'s own effect, inert while narrow — `reui/sidebar.tsx` patch 3), ⌘K stays live
 * in `mode === "sheet"` (#217 fix round 1, item 6): with the Sheet already open, it focuses the
 * Sheet's own `ShellSearch` instance (a second ref, `sheetSearchRef`, since it is a genuinely
 * different mounted component from the wide/collapsed one); with the Sheet closed, it opens the
 * Sheet and focuses that same input once its content actually mounts, via `RailSheet`'s own
 * `initialFocus` (a one-shot pending flag, `pendingSheetSearchFocusRef`, consumed and cleared by
 * `sheetInitialFocus` below) — an imperative `.focus()` call from an ancestor effect is not
 * reliable here: the Sheet's own default open-focus behaviour resolves on its own
 * animation-completion timing and wins that race. `initialFocus` returning `true` for an ORDINARY
 * hamburger-tap open uses the Sheet's own default target — NOT `undefined`, which
 * `@base-ui/react/dialog`'s own `DialogPopup` prop docs spell out as "do nothing" (leave focus on
 * the, now inert, trigger outside the modal), a real #217 fix round 2 regression this file shipped
 * with, not a hypothetical. The old
 * `suppressSheetFinalFocusRef`/custom `finalFocus` dance is gone — the rail no longer has a
 * second, Dashboard-owned input to preserve focus toward, so `RailSheet`'s Sheet closing (on any
 * location change, below) can restore focus to its own trigger the ordinary way.
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

  const isDashboard = parseStaffLocation(location).kind === "dashboard";
  const searchRef = useRef<ShellSearchHandle>(null);
  const sheetSearchRef = useRef<ShellSearchHandle>(null);
  // Set when ⌘K opens the (closed) Sheet itself — consumed by the effect below once `sheetOpen`
  // actually flips, so a ⌘K-triggered open focuses search and an ordinary hamburger-tap open does
  // not.
  const pendingSheetSearchFocusRef = useRef(false);

  // ⌘K. Only focuses; #217 replaces #122 P3's navigate-then-latch with a real input, so typing and
  // Enter are what navigate, not the shortcut itself. Unlike ⌘B, this stays live while
  // `mode === "sheet"` (#217 fix round 1, item 6) — see this file's own docblock.
  useEffect(() => {
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
      if (mode === "sheet") {
        if (sheetOpen) sheetSearchRef.current?.focus();
        else { pendingSheetSearchFocusRef.current = true; setSheetOpen(true); }
        return;
      }
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, sheetOpen]);

  // Base UI's own `initialFocus` mechanism (`RailSheet` -> `SheetContent` -> `Dialog.Popup`),
  // called once per open — one-shot, not a `useEffect`. Per `@base-ui/react/dialog`'s own
  // `DialogPopup` prop docs (confirmed against the installed package, not assumed): a `function`
  // return of an `HTMLElement` focuses it; `true` (or `null`) uses/falls back to the Popup's
  // default behaviour; `false`/`undefined` mean "do nothing" — i.e. LEAVE focus where it was,
  // outside the modal, on the (now inert) trigger (#217 fix round 2, item 2: the original
  // `undefined` return for an ordinary hamburger-tap open was exactly this bug, not a no-op).
  // An ORDINARY open (the pending flag never set) returns `true` for the Popup's own default
  // target; a ⌘K-triggered open returns the search input, falling back to `true` rather than
  // `undefined` in the unexpected case that element isn't available yet either.
  function sheetInitialFocus(): true | HTMLElement {
    if (!pendingSheetSearchFocusRef.current) return true;
    pendingSheetSearchFocusRef.current = false;
    return sheetSearchRef.current?.getElement() ?? true;
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

  function handleSheetOpenChange(open: boolean) {
    setSheetOpen(open);
  }

  const railSlot = (
    <>
      <RailSheet initialFocus={sheetInitialFocus}>
        <div className="contents" onClick={closeSheetOnLinkClick}>
          <NavigationRail navigation={navigation} user={user} variant="sheet" showBell={false} isDashboard={isDashboard} searchRef={sheetSearchRef} />
        </div>
      </RailSheet>
      {mode !== "sheet" && <NavigationRail navigation={navigation} user={user} variant={mode} isDashboard={isDashboard} searchRef={searchRef} />}
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
